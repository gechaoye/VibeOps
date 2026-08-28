import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { registerWorkbenchRoutes } from './workbench-routes.mjs';
import { clearModelRuntime, setModelRuntime } from './model-runtime.mjs';

const WORKBENCH_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRAME_ID = 'sha256:self-healing-test';

function recognitionResult(interactionBoundary = 'tap-target') {
  return {
    frameId: FRAME_ID,
    page: { name: '测试页面', surfaceType: 'page', stateSummary: '默认状态', scrollableRegions: [] },
    elements: [{
      candidateKey: 'profile-template',
      label: '资料区域',
      visualDescription: '包含资料字段的区域',
      displayCondition: '',
      elementType: 'list-item',
      interactive: false,
      enabled: true,
      state: null,
      approximateRegion: { x: 0.1, y: 0.2, width: 0.8, height: 0.2 },
      geometryKind: 'boundary',
      geometryConfidence: 0.9,
      meaning: { status: 'known', description: '资料区域', evidence: { visibleTexts: ['资料'], visibleIcons: [], visibleStates: [], visualCues: [], userContext: null, unclassified: [] } },
      dynamicContent: true,
      abstraction: {
        kind: 'dynamic-template',
        templateKey: 'profile',
        instanceCount: 1,
        fields: [{
          key: 'name', label: '姓名', elementType: 'text-button', description: '可点击的姓名字段', displayCondition: '', capabilities: ['tap'],
          interactionBoundary, actionEffects: [{ action: 'tap', effect: '打开资料' }], parentId: null, required: true,
          instanceRegions: [{ x: 0.2, y: 0.24, width: 0.3, height: 0.06 }],
        }],
        instanceRegions: [{ x: 0.1, y: 0.2, width: 0.8, height: 0.2 }],
        bboxStyle: 'abstract',
      },
      riskSignals: [],
      confidence: 0.9,
    }],
    relationships: [],
    actionCandidates: [],
    comparison: { basisFrameId: null, status: 'not-requested', changes: [] },
    uncertainties: [],
  };
}

async function runScenario(repairImplementation, configureRepair = true) {
  setModelRuntime('manual', { modelName: 'recognizer', baseUrl: 'https://invalid.test/v1', apiKey: 'secret', structuredOutputMode: 'local' });
  if (configureRepair) setModelRuntime('self_heal', { modelName: 'healer', baseUrl: 'https://invalid.test/v1', apiKey: 'secret', structuredOutputMode: 'local' });
  else clearModelRuntime('self_heal');
  const app = express();
  const records = [];
  const sessions = [];
  let repairCalls = 0;
  const server = {
    app,
    agent: null,
    getSessionState: () => null,
    async runRecognitionModel() { return recognitionResult(); },
    async runRecognitionRepairModel(input) {
      repairCalls += 1;
      return repairImplementation(input);
    },
  };
  const store = {
    async loadFrame() { return { frameId: FRAME_ID, imagePath: '/tmp/self-healing.png', mimeType: 'image/png', runtimeStructure: null }; },
    async saveModelResult(id, value) { records.push(structuredClone(value)); return path.join(WORKBENCH_ROOT, '.data', `${id}.json`); },
    async saveAnalysisSession(value) { sessions.push(structuredClone(value)); },
  };
  await registerWorkbenchRoutes({ server, store, graphWorkflow: {}, workbenchRoot: WORKBENCH_ROOT, spec: { version: 'test', schemaVersion: 'test', contentHash: 'test', index: 'test' } });
  const httpServer = createServer(app);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${httpServer.address().port}/workbench/api/recognition/manual/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ frameId: FRAME_ID }),
    });
    return { text: await response.text(), records, sessions, repairCalls };
  } finally {
    await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    clearModelRuntime('manual');
    clearModelRuntime('self_heal');
  }
}

function eventPayload(stream, eventName) {
  const block = stream.split(/\r?\n\r?\n/).find((candidate) => candidate.includes(`event: ${eventName}`));
  const data = block?.split(/\r?\n/).find((line) => line.startsWith('data: '))?.slice(6);
  return data ? JSON.parse(data) : null;
}

test('Schema 失败后调用自愈模型一次并使用再次校验通过的结果', async () => {
  const scenario = await runScenario(() => ({ repairedResult: recognitionResult('candidate_bbox'), outputContent: '{"repaired":true}' }));
  assert.equal(scenario.repairCalls, 1);
  assert.match(scenario.text, /phase":"self-heal"/);
  const result = eventPayload(scenario.text, 'result');
  assert.equal(result.recognitionResult.elements[0].abstraction.fields[0].interactionBoundary, 'candidate_bbox');
  assert.equal(scenario.records[0].selfHealing.succeeded, true);
  assert.equal(scenario.records[0].selfHealing.initialValidation.schemaErrors[0].instancePath, '/elements/0/abstraction/fields/0/interactionBoundary');
});

test('自愈输出仍非法时不二次调用并返回首次与修复后详细错误', async () => {
  const scenario = await runScenario(() => ({ repairedResult: recognitionResult('仍然非法'), outputContent: '{"still":"invalid"}' }));
  assert.equal(scenario.repairCalls, 1);
  const failure = eventPayload(scenario.text, 'error');
  assert.equal(failure.selfHealing.attempted, true);
  assert.equal(failure.selfHealing.succeeded, false);
  assert.ok(failure.selfHealing.initialValidation.schemaErrors.length > 0);
  assert.ok(failure.selfHealing.repairedValidation.schemaErrors.length > 0);
  assert.equal(scenario.records[0].selfHealing.repairOutput, '{"still":"invalid"}');
  assert.equal(scenario.sessions.at(-1).selfHealing.error, '自愈输出仍未通过结构检查');
});

test('未配置自愈模型时保留详细校验错误且不调用修复', async () => {
  const scenario = await runScenario(() => recognitionResult('candidate_bbox'), false);
  assert.equal(scenario.repairCalls, 0);
  const failure = eventPayload(scenario.text, 'error');
  assert.equal(failure.selfHealing.attempted, false);
  assert.equal(failure.selfHealing.reason, 'not-configured');
  assert.ok(failure.schemaErrors.length > 0);
});

test('自愈模型篡改 frameId 时二次检查拒绝结果', async () => {
  const scenario = await runScenario(() => {
    const repairedResult = recognitionResult('candidate_bbox');
    repairedResult.frameId = 'sha256:wrong-frame';
    return { repairedResult, outputContent: JSON.stringify(repairedResult) };
  });
  assert.equal(scenario.repairCalls, 1);
  const failure = eventPayload(scenario.text, 'error');
  assert.equal(failure.selfHealing.succeeded, false);
  assert.equal(failure.selfHealing.repairedValidation.frameIdValid, false);
  assert.equal(scenario.records[0].normalizedResult.frameId, 'sha256:wrong-frame');
});

test('自愈模型将越界候选挤到截图边缘时拒绝结果', async () => {
  const scenario = await runScenario(() => {
    const repairedResult = recognitionResult('candidate_bbox');
    repairedResult.elements[0].approximateRegion = { x: 0.1, y: 0.95, width: 0.8, height: 0.2 };
    return { repairedResult, outputContent: JSON.stringify(repairedResult) };
  });
  assert.equal(scenario.repairCalls, 1);
  const failure = eventPayload(scenario.text, 'error');
  assert.equal(failure.selfHealing.succeeded, false);
  assert.ok(failure.selfHealing.repairedValidation.consistencyIssues.some((issue) => issue.includes('候选框超出截图边界')));
});
