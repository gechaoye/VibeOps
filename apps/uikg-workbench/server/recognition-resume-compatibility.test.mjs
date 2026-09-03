import assert from 'node:assert/strict';
import test from 'node:test';
import {
  recognitionModelConfigFingerprint,
  recognitionPromptRuleFingerprint,
  recognitionResumeFingerprintMismatches,
} from './workbench-routes.mjs';

const runtime = {
  gatewayId: 'gateway-a',
  baseUrl: 'https://gateway.example/v1',
  modelName: 'vision-model-a',
  modelFamily: 'gpt-5',
  timeout: 180000,
  temperature: 0,
  reasoningEffort: 'medium',
  structuredOutputMode: 'native',
  updatedAt: '2026-09-02T00:00:00.000Z',
  apiKey: 'secret-a',
};

test('识别模型配置指纹覆盖影响输出的配置但不暴露 API Key', () => {
  const baseline = recognitionModelConfigFingerprint(runtime);
  assert.equal(baseline, recognitionModelConfigFingerprint({ ...runtime }));
  assert.notEqual(baseline, recognitionModelConfigFingerprint({ ...runtime, modelName: 'vision-model-b' }));
  assert.notEqual(baseline, recognitionModelConfigFingerprint({ ...runtime, baseUrl: 'https://other.example/v1' }));
  assert.notEqual(baseline, recognitionModelConfigFingerprint({ ...runtime, apiKey: 'secret-b' }));
  assert.doesNotMatch(baseline, /secret-a/);
});

test('恢复只在已记录的模型、prompt 和规则指纹全部兼容时复用 checkpoint', () => {
  const rules = [{ key: 'rule-a', category: 'custom', title: '规则', description: '内容' }];
  const current = {
    modelConfigFingerprint: recognitionModelConfigFingerprint(runtime),
    promptFingerprint: 'prompt-a',
    promptRuleFingerprint: recognitionPromptRuleFingerprint(rules),
  };
  assert.deepEqual(recognitionResumeFingerprintMismatches({ ...current }, current), []);
  assert.deepEqual(recognitionResumeFingerprintMismatches({ ...current, modelConfigFingerprint: 'changed' }, current), ['modelConfigFingerprint']);
  assert.deepEqual(recognitionResumeFingerprintMismatches({ ...current, promptFingerprint: 'changed' }, current), ['promptFingerprint']);
  assert.deepEqual(recognitionResumeFingerprintMismatches({ ...current, promptRuleFingerprint: 'changed' }, current), ['promptRuleFingerprint']);
  assert.deepEqual(recognitionResumeFingerprintMismatches({ modelConfigFingerprint: current.modelConfigFingerprint }, current), ['promptFingerprint', 'promptRuleFingerprint']);
  // Sessions written before fingerprints were introduced remain resumable.
  assert.deepEqual(recognitionResumeFingerprintMismatches({ rawResult: { elements: [] } }, current), []);
});
