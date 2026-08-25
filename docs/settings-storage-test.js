// 酒馆 extension_settings 统一配置测试：node docs/settings-storage-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const saved = [];
const local = new Map();
const sandbox = {
  window: null,
  console,
  setTimeout,
  clearTimeout,
  extension_settings: {},
  saveSettingsDebounced() { saved.push(true); },
  localStorage: {
    get length() { return local.size; },
    key(index) { return [...local.keys()][index] || null; },
    getItem(key) { return local.has(key) ? local.get(key) : null; },
    setItem(key, value) { local.set(key, String(value)); },
    removeItem(key) { local.delete(key); }
  },
  indexedDB: {
    open() { throw new Error('test fallback'); }
  }
};
sandbox.window = sandbox;
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '..', 'world-engine-store.js'), 'utf8'), sandbox);

(async () => {
  local.set('world_engine_settings', JSON.stringify({ apiUrl: 'world-url', apiKey: 'world-key', engineEnabled: true, tonePrompt: 'world-tone' }));
  local.set('memory_engine_settings', JSON.stringify({ apiUrl: 'memory-url', apiKey: 'memory-key', engineEnabled: false, tonePrompt: 'memory-tone' }));
  await sandbox.WORLD_ENGINE_STORE.hydrate();

  let config = sandbox.extension_settings.world_engine;
  assert.strictEqual(config.shared.apiUrl, 'memory-url');
  assert.strictEqual(config.shared.apiKey, 'memory-key');
  assert.strictEqual(config.world.engineEnabled, true);
  assert.strictEqual(config.memory.engineEnabled, false);
  assert.strictEqual(config.world.apiUrl, undefined);
  assert.strictEqual(config.memory.apiUrl, undefined);

  sandbox.WORLD_ENGINE_STORE.setItem('world_engine_settings', JSON.stringify({
    apiUrl: 'shared-url', apiKey: 'shared-key', model: 'model-x', engineEnabled: true, tonePrompt: 'world-next'
  }));
  sandbox.WORLD_ENGINE_STORE.setItem('memory_engine_settings', JSON.stringify({
    apiUrl: 'shared-url-2', apiKey: 'shared-key-2', model: 'model-y', engineEnabled: false, tonePrompt: 'memory-next'
  }));

  const world = JSON.parse(sandbox.WORLD_ENGINE_STORE.getItem('world_engine_settings'));
  const memory = JSON.parse(sandbox.WORLD_ENGINE_STORE.getItem('memory_engine_settings'));
  assert.strictEqual(world.apiUrl, 'shared-url-2');
  assert.strictEqual(memory.apiUrl, 'shared-url-2');
  assert.strictEqual(world.apiKey, 'shared-key-2');
  assert.strictEqual(world.engineEnabled, true);
  assert.strictEqual(memory.engineEnabled, false);
  assert.strictEqual(world.tonePrompt, 'world-next');
  assert.strictEqual(memory.tonePrompt, 'memory-next');
  assert.strictEqual(sandbox.WORLD_ENGINE_STORE.settingsFor('world').apiUrl, 'shared-url-2');
  assert.strictEqual(config.world.apiKey, undefined);
  assert.ok(saved.length >= 2);
  console.log('settings storage tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
