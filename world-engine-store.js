// world-engine-store.js — 存储中间层
// 把世界引擎的所有存档从狭小的 localStorage（约 5MB，与酒馆共用）迁移到 IndexedDB（容量大几十倍）。
// 对上层暴露与 localStorage 相同的同步读写接口：启动时把 IndexedDB 数据灌入内存镜像，
// 读直接走镜像（同步），写同步更新镜像并异步刷入 IndexedDB。IndexedDB 不可用时自动回退 localStorage。
window.WORLD_ENGINE_STORE = (function() {
  const DB_NAME = 'world_engine';
  const STORE_NAME = 'kv';
  const PREFIX = 'world_engine_';
  const SETTINGS_KEYS = new Set(['world_engine_settings', 'memory_engine_settings']);
  const EXTENSION_SETTINGS_KEY = 'world_engine';
  const SHARED_SETTING_KEYS = new Set([
    'apiUrl', 'apiKey', 'model', 'connectionMode', 'temperature',
    'maxTokens', 'apiTimeoutMs', 'apiAutoRetries'
  ]);
  const API_PRESET_FIELDS = new Set([...SHARED_SETTING_KEYS]);
  const DEFAULT_API_PRESET = 'default';

  let db = null;
  let ready = false;
  const mirror = new Map(); // key -> string value（内存镜像，支持同步读）

  // 写入回调（同步槽）：每次 setItem/removeItem 后通知订阅者。
  // 酒馆缓存模块（world-engine-chatcache.js）借此把按聊天隔离的存档镜像进 chat_metadata，
  // 实现跨设备同步；其他模块无需改动。hydrate() 直接写 mirror，不经过这里，故灌入镜像时不会回弹。
  let syncSink = null;

  function extensionSettingsObject() {
    try {
      if (window.extension_settings && typeof window.extension_settings === 'object') return window.extension_settings;
      if (window.extensionSettings && typeof window.extensionSettings === 'object') return window.extensionSettings;
      // 部分酒馆版本通过 ES module 导出全局词法变量，而不是 window 属性。
      if (typeof extension_settings !== 'undefined' && extension_settings && typeof extension_settings === 'object') return extension_settings;
      if (typeof extensionSettings !== 'undefined' && extensionSettings && typeof extensionSettings === 'object') return extensionSettings;
      const ctx = typeof SillyTavern !== 'undefined' && SillyTavern.getContext ? SillyTavern.getContext() : null;
      if (ctx?.extensionSettings && typeof ctx.extensionSettings === 'object') return ctx.extensionSettings;
      if (ctx?.extension_settings && typeof ctx.extension_settings === 'object') return ctx.extension_settings;
    } catch (_) {}
    return null;
  }

  function saveExtensionSettings() {
    try {
      if (typeof window.saveSettingsDebounced === 'function') { window.saveSettingsDebounced(); return; }
      if (typeof saveSettingsDebounced === 'function') { saveSettingsDebounced(); return; }
      const ctx = typeof SillyTavern !== 'undefined' && SillyTavern.getContext ? SillyTavern.getContext() : null;
      if (typeof ctx?.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    } catch (_) {}
  }

  function splitSettings(value) {
    const shared = {}, scoped = {};
    for (const [key, item] of Object.entries(value || {})) {
      if (SHARED_SETTING_KEYS.has(key)) shared[key] = item;
      else scoped[key] = item;
    }
    return { shared, scoped };
  }

  function normalizePresetName(value) {
    return String(value == null ? '' : value).trim().slice(0, 80);
  }

  function normalizePresets(value, fallbackShared) {
    const presets = {};
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [rawName, rawPreset] of Object.entries(value)) {
        const name = normalizePresetName(rawName);
        if (!name || !rawPreset || typeof rawPreset !== 'object' || Array.isArray(rawPreset)) continue;
        const preset = {};
        for (const key of API_PRESET_FIELDS) if (rawPreset[key] !== undefined) preset[key] = rawPreset[key];
        presets[name] = preset;
      }
    }
    if (!Object.keys(presets).length) {
      const fallback = {};
      for (const key of API_PRESET_FIELDS) if (fallbackShared?.[key] !== undefined) fallback[key] = fallbackShared[key];
      presets[DEFAULT_API_PRESET] = fallback;
    }
    return presets;
  }

  function readExtensionConfig() {
    const all = extensionSettingsObject(), value = all?.[EXTENSION_SETTINGS_KEY];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (value.shared || value.world || value.memory) {
      const world = splitSettings(value.world);
      const memory = splitSettings(value.memory);
      const shared = { ...world.shared, ...memory.shared, ...(value.shared || {}) };
      const apiPresets = normalizePresets(value.apiPresets, shared);
      return {
        version: 3,
        shared: {},
        apiPresets,
        world: world.scoped,
        memory: memory.scoped
      };
    }
    // 兼容开发期曾写入的平铺结构：作为 shared + 两侧初始值读取。
    const flat = splitSettings(value);
    return { version: 3, shared: {}, apiPresets: normalizePresets(null, flat.shared), world: { ...flat.scoped }, memory: { ...flat.scoped } };
  }

  function writeExtensionConfig(next) {
    const all = extensionSettingsObject();
    if (!all) return false;
    all[EXTENSION_SETTINGS_KEY] = { ...(next || {}) };
    saveExtensionSettings();
    return true;
  }

  function readStoredJson(key) {
    try {
      const raw = mirror.has(key) ? mirror.get(key) : localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) { return {}; }
  }

  function getConfig() {
    const remote = readExtensionConfig();
    if (remote) {
      const stored = extensionSettingsObject()?.[EXTENSION_SETTINGS_KEY];
      if (stored?.version !== 3 || !stored?.apiPresets || Object.keys(stored.shared || {}).length) writeExtensionConfig(remote);
      return remote;
    }
    // 兼容旧版本：首次启动时迁移两个本地设置键。共享 API 以记忆设置优先，
    // 因为多数用户最后修改的是记忆 API 面板；之后两边只保存一份 shared。
    const world = readStoredJson('world_engine_settings');
    const memory = readStoredJson('memory_engine_settings');
    const worldParts = splitSettings(world);
    const memoryParts = splitSettings(memory);
    const shared = {};
    for (const key of SHARED_SETTING_KEYS) {
      if (memoryParts.shared[key] !== undefined) shared[key] = memoryParts.shared[key];
      else if (worldParts.shared[key] !== undefined) shared[key] = worldParts.shared[key];
    }
    const legacy = { version: 3, shared: {}, apiPresets: normalizePresets(null, shared), world: worldParts.scoped, memory: memoryParts.scoped };
    if (Object.keys(world).length || Object.keys(memory).length) writeExtensionConfig(legacy);
    return legacy;
  }

  function settingsFor(scope) {
    const config = getConfig();
    const scoped = config[scope] || {};
    const presets = normalizePresets(config.apiPresets, config.shared);
    const requestedName = normalizePresetName(scoped.apiPreset) || DEFAULT_API_PRESET;
    const selectedName = presets[requestedName]
      ? requestedName
      : (presets[DEFAULT_API_PRESET] ? DEFAULT_API_PRESET : Object.keys(presets)[0]);
    const selected = presets[selectedName] || {};
    return { ...(config.shared || {}), ...selected, ...scoped, apiPreset: selectedName };
  }

  function setScopeConfig(scope, patch) {
    const config = getConfig();
    const shared = { ...(config.shared || {}) };
    const scoped = { ...(config[scope] || {}) };
    const apiPresets = normalizePresets(config.apiPresets, shared);
    const requestedPreset = normalizePresetName(patch?.apiPreset);
    const selectedName = requestedPreset || normalizePresetName(scoped.apiPreset) || DEFAULT_API_PRESET;
    if (!apiPresets[selectedName]) apiPresets[selectedName] = {};
    for (const [key, value] of Object.entries(patch || {})) {
      if (API_PRESET_FIELDS.has(key)) apiPresets[selectedName][key] = value;
      else scoped[key] = value;
    }
    scoped.apiPreset = selectedName;
    const next = { ...config, version: 3, shared, apiPresets, [scope]: scoped };
    if (!writeExtensionConfig(next)) {
      // 非酒馆测试环境或旧版本继续落本地，保证兼容性。
      const key = scope === 'memory' ? 'memory_engine_settings' : 'world_engine_settings';
      const value = JSON.stringify({ ...shared, ...(apiPresets[selectedName] || {}), ...scoped });
      mirror.set(key, value);
      if (db) idbPut(key, value);
      else { try { localStorage.setItem(key, value); } catch (_) {} }
    }
    return settingsFor(scope);
  }

  function getApiPresets() {
    const config = getConfig();
    return JSON.parse(JSON.stringify(normalizePresets(config.apiPresets, config.shared)));
  }

  function saveApiPreset(name, patch, scope) {
    const config = getConfig();
    const presetName = normalizePresetName(name);
    if (!presetName) throw new Error('API 预设名称不能为空');
    const apiPresets = normalizePresets(config.apiPresets, config.shared);
    const current = { ...(apiPresets[presetName] || {}) };
    for (const key of API_PRESET_FIELDS) if (patch?.[key] !== undefined) current[key] = patch[key];
    apiPresets[presetName] = current;
    const next = { ...config, version: 3, apiPresets };
    if (scope === 'world' || scope === 'memory') next[scope] = { ...(next[scope] || {}), apiPreset: presetName };
    writeExtensionConfig(next);
    return settingsFor(scope || 'world');
  }

  function selectApiPreset(scope, name) {
    if (scope !== 'world' && scope !== 'memory') return null;
    return setScopeConfig(scope, { apiPreset: normalizePresetName(name) || DEFAULT_API_PRESET });
  }

  function deleteApiPreset(name) {
    const presetName = normalizePresetName(name);
    const config = getConfig();
    const apiPresets = normalizePresets(config.apiPresets, config.shared);
    if (!presetName || !apiPresets[presetName] || Object.keys(apiPresets).length <= 1) return false;
    delete apiPresets[presetName];
    const fallbackName = apiPresets[DEFAULT_API_PRESET] ? DEFAULT_API_PRESET : Object.keys(apiPresets)[0];
    const next = { ...config, version: 3, apiPresets };
    for (const scope of ['world', 'memory']) {
      if (normalizePresetName(next[scope]?.apiPreset) === presetName) next[scope] = { ...(next[scope] || {}), apiPreset: fallbackName };
    }
    writeExtensionConfig(next);
    return true;
  }
  function setSyncSink(sink) { syncSink = sink; }
  function notifySink(method, key, value) {
    if (!syncSink || typeof syncSink[method] !== 'function') return;
    try { syncSink[method](key, value); } catch (e) { /* 同步失败不得影响本地写入 */ }
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, 1);
      } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE_NAME)) d.createObjectStore(STORE_NAME);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbGetAll() {
    return new Promise((resolve, reject) => {
      const out = [];
      const cur = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) { out.push([c.key, c.value]); c.continue(); }
        else resolve(out);
      };
      cur.onerror = () => reject(cur.error);
    });
  }

  function idbPut(key, value) {
    if (!db) return;
    try { db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(value, key); }
    catch (e) { console.warn('[世界引擎] IndexedDB 写入失败', e); }
  }

  function idbDel(key) {
    if (!db) return;
    try { db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(key); }
    catch (e) {}
  }

  // 启动时调用一次：打开 IndexedDB、灌入镜像、迁移并清理 localStorage 中的旧存档
  async function hydrate() {
    if (ready) return;
    try {
      db = await openDB();
      for (const [k, v] of await idbGetAll()) mirror.set(k, v);
    } catch (e) {
      console.warn('[世界引擎] IndexedDB 不可用，回退到 localStorage', e);
      db = null;
    }
    // 把 localStorage 里遗留的 world_engine_* 搬进 IndexedDB，并腾出 localStorage 空间
    try {
      const legacyKeys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(PREFIX)) legacyKeys.push(k);
      }
      for (const k of legacyKeys) {
        const v = localStorage.getItem(k);
        if (v == null) continue;
        if (!mirror.has(k)) { mirror.set(k, v); idbPut(k, v); }
        if (db) localStorage.removeItem(k); // 仅在 IDB 可用（已落盘）时才删，避免丢数据
      }
      if (db && legacyKeys.length) {
        console.log(`[世界引擎] 已迁移 ${legacyKeys.length} 条存档至 IndexedDB`);
      }
    } catch (e) { console.warn('[世界引擎] 旧存档迁移失败（非致命）', e); }
    // 设置迁移到酒馆 extension_settings；API Key 也按用户选择随配置保存。
    getConfig();
    ready = true;
  }

  function getItem(key) {
    if (SETTINGS_KEYS.has(key)) {
      const scope = key === 'memory_engine_settings' ? 'memory' : 'world';
      const config = readExtensionConfig();
      if (config) return JSON.stringify(settingsFor(scope));
    }
    if (mirror.has(key)) return mirror.get(key);
    // 镜像未命中（未 hydrate 或 IDB 不可用）时回退到 localStorage
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function setItem(key, value) {
    if (SETTINGS_KEYS.has(key)) {
      try {
        const parsed = JSON.parse(String(value));
        setScopeConfig(key === 'memory_engine_settings' ? 'memory' : 'world', parsed);
        return;
      } catch (_) { /* 非 JSON 设置继续走普通存储 */ }
    }
    value = String(value);
    mirror.set(key, value);
    if (db) idbPut(key, value);
    else localStorage.setItem(key, value); // IDB 不可用时退回 localStorage（可能抛配额错误）
    notifySink('onWrite', key, value);
  }

  function removeItem(key) {
    mirror.delete(key);
    if (db) idbDel(key);
    else { try { localStorage.removeItem(key); } catch (e) {} }
    notifySink('onRemove', key, null);
  }

  // 返回镜像中所有 key（替代 localStorage.length / localStorage.key(i)）
  function keys() {
    if (mirror.size || db) return [...mirror.keys()];
    const out = [];
    for (let i = 0; i < localStorage.length; i++) out.push(localStorage.key(i));
    return out;
  }

  return { hydrate, getItem, setItem, removeItem, keys, setSyncSink, getConfig, settingsFor, setScopeConfig,
    getApiPresets, saveApiPreset, selectApiPreset, deleteApiPreset };
})();
