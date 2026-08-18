import type { AnalysisSession, CanonicalGraph, Draft, FrameMetadata, ModelTarget, PageUploadTask, ReasoningEffort, WorkerAvailableModels, WorkerElementMergeSelection, WorkerModelSettings, WorkerResult, WorkerResumeSession, StagingPublishResult, StagingResult, ValidationIssue, WorkbenchStatus } from './types';

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
    const error = new Error(body.error || `请求失败：${response.status}`) as Error & { details?: unknown };
    error.details = body;
    throw error;
  }
  return body as T;
}

async function binaryRequest<T>(path: string, options: RequestInit): Promise<T> {
  const response = await fetch(`${serverUrl}/workbench/api${path}`, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `请求失败：${response.status}`) as Error & { details?: Record<string, unknown> };
    error.details = body;
    throw error;
  }
  return body as T;
}

export type WorkerStreamResult = {
  frameId: string;
  worker: 'worker_a' | 'worker_b';
  workerResult: WorkerResult;
  modelResultRef: string;
  model: string | null;
  reasoningContent?: string;
  outputContent?: string;
  draft?: Draft;
  issues?: ValidationIssue[];
};

async function consumeWorkerStream(
  path: string,
  body: Record<string, unknown>,
  onEvent: (event: { type: string; [key: string]: unknown }) => void,
): Promise<WorkerStreamResult> {
  const response = await fetch(`${serverUrl}/workbench/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const responseBody = await response.json().catch(() => ({}));
    throw new Error(responseBody.error || `请求失败：${response.status}`);
  }
  if (!response.body) throw new Error('Worker 流式响应不可用');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: WorkerStreamResult | null = null;
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
    if (eventType === 'result') result = payload as WorkerStreamResult;
    if (eventType === 'error') {
      const error = new Error(String(payload.message || '模型分析失败')) as Error & { details?: Record<string, unknown> };
      error.details = payload;
      throw error;
    }
    if (eventType === 'cancelled') {
      const error = new Error(String(payload.message || '模型分析已中断')) as Error & { name: string; details?: Record<string, unknown> };
      error.name = 'AnalysisCancelledError';
      error.details = payload;
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
  if (!result) throw new Error('模型流结束但未返回结果');
  return result;
}

export const workbenchApi = {
  status: (workspaceSessionId?: string) => request<WorkbenchStatus>(`/status${workspaceSessionId ? `?workspaceSessionId=${encodeURIComponent(workspaceSessionId)}` : ''}`),
  knowledgeGraph: (appKey: string) => request<CanonicalGraph>(`/knowledge-graph?appKey=${encodeURIComponent(appKey)}`),
  modelSettings: () => request<WorkerModelSettings>('/model-settings'),
  availableModels: () => request<WorkerAvailableModels>('/model-settings/models'),
  saveModelSettings: (config: {
    target: ModelTarget;
    gatewayId: string;
    modelName: string;
    modelFamily: string;
    timeout: number;
    temperature: number;
    reasoningEffort: ReasoningEffort;
  }) => request<WorkerModelSettings>('/model-settings', { method: 'PUT', body: JSON.stringify(config) }),
  saveModelGateway: (gateway: { id: string; label: string; baseUrl: string; apiKey: string }) => request<WorkerModelSettings>(`/model-settings/gateways/${encodeURIComponent(gateway.id)}`, { method: 'PUT', body: JSON.stringify(gateway) }),
  deleteModelGateway: (gatewayId: string) => request<WorkerModelSettings & { deleted: true; gatewayId: string }>(`/model-settings/gateways/${encodeURIComponent(gatewayId)}`, { method: 'DELETE' }),
  sessions: () => request<{ sessions: AnalysisSession[] }>('/sessions'),
  draft: () => request<{ draft: Draft; issues: ValidationIssue[] }>('/draft'),
  saveDraft: (draft: Draft) => request<{ draft: Draft; issues: ValidationIssue[] }>('/draft', { method: 'PUT', body: JSON.stringify(draft) }),
  savePageDraft: (pageId: string, draft: Draft) => request<{ draft: Draft; issues: ValidationIssue[] }>(`/draft/pages/${encodeURIComponent(pageId)}`, { method: 'PUT', body: JSON.stringify(draft) }),
  pageUploads: () => request<{ tasks: PageUploadTask[] }>('/page-uploads'),
  createPageUploads: (items: Array<{ sourceType: 'file' | 'url'; name: string; mimeType?: string; size?: number; url?: string }>) => request<{ tasks: PageUploadTask[] }>('/page-uploads', { method: 'POST', body: JSON.stringify({ items }) }),
  uploadPageChunk: (taskId: string, chunk: Blob, offset: number, signal?: AbortSignal) => binaryRequest<{ task: PageUploadTask; draft?: Draft }>(`/page-uploads/${encodeURIComponent(taskId)}/chunk`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Offset': String(offset) },
    body: chunk,
    signal,
  }),
  processPageUpload: (taskId: string) => request<{ task: PageUploadTask; draft?: Draft }>(`/page-uploads/${encodeURIComponent(taskId)}/process`, { method: 'POST', body: '{}' }),
  deletePageUploads: (ids: string[], deletePages: boolean) => request<{ deletedIds: string[]; draft: Draft }>('/page-uploads', { method: 'DELETE', body: JSON.stringify({ ids, deletePages }) }),
  freezeFrame: (forceNewPage = false) => request<{ frame: FrameMetadata; draft: Draft }>('/frames', { method: 'POST', body: JSON.stringify({ forceNewPage }) }),
  workerAStream: (
    frameId: string,
    pageContext: string,
    mergeIntoDraft: boolean,
    onEvent: (event: { type: string; [key: string]: unknown }) => void,
    pageId?: string,
    workspaceSessionId?: string,
  ) => consumeWorkerStream('/workers/a/stream', { frameId, pageId, pageContext, mergeIntoDraft, workspaceSessionId }, onEvent),
  workerBStream: (
    frameId: string,
    pageContext: string,
    onEvent: (event: { type: string; [key: string]: unknown }) => void,
    pageId?: string,
    workspaceSessionId?: string,
  ) => consumeWorkerStream('/workers/b/stream', { frameId, pageId, pageContext, workspaceSessionId }, onEvent),
  workerASession: (workspaceSessionId?: string) => request<{ session: WorkerResumeSession | null }>(`/workers/a/session${workspaceSessionId ? `?workspaceSessionId=${encodeURIComponent(workspaceSessionId)}` : ''}`),
  workerBSession: (workspaceSessionId?: string) => request<{ session: WorkerResumeSession | null }>(`/workers/b/session${workspaceSessionId ? `?workspaceSessionId=${encodeURIComponent(workspaceSessionId)}` : ''}`),
  resumeWorkerAStream: (sessionId: string, workspaceSessionId: string, onEvent: (event: { type: string; [key: string]: unknown }) => void) =>
    consumeWorkerStream('/workers/a/resume/stream', { sessionId, workspaceSessionId }, onEvent),
  resumeWorkerBStream: (sessionId: string, workspaceSessionId: string, onEvent: (event: { type: string; [key: string]: unknown }) => void) =>
    consumeWorkerStream('/workers/b/resume/stream', { sessionId, workspaceSessionId }, onEvent),
  cancelWorkerA: (workspaceSessionId?: string) => request<{ cancelled: boolean }>('/workers/a/cancel', { method: 'POST', body: JSON.stringify({ workspaceSessionId }) }),
  cancelWorkerB: (workspaceSessionId?: string) => request<{ cancelled: boolean }>('/workers/b/cancel', { method: 'POST', body: JSON.stringify({ workspaceSessionId }) }),
  mergeWorkerResults: (payload: {
    frameId: string;
    pageId?: string;
    workerAResult: WorkerResult;
    workerBResult: WorkerResult;
    selections: WorkerElementMergeSelection[];
    modelResultRef: string;
  }) => request<{ draft: Draft; issues: ValidationIssue[] }>('/workers/merge', { method: 'POST', body: JSON.stringify(payload) }),
  prepareStaging: () => request<StagingResult>('/staging', { method: 'POST', body: '{}' }),
  stagingVersions: () => request<{ versions: StagingResult[] }>('/staging'),
  staging: (stageId: string) => request<StagingResult>(`/staging/${encodeURIComponent(stageId)}`),
  mergeStaging: (stageIds: string[]) => request<StagingResult>('/staging/merge', { method: 'POST', body: JSON.stringify({ stageIds }) }),
  deleteStaging: (stageId: string) => request<{ deleted: true; stageId: string }>(`/staging/${encodeURIComponent(stageId)}`, { method: 'DELETE' }),
  archiveStaging: (stageId: string) => request<StagingResult>(`/staging/${encodeURIComponent(stageId)}/archive`, { method: 'POST', body: '{}' }),
  rollbackStaging: (stageId: string) => request<StagingPublishResult>(`/staging/${encodeURIComponent(stageId)}/rollback`, { method: 'POST', body: '{}' }),
  publish: (stageId: string) => request<StagingPublishResult>('/publish', {
    method: 'POST',
    body: JSON.stringify({ stageId }),
  }),
};

export function absoluteAssetUrl(url: string): string {
  return new URL(url, serverUrl).toString();
}
