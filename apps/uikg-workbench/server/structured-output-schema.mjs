export function supportsStructuredOutput(model, family = '') {
  const modelName = String(model || '').trim().toLowerCase();
  const modelFamily = String(family || '').trim().toLowerCase();
  return modelName.startsWith('gpt-5')
    || modelFamily.startsWith('gpt-5')
    || modelName.startsWith('qwen3.7-');
}

export function openAIStructuredOutputSchema(source, { continuation = false } = {}) {
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== 'object') return value;
    const normalized = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === '$schema' || key === 'title' || key === 'uniqueItems') continue;
      normalized[key] = normalize(item);
    }
    if (normalized.type === 'object') {
      normalized.properties ||= {};
      normalized.required = Object.keys(normalized.properties);
      normalized.additionalProperties = false;
    }
    return normalized;
  };

  const schema = normalize(source);
  const comparison = schema?.properties?.comparison?.properties;
  if (comparison) {
    comparison.basisFrameId = { type: 'null' };
    comparison.status = { type: 'string', enum: ['not-requested'] };
    comparison.changes = {
      type: 'array',
      items: { type: 'object', properties: {}, required: [], additionalProperties: false },
      maxItems: 0,
    };
  }
  if (continuation && schema?.type === 'object') {
    schema.properties.done = { type: 'boolean' };
    schema.required = Object.keys(schema.properties);
  }
  return schema;
}
