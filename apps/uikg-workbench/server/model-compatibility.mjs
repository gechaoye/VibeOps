export const ZTO_NEWAPI_VISIBLE_MODELS = new Set([
  'doubao-seed-2.1-pro',
  'kimi-k2.6',
  'kimi-k2.6-dashscope',
  'kimi-k2.7-code',
  'MiniMax-M2.7-highspeed',
  'MiniMax-M3',
  'qwen3.6-flash',
  'qwen3.6-plus',
  'qwen3.8-max',
]);

const QWEN_REASONING_BUDGETS = {
  low: 2048,
  medium: 8192,
  high: 16384,
};

export function modelFamilyForName(modelName) {
  const name = String(modelName || '').toLowerCase();
  if (name.includes('qwen2.5-vl')) return 'qwen2.5-vl';
  if (name.includes('qwen3-vl')) return 'qwen3-vl';
  if (name.includes('qwen3.6')) return 'qwen3.6';
  if (name.includes('qwen3.5')) return 'qwen3.5';
  if (name.includes('qwen3')) return 'qwen3';
  if (name.includes('doubao')) return 'doubao-seed';
  if (name.includes('gemini')) return 'gemini';
  if (name.includes('kimi-k3') || name.includes('kimi3')) return 'kimi3';
  if (name.includes('kimi')) return 'kimi';
  if (name.includes('xiaomi') || name.includes('mimo')) return 'xiaomi-mimo';
  // Midscene 1.10 has no MiniMax family; its GPT-5 adapter matches M3's
  // OpenAI-compatible JSON mode and reasoning_effort contract.
  if (name.includes('minimax')) return 'gpt-5';
  return 'gpt-5';
}

export function reasoningBudgetForModel(modelName, reasoningEffort) {
  if (!String(modelName || '').toLowerCase().startsWith('qwen')) return null;
  return QWEN_REASONING_BUDGETS[reasoningEffort] || QWEN_REASONING_BUDGETS.medium;
}

export function chatCompletionCompatibility({ modelName, reasoningEffort, reasoningEnabled = true }) {
  const name = String(modelName || '').toLowerCase();
  if (name.startsWith('qwen')) {
    return {
      enable_thinking: Boolean(reasoningEnabled),
      ...(reasoningEnabled ? { thinking_budget: reasoningBudgetForModel(name, reasoningEffort) } : {}),
    };
  }
  if (name.startsWith('doubao')) {
    return {
      thinking: { type: reasoningEnabled ? 'enabled' : 'disabled' },
      ...(reasoningEnabled ? { reasoning_effort: reasoningEffort } : {}),
    };
  }
  return reasoningEnabled ? { reasoning_effort: reasoningEffort } : {};
}
