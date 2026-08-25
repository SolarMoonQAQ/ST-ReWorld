// 按当前楼层自动补洞测试：node docs/memory-current-repair-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const stored = new Map();
const calls = [];
const chat = [
  { is_user: false, name: '角色', mes: '开场白' },
  { is_user: true, name: '用户', mes: '进入黑石峡。' },
  { is_user: false, name: '角色', mes: '李定国设伏击败敌军。' },
  { is_user: true, name: '用户', mes: '清点战果。' },
  { is_user: false, name: '角色', mes: '缴获二百八十匹战马。' }
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
    getChatId() { return 'current-repair-test'; },
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
        maxTokens: 65000,
        temperature: 0.2,
        apiAutoRetries: 0,
        backfillBatchSize: 1,
        summaryBackfillSmallEveryX: 1,
        summaryBackfillBigEveryX: 2,
        backfillRetries: 0,
        backfillEndLayer: 0,
        referenceRawRounds: 0,
        referenceSmallSummaryCount: 0,
        referenceBigSummaryCount: 0
      };
    }
  },
  WORLD_ENGINE_API: {
    async callApi(prompt) {
      calls.push(prompt);
      if (prompt.includes('世界进程的总述编纂者')) return '李定国在黑石峡取胜并缴获二百八十匹战马。';
      if (prompt.includes('"small_summary": ""')) return JSON.stringify({ small_summary: `纪要${calls.length}` });
      return JSON.stringify({
        personal_memory: [{ name: ['李定国'], known_by: [], memory: `记忆${calls.length}`, time: '' }],
        entity_updates: []
      });
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
]) vm.runInNewContext(fs.readFileSync(path.join(root, filename), 'utf8'), sandbox, { filename });

(async () => {
  sandbox.MEMORY_ENGINE_DATA.saveState(sandbox.MEMORY_ENGINE_DATA.defaultState());
  const first = await sandbox.MEMORY_ENGINE.repairCurrentHistory();
  let state = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert.strictEqual(first.memoryBatches, 2);
  assert.strictEqual(first.summaryBatches, 2);
  assert.strictEqual(state.timeline.nodes.filter(node => node.kind === 'memory').length, 2);
  assert.strictEqual(state.event_memory.small_summaries.length, 2);
  assert.strictEqual(state.event_memory.big_summaries.length, 1);
  assert.strictEqual(JSON.stringify([...state.event_memory.big_summaries[0].childIds]),
    JSON.stringify(state.event_memory.small_summaries.map(item => item.id)));

  const callCount = calls.length;
  const second = await sandbox.MEMORY_ENGINE.repairCurrentHistory();
  state = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert.strictEqual(second.memoryBatches, 0);
  assert.strictEqual(second.summaryBatches, 0);
  assert.strictEqual(calls.length, callCount, '数据完整时再次自动修复不得重复调用 API');
  assert.strictEqual(state.event_memory.big_summaries.length, 1);
  console.log('current layer automatic repair tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
