import type { Draft, FrameMetadata, ScoutModelSettings, ScoutResumeSession, StagingResult, ValidationIssue, WorkbenchStatus } from './types';

export const serverUrl =
  import.meta.env.VITE_PLAYGROUND_URL ||
  (window.location.port.startsWith('517')
    ? 'http://127.0.0.1:5800'
    : window.location.origin);

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${serverUrl}/workbench/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `请求失败：${response.status}`) as Error & {
      details?: unknown;
    };
    error.details = body;
    throw error;
  }
  return body as T;
}

type ScoutStreamResult = { draft: Draft; issues: ValidationIssue[]; modelResultRef: string };

async function consumeScoutStream(
  path: string,
  body: Record<string, unknown>,
  onEvent: (event: { type: string; [key: string]: unknown }) => void,
): Promise<ScoutStreamResult> {
  const response = await fetch(`${serverUrl}/workbench/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const responseBody = await response.json().catch(() => ({}));
    throw new Error(responseBody.error || `请求失败：${response.status}`);
  }
  if (!response.body) throw new Error('Scout 流式响应不可用');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: ScoutStreamResult | null = null;
  const consume = (block: string) => {
    let eventType = 'message';
    let data = '';
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return;
    const payload = JSON.parse(data) as Record<string, unknown>;
    onEvent({ type: eventType, ...payload });
    if (eventType === 'result') result = payload as ScoutStreamResult;
    if (eventType === 'error') {
      const error = new Error(String(payload.message || 'Scout 分析失败')) as Error & { details?: Record<string, unknown> };
      error.details = payload;
      throw error;
    }
    if (eventType === 'cancelled') {
      const error = new Error(String(payload.message || 'Scout 已中断')) as Error & { name: string };
      error.name = 'ScoutCancelledError';
      throw error;
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || '';
      for (const block of blocks) consume(block);
      if (done) break;
    }
    if (buffer.trim()) consume(buffer);
  } finally {
    reader.releaseLock();
  }
  if (!result) throw new Error('Scout 流结束但未返回结果');
  return result;
}

export const workbenchApi = {
  status: () => request<WorkbenchStatus>('/status'),
  modelSettings: () => request<ScoutModelSettings>('/model-settings'),
  saveModelSettings: (config: {
    role?: 'scout' | 'reviewer';
    baseUrl: string;
    modelName: string;
    modelFamily: string;
    timeout: number;
    temperature: number;
    reasoningEnabled: boolean;
    apiKey: string;
  }) => request<ScoutModelSettings>('/model-settings', {
    method: 'PUT',
    body: JSON.stringify(config),
  }),
  review: (frameId: string) =>
    request<{ draft: Draft; issues: ValidationIssue[]; modelResultRef: string; reviewed: number; reviewerModel: string }>('/review', {
      method: 'POST',
      body: JSON.stringify({ frameId }),
    }),
  draft: () => request<{ draft: Draft; issues: ValidationIssue[] }>('/draft'),
  saveDraft: (draft: Draft) =>
    request<{ draft: Draft; issues: ValidationIssue[] }>('/draft', {
      method: 'PUT',
      body: JSON.stringify(draft),
    }),
  freezeFrame: () =>
    request<{ frame: FrameMetadata; draft: Draft }>('/frames', {
      method: 'POST',
      body: '{}',
    }),
  scout: (frameId: string, pageContext: string) =>
    request<{ draft: Draft; issues: ValidationIssue[]; modelResultRef: string }>('/scout', {
      method: 'POST',
      body: JSON.stringify({ frameId, pageContext }),
    }),
  scoutStream: async (
    frameId: string,
    pageContext: string,
    onEvent: (event: { type: string; [key: string]: unknown }) => void,
  ): Promise<ScoutStreamResult> => consumeScoutStream('/scout/stream', { frameId, pageContext }, onEvent),
  scoutSession: () => request<{ session: ScoutResumeSession | null }>('/scout/session'),
  resumeScoutStream: (
    sessionId: string,
    onEvent: (event: { type: string; [key: string]: unknown }) => void,
  ): Promise<ScoutStreamResult> => consumeScoutStream('/scout/resume/stream', { sessionId }, onEvent),
  cancelScout: () =>
    request<{ cancelled: boolean }>('/scout/cancel', { method: 'POST', body: '{}' }),
  prepareStaging: () =>
    request<StagingResult>('/staging', { method: 'POST', body: '{}' }),
  staging: (stageId: string) => request<StagingResult>(`/staging/${encodeURIComponent(stageId)}`),
  publish: (stageId: string) =>
    request<{ published: true; graphRevision: string; backupPath: string; explorationId: string }>('/publish', {
      method: 'POST',
      body: JSON.stringify({ stageId }),
    }),
};

export function absoluteAssetUrl(url: string): string {
  return new URL(url, serverUrl).toString();
}
