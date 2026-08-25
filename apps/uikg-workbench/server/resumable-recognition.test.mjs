import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeRecognitionContinuation,
  recoverRecognitionCheckpointFromStream,
  runResumableRecognition,
  RECOGNITION_ERROR_RETRY_LIMIT,
  summarizeRecognitionCheckpoint,
} from './resumable-recognition.mjs';

function element(candidateKey, y) {
  return {
    candidateKey,
    label: candidateKey,
    elementType: 'label',
    approximateRegion: { x: 0, y, width: 1, height: 0.1 },
  };
}

function completeRecognition(elements) {
  return {
    frameId: 'sha256:frame',
    page: { name: '消息' },
    elements,
    relationships: [],
    actionCandidates: [],
    comparison: { basisFrameId: null, status: 'not-requested', changes: [] },
    uncertainties: [],
  };
}

test('单模型续写按 candidateKey 合并元素并去重关系与动作', () => {
  const base = {
    frameId: 'sha256:frame',
    page: { name: '消息' },
    elements: [element('header', 0)],
  };
  const merged = mergeRecognitionContinuation(base, {
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
  assert.equal(summarizeRecognitionCheckpoint(merged).coveredBottom, 0.30000000000000004);
});

test('单模型流错误后仅恢复结构完整的候选作为断点', () => {
  const complete = {
    ...element('header', 0),
    visualDescription: '顶部标题',
    interactive: false,
    geometryKind: 'boundary',
    geometryConfidence: 0.9,
    meaning: { status: 'known', description: '标题', dynamicContent: false, confidence: 0.9 },
  };
  const stream = `<observation>页面</observation><data-json>${JSON.stringify({ frameId: 'sha256:frame', page: { name: '消息' }, elements: [complete] }).slice(0, -2)}, {"candidateKey":"truncated","label":"未完成`;
  const recovered = recoverRecognitionCheckpointFromStream(stream);

  assert.equal(recovered.frameId, 'sha256:frame');
  assert.deepEqual(recovered.elements.map((item) => item.candidateKey), ['header']);
});

test('正常结束但结构未完成时不自动重试', async () => {
  let calls = 0;
  const result = await runResumableRecognition({
    initialPrompt: 'initial',
    callModel: async () => {
      calls += 1;
      return { frameId: 'sha256:frame', elements: [element('header', 0)] };
    },
    buildContinuationPrompt: () => 'continue',
    isComplete: () => false,
  });

  assert.equal(calls, 1);
  assert.equal(result.completed, false);
  assert.equal(result.retryAttempts.length, 0);
  assert.equal(result.lastError, null);
});

test('模型错误重试从断点续写，并在收到内容后重置计数', async () => {
  const prompts = [];
  const builtCheckpoints = [];
  const retryNumbers = [];
  let calls = 0;
  const partial = { frameId: 'sha256:frame', page: { name: '消息' }, elements: [element('header', 0)] };
  const result = await runResumableRecognition({
    initialPrompt: 'initial',
    callModel: async (prompt) => {
      prompts.push(prompt);
      calls += 1;
      if (calls === 1) {
        const error = new Error('连接断开 1');
        error.recognitionCheckpoint = partial;
        error.receivedContent = true;
        throw error;
      }
      if (calls === 2) {
        const error = new Error('连接断开 2');
        error.recognitionCheckpoint = { elements: [element('list-item-1', 0.2)] };
        error.receivedContent = true;
        throw error;
      }
      if (calls === 3) throw new Error('连接断开 3');
      return { ...completeRecognition([element('footer', 0.9)]), done: true };
    },
    buildContinuationPrompt: (checkpoint, attempt) => {
      builtCheckpoints.push({ checkpoint, attempt });
      return JSON.stringify(checkpoint);
    },
    isComplete: (result) => Boolean(result?.relationships && result?.actionCandidates && result?.comparison && result?.uncertainties),
    onRetry: ({ attempt }) => retryNumbers.push(attempt),
  });

  assert.equal(calls, 4);
  assert.equal(result.completed, true);
  assert.deepEqual(result.rawResult.elements.map((item) => item.candidateKey), ['header', 'list-item-1', 'footer']);
  assert.deepEqual(retryNumbers, [1, 1, 2]);
  assert.equal(builtCheckpoints.length, 3);
  assert.match(prompts[1], /header/);
  assert.match(prompts[2], /list-item-1/);
});

test('超过 5 次模型错误后返回最后一次错误，不使用 30 秒超时', async () => {
  let calls = 0;
  const retries = [];
  const result = await runResumableRecognition({
    initialPrompt: 'initial',
    callModel: async () => {
      calls += 1;
      throw new Error(`连接失败 ${calls}`);
    },
    buildContinuationPrompt: () => 'continue',
    isComplete: () => false,
    onRetry: ({ attempt }) => retries.push(attempt),
  });

  assert.equal(RECOGNITION_ERROR_RETRY_LIMIT, 5);
  assert.equal(calls, 6, '初始请求之外最多重试 5 次');
  assert.deepEqual(retries, [1, 2, 3, 4, 5]);
  assert.equal(result.completed, false);
  assert.equal(result.lastError, '连接失败 6');
});

test('首次模型错误且没有可解析输出时从画面起点重试', async () => {
  let calls = 0;
  const result = await runResumableRecognition({
    initialPrompt: 'initial',
    initialFallback: { frameId: 'sha256:frame', elements: [] },
    callModel: async () => {
      calls += 1;
      if (calls === 1) throw new Error('initial error');
      return { ...completeRecognition([element('header', 0)]), done: true };
    },
    buildContinuationPrompt: () => 'continue',
    isComplete: (result) => Boolean(result.page && result.relationships && result.actionCandidates && result.comparison && result.uncertainties),
  });

  assert.equal(calls, 2);
  assert.equal(result.completed, true);
  assert.equal(result.initialError, 'initial error');
  assert.deepEqual(result.rawResult.elements.map((item) => item.candidateKey), ['header']);
});

test('确定性的模型 4xx 错误不重试', async () => {
  let calls = 0;
  const result = await runResumableRecognition({
    initialPrompt: 'initial',
    callModel: async () => {
      calls += 1;
      const error = new Error('模型请求失败（400）：Invalid schema');
      error.retryable = false;
      throw error;
    },
    buildContinuationPrompt: () => 'continue',
    isComplete: () => false,
  });

  assert.equal(calls, 1);
  assert.equal(result.retryAttempts.length, 1);
  assert.equal(result.lastError, '模型请求失败（400）：Invalid schema');
});
