// 按当前楼层自动补洞测试：node docs/memory-current-repair-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const stored = new Map();
const calls = [];
let failText = '';
let failuresLeft = 0;
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
      if (failuresLeft > 0 && failText && prompt.includes(failText)) {
        failuresLeft--;
        throw new Error('模拟中间楼层失败');
      }
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

{
  const longChat = Array.from({ length: 41 }, (_, index) => ({
    is_user: index % 2 === 1,
    mes: `消息${index}`
  }));
  const selected = sandbox.MEMORY_ENGINE._test.aiLayersForBackfill(
    longChat, { firstLayerIsAiOpening: true }, 20
  );
  assert.strictEqual(selected.length, 20, '结束值应按第 N 个 AI 楼层计算，而不是物理消息下标');
  assert.strictEqual(selected.at(-1), 40, '第20个 AI 楼层应定位到当前聊天第40个物理楼层');
}

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

  chat.push(
    { is_user: true, name: '用户', mes: '第一批新增。' },
    { is_user: false, name: '角色', mes: '第一批新增结果。' },
    { is_user: true, name: '用户', mes: '第二批故障。' },
    { is_user: false, name: '角色', mes: '第二批故障结果。' },
    { is_user: true, name: '用户', mes: '第三批新增。' },
    { is_user: false, name: '角色', mes: '第三批新增结果。' }
  );
  sandbox.MEMORY_ENGINE_DATA.saveState(sandbox.MEMORY_ENGINE_DATA.defaultState());
  calls.length = 0;
  failText = '第二批故障';
  failuresLeft = 1;
  await sandbox.MEMORY_ENGINE.backfill();
  state = sandbox.MEMORY_ENGINE_DATA.loadState();
  let memoryEnds = state.timeline.nodes.filter(node => node.kind === 'memory').map(node => node.endLayer);
  assert.ok(memoryEnds.includes(6) && memoryEnds.includes(10), '手动重填中间批失败后必须继续处理后续楼层');
  assert.ok(!memoryEnds.includes(8), '失败楼层不得误标为已完成');
  assert.ok(sandbox.MEMORY_ENGINE.getBackfillStatus().message.includes('跳过 1 批'));

  failText = '';
  const repaired = await sandbox.MEMORY_ENGINE.repairCurrentHistory();
  state = sandbox.MEMORY_ENGINE_DATA.loadState();
  memoryEnds = state.timeline.nodes.filter(node => node.kind === 'memory').map(node => node.endLayer);
  assert.strictEqual(repaired.failedMemoryBatches, 0);
  assert.ok(memoryEnds.includes(8), '自动修复必须再次尝试先前跳过的楼层');
  assert.strictEqual(JSON.stringify(memoryEnds), JSON.stringify([...memoryEnds].sort((a, b) => a - b)),
    '补回较早楼层后人物实体时间链仍必须按楼层顺序排列');
  assert.strictEqual(state.chatLayer, 10, '补回较早人物实体楼层不得让推进游标倒退');

  sandbox.MEMORY_ENGINE_DATA.saveState(sandbox.MEMORY_ENGINE_DATA.defaultState());
  failText = '第二批故障';
  failuresLeft = 1;
  await sandbox.MEMORY_ENGINE.backfillSummaries();
  state = sandbox.MEMORY_ENGINE_DATA.loadState();
  let summaryEnds = state.event_memory.small_summaries.map(item => item.endLayer);
  assert.ok(summaryEnds.includes(10), '纪要手动重填中间批失败后必须继续处理后续楼层');
  assert.ok(!summaryEnds.includes(8), '失败纪要不得误标为已完成');
  failText = '';
  await sandbox.MEMORY_ENGINE.repairCurrentHistory();
  state = sandbox.MEMORY_ENGINE_DATA.loadState();
  summaryEnds = state.event_memory.small_summaries.map(item => item.endLayer);
  assert.ok(summaryEnds.includes(8), '自动修复必须再次尝试手动重填跳过的纪要楼层');
  assert.strictEqual(JSON.stringify(summaryEnds), JSON.stringify([...summaryEnds].sort((a, b) => a - b)),
    '补回较早纪要后仍必须按楼层顺序排列');
  assert.strictEqual(state.event_memory.small_summary_layer, 10, '补回较早纪要不得让纪要游标倒退');

  sandbox.MEMORY_ENGINE_DATA.saveState(sandbox.MEMORY_ENGINE_DATA.defaultState());
  failText = '第二批故障';
  failuresLeft = 1;
  const skipped = await sandbox.MEMORY_ENGINE.repairCurrentHistory();
  state = sandbox.MEMORY_ENGINE_DATA.loadState();
  memoryEnds = state.timeline.nodes.filter(node => node.kind === 'memory').map(node => node.endLayer);
  assert.strictEqual(skipped.failedMemoryBatches, 1, '自动修复必须记录失败批次而不是整体中止');
  assert.ok(memoryEnds.includes(10) && !memoryEnds.includes(8), '自动修复失败后仍必须继续处理后续楼层');
  failText = '';
  await sandbox.MEMORY_ENGINE.repairCurrentHistory();
  state = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert.ok(state.timeline.nodes.filter(node => node.kind === 'memory').some(node => node.endLayer === 8),
    '再次自动修复必须补回上次失败楼层');
  console.log('current layer automatic repair tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
