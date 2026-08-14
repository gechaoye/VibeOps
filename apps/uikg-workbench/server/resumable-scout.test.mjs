import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeScoutContinuation,
  recoverScoutCheckpointFromStream,
  runResumableScout,
  SCOUT_CONTINUATION_RETRY_LIMIT,
  SCOUT_CONTINUATION_TIMEOUT_MS,
  summarizeScoutCheckpoint,
} from './resumable-scout.mjs';

function element(candidateKey, y) {
  return {
    candidateKey,
    label: candidateKey,
    controlType: 'label',
    approximateRegion: { x: 0, y, width: 1, height: 0.1 },
  };
}

test('Scout 续写按 candidateKey 合并元素并去重关系与动作', () => {
  const base = {
    frameId: 'sha256:frame',
    page: { name: '消息' },
    elements: [element('header', 0)],
  };
  const merged = mergeScoutContinuation(base, {
    elements: [element('header', 0), element('list-item-1', 0.2)],
    relationships: [
      { fromCandidateKey: 'header', type: 'adjacent-to', toCandidateKey: 'list-item-1' },
      { fromCandidateKey: 'header', type: 'adjacent-to', toCandidateKey: 'list-item-1' },
    ],
    actionCandidates: [
      { triggerCandidateKey: 'list-item-1', action: 'tap', expectedOutcome: '详情' },
      { triggerCandidateKey: 'list-item-1', action: 'tap', expectedOutcome: '详情' },
    ],
    comparison: { basisFrameId: null, status: 'not-requested', changes: [] },
    uncertainties: ['未知文本', '未知文本'],
    done: true,
  });

  assert.deepEqual(merged.elements.map((item) => item.candidateKey), ['header', 'list-item-1']);
  assert.equal(merged.relationships.length, 1);
  assert.equal(merged.actionCandidates.length, 1);
  assert.deepEqual(merged.uncertainties, ['未知文本']);
  assert.equal('done' in merged, false);
  assert.equal(summarizeScoutCheckpoint(merged).coveredBottom, 0.30000000000000004);
});

test('Scout 流超时后仅恢复结构完整的候选作为断点', () => {
  const complete = {
    ...element('header', 0),
    visualDescription: '顶部标题',
    interactive: false,
    geometryKind: 'boundary',
    geometryConfidence: 0.9,
    meaning: { status: 'known', description: '标题', dynamicContent: false, confidence: 0.9 },
  };
  const stream = `<observation>页面</observation><data-json>${JSON.stringify({ frameId: 'sha256:frame', page: { name: '消息' }, elements: [complete] }).slice(0, -2)}, {"candidateKey":"truncated","label":"未完成`;
  const recovered = recoverScoutCheckpointFromStream(stream);

  assert.equal(recovered.frameId, 'sha256:frame');
  assert.deepEqual(recovered.elements.map((item) => item.candidateKey), ['header']);
});

test('Scout 超时后从增长的断点续写直至模型确认完成', async () => {
  const prompts = [];
  let calls = 0;
  const partial = { frameId: 'sha256:frame', page: { name: '消息' }, elements: [element('header', 0)] };
  const result = await runResumableScout({
    initialPrompt: 'initial',
    callScout: async (prompt) => {
      prompts.push(prompt);
      calls += 1;
      if (calls === 1) return partial;
      if (calls === 2) return { elements: [element('list-item-1', 0.2)], done: false };
      return {
        elements: [element('footer', 0.9)],
        relationships: [],
        actionCandidates: [],
        comparison: { basisFrameId: null, status: 'not-requested', changes: [] },
        uncertainties: [],
        done: true,
      };
    },
    buildContinuationPrompt: (checkpoint) => JSON.stringify(checkpoint),
    isComplete: (scout) => ['relationships', 'actionCandidates', 'comparison', 'uncertainties'].every((key) => key in scout),
    shouldContinue: () => true,
    retryTimeoutMs: 1000,
  });

  assert.equal(result.completed, true);
  assert.equal(result.retryAttempts.length, 2);
  assert.deepEqual(result.rawResult.elements.map((item) => item.candidateKey), ['header', 'list-item-1', 'footer']);
  assert.match(prompts[1], /header/);
  assert.match(prompts[2], /list-item-1/);
});

test('Scout 自动续写使用 30 秒超时并在 5 次失败后暂停', async () => {
  let continuationCalls = 0;
  const result = await runResumableScout({
    initialPrompt: 'initial',
    initialResult: { frameId: 'sha256:frame', page: { name: '消息' }, elements: [element('header', 0)] },
    callScout: async () => {
      continuationCalls += 1;
      throw new Error('retry timeout');
    },
    buildContinuationPrompt: () => 'continue',
    isComplete: () => false,
    shouldContinue: () => true,
  });

  assert.equal(SCOUT_CONTINUATION_TIMEOUT_MS, 30_000);
  assert.equal(SCOUT_CONTINUATION_RETRY_LIMIT, 5);
  assert.equal(continuationCalls, 5);
  assert.equal(result.completed, false);
  assert.equal(result.retryAttempts.length, 5);
});

test('Scout 首次超时且没有可解析输出时从画面起点进入续写', async () => {
  let calls = 0;
  const result = await runResumableScout({
    initialPrompt: 'initial',
    initialFallback: { frameId: 'sha256:frame', elements: [] },
    callScout: async () => {
      calls += 1;
      if (calls === 1) throw new Error('initial timeout');
      return {
        frameId: 'sha256:frame',
        page: { name: '消息' },
        elements: [element('header', 0)],
        relationships: [],
        actionCandidates: [],
        comparison: { basisFrameId: null, status: 'not-requested', changes: [] },
        uncertainties: [],
        done: true,
      };
    },
    buildContinuationPrompt: () => 'continue',
    isComplete: (scout) => Boolean(scout.page && scout.relationships && scout.actionCandidates && scout.comparison && scout.uncertainties),
    shouldContinue: () => true,
    retryTimeoutMs: 1000,
  });

  assert.equal(calls, 2);
  assert.equal(result.completed, true);
  assert.equal(result.initialError, 'initial timeout');
  assert.deepEqual(result.rawResult.elements.map((item) => item.candidateKey), ['header']);
});
