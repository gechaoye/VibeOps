export function openAIStructuredOutputSchema(source, { continuation = false } = {}) {
  const resolvePointer = (root, pointer) => {
    if (typeof pointer !== 'string' || !pointer.startsWith('#/')) return null;
    return pointer.slice(2).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~')).reduce((current, key) => current?.[key], root);
  };
  const normalize = (value, root = source, resolving = new Set()) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.$ref === 'string') {
      if (resolving.has(value.$ref)) throw new Error(`结构化输出 Schema 存在循环引用：${value.$ref}`);
      const target = resolvePointer(root, value.$ref);
      if (!target) throw new Error(`结构化输出 Schema 引用不存在：${value.$ref}`);
      return normalize(target, root, new Set([...resolving, value.$ref]));
    }
    if (Array.isArray(value)) return value.map((item) => normalize(item, root, resolving));
    if (!value || typeof value !== 'object') return value;
    const normalized = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === '$schema' || key === 'title' || key === 'uniqueItems') continue;
      normalized[key] = normalize(item, root, resolving);
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
