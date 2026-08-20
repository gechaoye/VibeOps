import { strict as assert } from 'node:assert';
import test from 'node:test';
import { openAIStructuredOutputSchema, supportsStructuredOutput } from './structured-output-schema.mjs';

test('GPT-5 和两个 Qwen3.7 模型启用结构化输出', () => {
  assert.equal(supportsStructuredOutput('gpt-5.6-sol', 'gpt-5'), true);
  assert.equal(supportsStructuredOutput('qwen3.7-flash', 'qwen3'), true);
  assert.equal(supportsStructuredOutput('qwen3.7-plus', 'qwen3'), true);
  assert.equal(supportsStructuredOutput('qwen3.7-max', 'qwen3'), false);
  assert.equal(supportsStructuredOutput('MiniMax-M3', 'gpt-5'), false);
  assert.equal(supportsStructuredOutput('qwen3-vl-plus', 'qwen3-vl'), false);
});

test('Model A 断点续写 Schema 包含严格 done 字段', () => {
  const schema = openAIStructuredOutputSchema({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { frameId: { type: 'string' }, elements: { type: 'array', uniqueItems: true, items: { type: 'string' } } },
  }, { continuation: true });

  assert.deepEqual(schema.required, ['frameId', 'elements', 'done']);
  assert.deepEqual(schema.properties.done, { type: 'boolean' });
  assert.equal(schema.properties.elements.uniqueItems, undefined);
  assert.equal(schema.additionalProperties, false);
});
