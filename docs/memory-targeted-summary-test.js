// 指定纪要/总述 AI 重填测试：node docs/memory-targeted-summary-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const stored = new Map();
const chat = [
  { is_user: false, name: '角色', mes: '开场白' },
  { is_user: true, name: '用户', mes: '进入黑石峡。' },
  { is_user: false, name: '角色', mes: '李定国设伏并击败敌军。' }
];
const calls = [];
const sandbox = {
  window: null,
  console,
  setTimeout,
  clearTimeout,
  AbortController,
  SillyTavern: { getContext() { return { chat, name1: '用户', name2: '角色', setExtensionPrompt() {} }; } },
  WORLD_ENGINE_STORE: {
    getItem(key) { return stored.has(key) ? stored.get(key) : null; },
    setItem(key, value) { stored.set(key, String(value)); },
    removeItem(key) { stored.delete(key); }
  },
  WORLD_ENGINE_CORE: {
    getChatId() { return 'targeted-summary-test'; },
    getChatLayer() { return chat.length - 1; },
    filterDialogue(value) { return value; }
  },
  WORLD_ENGINE_WORLDBOOK: { async buildPromptSection() { return ''; } },
  WORLD_ENGINE_CHATCACHE: { forScope() { return { afterEvolution() {} }; } },
  WORLD_ENGINE_UI: { setMemoryEvolvingUI() {}, refresh() {} },
  MEMORY_ENGINE_SETTINGS: {
    getSettings() {
      return {
        engineEnabled: true,
        firstLayerIsAiOpening: true,
        maxTokens: 65000,
        temperature: 0.2,
        apiAutoRetries: 0,
        bigSummaryEveryX: 1,
        referenceRawRounds: 0,
        referenceSmallSummaryCount: 0,
        referenceBigSummaryCount: 0
      };
    }
  },
  WORLD_ENGINE_API: {
    async callApi(prompt) {
      calls.push(prompt);
      if (prompt.includes('世界进程的总述编纂者')) return '李定国在黑石峡设伏并击败敌军。';
      return JSON.stringify({ small_summary: '李定国在黑石峡设伏取胜。' });
    }
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
]) {
  vm.runInNewContext(fs.readFileSync(path.join(root, filename), 'utf8'), sandbox, { filename });
}

(async () => {
  const state = sandbox.MEMORY_ENGINE_DATA.defaultState();
  state.event_memory.small_summaries = [{
    id: 'small_000001', startLayer: 1, endLayer: 2, content: '错误纪要', status: 'valid', revision: 1
  }];
  state.event_memory.big_summaries = [{
    id: 'big_000001', startLayer: 1, endLayer: 2, content: '错误总述',
    childIds: ['small_000001'], status: 'valid', revision: 1
  }];
  state.event_memory.big_summary_cursor = 1;
  sandbox.MEMORY_ENGINE_DATA.saveState(state);

  const smallResult = await sandbox.MEMORY_ENGINE.regenerateSmallSummary('small_000001');
  let updated = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert.strictEqual(smallResult.updatedSmall, 1);
  assert.strictEqual(updated.event_memory.small_summaries.length, 1);
  assert.strictEqual(updated.event_memory.small_summaries[0].id, 'small_000001');
  assert.strictEqual(updated.event_memory.small_summaries[0].content, '李定国在黑石峡设伏取胜。');
  assert.strictEqual(updated.event_memory.small_summaries[0].revision, 2);
  assert.strictEqual(updated.event_memory.big_summaries[0].status, 'stale');

  const bigResult = await sandbox.MEMORY_ENGINE.regenerateBigSummary('big_000001');
  updated = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert.strictEqual(bigResult.updatedBig, 1);
  assert.strictEqual(updated.event_memory.big_summaries.length, 1);
  assert.strictEqual(updated.event_memory.big_summaries[0].id, 'big_000001');
  assert.strictEqual(updated.event_memory.big_summaries[0].content, '李定国在黑石峡设伏并击败敌军。');
  assert.strictEqual(updated.event_memory.big_summaries[0].status, 'valid');
  assert.strictEqual(updated.event_memory.big_summaries[0].revision, 2);
  assert.strictEqual(calls.length, 2);
  console.log('targeted summary regeneration tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
