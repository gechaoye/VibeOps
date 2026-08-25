import { strict as assert } from 'node:assert';
import test from 'node:test';
import { openAIStructuredOutputSchema } from './structured-output-schema.mjs';

test('结构化输出 Schema 展开内部引用', () => {
  const source = {
    type: 'object',
    properties: {
      region: { type: 'object', properties: { x: { type: 'number' } } },
      regions: { type: 'array', items: { $ref: '#/properties/region' } },
    },
  };
  const schema = openAIStructuredOutputSchema(source);
  assert.equal(schema.properties.regions.items.$ref, undefined);
  assert.deepEqual(schema.properties.regions.items.required, ['x']);
});

test('单模型断点续写 Schema 包含严格 done 字段', () => {
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
