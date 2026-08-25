// 删除楼层清理测试：node docs/memory-deleted-layer-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const stored = new Map();
const calls = [];
const chat = [
  { is_user: false, name: '角色', mes: '开场白', extra: { world_engine_memory_source_id: 'opening' } },
  { is_user: true, name: '用户', mes: '进入峡谷。', extra: { world_engine_memory_source_id: 'floor-1' } },
  { is_user: false, name: '角色', mes: '已删除的错误战报。', extra: { world_engine_memory_source_id: 'floor-2' } },
  { is_user: true, name: '用户', mes: '清点战果。', extra: { world_engine_memory_source_id: 'floor-3' } },
  { is_user: false, name: '角色', mes: '缴获战马。', extra: { world_engine_memory_source_id: 'floor-4' } }
];
const sandbox = {
  window: null,
  console,
  setTimeout,
  clearTimeout,
  AbortController,
  document: { getElementById() { return null; } },
  SillyTavern: { getContext() { return { chat, name1: '用户', name2: '角色', setExtensionPrompt() {} }; } },
  WORLD_ENGINE_STORE: {
    getItem(key) { return stored.has(key) ? stored.get(key) : null; },
    setItem(key, value) { stored.set(key, String(value)); },
    removeItem(key) { stored.delete(key); }
  },
  WORLD_ENGINE_CORE: {
    getChatId() { return 'deleted-layer-test'; },
    getChatLayer() { return chat.length - 1; },
    filterDialogue(value) { return value; }
  },
  WORLD_ENGINE_WORLDBOOK: { async buildPromptSection() { return ''; } },
  WORLD_ENGINE_CHATCACHE: { forScope() { return { afterEvolution() {}, createSnapshot() {} }; } },
  WORLD_ENGINE_UI: { setMemoryEvolvingUI() {}, refresh() {} },
  MEMORY_ENGINE_SETTINGS: {
    getSettings() {
      return {
        engineEnabled: true,
        firstLayerIsAiOpening: true,
        hideCoveredRawText: false,
        injectIntoPrompt: false,
        maxTokens: 2000,
        temperature: 0.2,
        apiAutoRetries: 0,
        referenceRawRounds: 0,
        referenceSmallSummaryCount: 0,
        referenceBigSummaryCount: 0
      };
    }
  },
  WORLD_ENGINE_API: {
    async callApi(prompt) { calls.push(prompt); return JSON.stringify({}); }
  }
};
sandbox.window = sandbox;

for (const filename of [
  'memory-engine-data.js',
  'memory-engine-timeline.js',
  'memory-engine-prompt.js',
  'memory-engine-small-summary-prompt.js',
  'memory-engine-big-summary-prompt.js',
  'memory-engine.js'
]) vm.runInNewContext(fs.readFileSync(path.join(root, filename), 'utf8'), sandbox, { filename });

(async () => {
  const sourceRefs = sandbox.MEMORY_ENGINE_TIMELINE.captureRange(1, 3);
  const state = sandbox.MEMORY_ENGINE_DATA.defaultState();
  state.timeline = {
    version: 1,
    originChatId: 'deleted-layer-test',
    root: { id: 'root:deleted-layer-test', originChatId: 'deleted-layer-test', createdAt: Date.now(), base: {
      personal_memory: [], knowledge_index: {}, entity_memory: { organization: [], object: [], ability: [], location: [] },
      entity_index: {}, round: 0, chatLayer: null
    } },
    nodes: [{
      id: 'memory_000001', kind: 'memory', startLayer: 1, endLayer: 3,
      sourceRefs, sourceDigest: 'old',
      personal: [{ names: ['只存在于已删除楼层的角色'], memory: { '': ['不应继续存在'] } }], entities: {},
      status: 'valid', revision: 1
    }, {
      id: 'memory_000002', kind: 'memory', startLayer: 3, endLayer: 4,
      sourceRefs: sandbox.MEMORY_ENGINE_TIMELINE.captureRange(3, 4), sourceDigest: 'later',
      personal: [{ names: ['删除楼层之后提取的人物'], memory: { '': ['需要重新补提取'] } }], entities: {},
      status: 'valid', revision: 1
    }]
  };
  state.event_memory.small_summaries = [{
    id: 'small_000001', startLayer: 1, endLayer: 3,
    sourceRefs, sourceDigest: 'old',
    content: '包含已删除楼层的纪要', status: 'valid', revision: 1
  }];
  state.event_memory.big_summaries = [{
    id: 'big_000001', startLayer: 1, endLayer: 3, childIds: ['small_000001'],
    content: '包含已删除楼层的总述', childDigest: 'old', status: 'valid', revision: 1
  }];
  state.event_memory.big_summary_cursor = 1;
  sandbox.MEMORY_ENGINE_DATA.saveState(state);

  // 模拟删除第 2 楼：剩余消息保留稳定来源 ID，楼层数字自然前移。
  chat.splice(2, 1);
  const result = await sandbox.MEMORY_ENGINE.reconcileHistory();
  const next = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert.strictEqual(calls.length, 0, '删除楼层不得调用 AI 修复');
  assert.strictEqual(next.timeline.nodes.length, 0, '依赖已删除楼层的 Memory 节点必须清理');
  assert.strictEqual(next.event_memory.small_summaries.length, 0, '依赖已删除楼层的纪要必须清理');
  assert.strictEqual(next.event_memory.big_summaries.length, 0, '引用已删除纪要的总述必须清理');
  assert.strictEqual(next.event_memory.big_summary_cursor, 0, '清理纪要后总述游标必须回退');
  assert.strictEqual(next.personal_memory.length, 0, '删除楼层贡献不得通过重放继续注入');
  assert.strictEqual(result.repaired, false, '纯删除清理不应报告为 AI 重建');
  assert.strictEqual(result.deleted, true, '纯删除清理应返回 deleted 标记，供界面区分 AI 修复');
  calls.length = 0;
  await sandbox.MEMORY_ENGINE.repairCurrentHistory();
  assert.ok(calls.length > 0, '删除清理后仍存在的楼层应允许自动补提取');
  assert.ok(calls.every(prompt => !prompt.includes('已删除的错误战报')), '补提取请求不得携带已删除楼层正文');
  console.log('deleted layer cleanup tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
