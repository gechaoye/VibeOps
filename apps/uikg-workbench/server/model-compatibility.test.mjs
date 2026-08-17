import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chatCompletionCompatibility,
  modelFamilyForName,
  reasoningBudgetForModel,
  ZTO_NEWAPI_VISIBLE_MODELS,
} from './model-compatibility.mjs';

test('ZTO 目录移除重复、停用或网关不可用的模型并保留指定视觉模型', () => {
  for (const model of ['claude-haiku-4-5-20251001', 'claude-opus-4-6', 'claude-opus-4-8', 'claude-sonnet-5', 'k3', 'kimi-k3', 'qwen3.7-max', 'doubao-seed-evolving']) {
    assert.equal(ZTO_NEWAPI_VISIBLE_MODELS.has(model), false);
  }
  for (const model of ['qwen3.8-max', 'qwen3.6-flash', 'qwen3.6-plus', 'MiniMax-M3', 'doubao-seed-2.1-pro']) {
    assert.equal(ZTO_NEWAPI_VISIBLE_MODELS.has(model), true);
  }
});

test('指定模型映射到 Midscene 1.10 支持的模型 Family', () => {
  const expected = {
    'qwen3.7-max': 'qwen3',
    'qwen3.8-max': 'qwen3',
    'qwen3.6-flash': 'qwen3.6',
    'qwen3.6-plus': 'qwen3.6',
    'MiniMax-M3': 'gpt-5',
    'doubao-seed-evolving': 'doubao-seed',
    'doubao-seed-2.1-pro': 'doubao-seed',
  };
  for (const [model, family] of Object.entries(expected)) assert.equal(modelFamilyForName(model), family);
});

test('Qwen、Doubao 与 MiniMax 使用各自兼容的推理参数', () => {
  assert.deepEqual(chatCompletionCompatibility({ modelName: 'qwen3.8-max', reasoningEffort: 'high' }), {
    enable_thinking: true,
    thinking_budget: 16384,
  });
  assert.deepEqual(chatCompletionCompatibility({ modelName: 'doubao-seed-2.1-pro', reasoningEffort: 'medium' }), {
    thinking: { type: 'enabled' },
    reasoning_effort: 'medium',
  });
  assert.deepEqual(chatCompletionCompatibility({ modelName: 'MiniMax-M3', reasoningEffort: 'low' }), {
    reasoning_effort: 'low',
  });
  assert.equal(reasoningBudgetForModel('qwen3.6-plus', 'low'), 2048);
  assert.equal(reasoningBudgetForModel('MiniMax-M3', 'high'), null);
});
