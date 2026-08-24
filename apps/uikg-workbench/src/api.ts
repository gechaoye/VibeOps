import type { AnalysisSession, CanonicalGraph, Draft, FrameMetadata, ModelTarget, PageUploadTask, ProjectModelData, ProjectModelDefinition, ReasoningEffort, WorkbenchMode, AvailableModels, UltraModelElementMergeSelection, ModelSettingsData, RecognitionResult, RecognitionResumeSession, StagingPublishResult, StagingResult, ValidationIssue, WorkbenchStatus } from './types';

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

export type RecognitionStreamResult = {
  frameId: string;
  target: 'manual' | 'ultra_a' | 'ultra_b';
  recognitionResult: RecognitionResult;
  modelResultRef: string;
  model: string | null;
  reasoningContent?: string;
  outputContent?: string;
  draft?: Draft;
  issues?: ValidationIssue[];
  analysisSessionId?: string;
};

async function consumeRecognitionStream(
  path: string,
  body: Record<string, unknown>,
  onEvent: (event: { type: string; [key: string]: unknown }) => void,
): Promise<RecognitionStreamResult> {
  let result: RecognitionStreamResult | null = null;
  let analysisSessionId = typeof body.analysisSessionId === 'string' ? body.analysisSessionId : '';
  let lastEventId = Number(body.lastEventId || 0) || 0;
  let reconnectAttempts = 0;
  let terminalError = false;
  const consume = (block: string) => {
    let eventType = 'message';
    let data = '';
    let eventId = 0;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('id:')) eventId = Number(line.slice(3).trim()) || 0;
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return;
    const payload = JSON.parse(data) as Record<string, unknown>;
    if (eventId) lastEventId = Math.max(lastEventId, eventId);
    if (typeof payload.analysisSessionId === 'string') analysisSessionId = payload.analysisSessionId;
    onEvent({ type: eventType, ...payload });
    if (eventType === 'result') result = payload as RecognitionStreamResult;
    if (eventType === 'error') {
      terminalError = true;
      const error = new Error(String(payload.message || '模型分析失败')) as Error & { details?: Record<string, unknown> };
      error.details = payload;
      throw error;
    }
    if (eventType === 'cancelled') {
      terminalError = true;
      const error = new Error(String(payload.message || '模型分析已中断')) as Error & { name: string; details?: Record<string, unknown> };
      error.name = 'AnalysisCancelledError';
      error.details = payload;
      throw error;
    }
  };

  while (!result) {
    try {
      const response = await fetch(`${serverUrl}/workbench/api${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...(lastEventId ? { 'Last-Event-ID': String(lastEventId) } : {}),
        },
        body: JSON.stringify({ ...body, ...(analysisSessionId ? { analysisSessionId } : {}), ...(lastEventId ? { lastEventId } : {}) }),
      });
      if (!response.ok) {
        const responseBody = await response.json().catch(() => ({}));
        // A stale reconnect token is terminal. Retrying it only creates a
        // noisy request loop after the server has already ended the session.
        if (response.status === 404 || response.status === 409 || response.status === 410) terminalError = true;
        throw new Error(responseBody.error || `请求失败：${response.status}`);
      }
      analysisSessionId = response.headers.get('X-Analysis-Session-Id') || analysisSessionId;
      if (!response.body) throw new Error('模型流式响应不可用');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
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
      if (result) break;
      throw new Error('模型流连接提前结束');
    } catch (error) {
      if (result || terminalError || reconnectAttempts >= 5 || !analysisSessionId) throw error;
      reconnectAttempts += 1;
      onEvent({ type: 'stage', phase: 'reconnecting', message: `流连接中断，正在重新连接（${reconnectAttempts}/5）`, analysisSessionId });
      await new Promise((resolve) => window.setTimeout(resolve, Math.min(3000, reconnectAttempts * 500)));
    }
  }
  if (!result) throw new Error('模型流结束但未返回结果');
  return result;
}

export const workbenchApi = {
  status: (workspaceSessionId?: string) => request<WorkbenchStatus>(`/status${workspaceSessionId ? `?workspaceSessionId=${encodeURIComponent(workspaceSessionId)}` : ''}`),
  knowledgeGraph: (appKey: string) => request<CanonicalGraph>(`/knowledge-graph?appKey=${encodeURIComponent(appKey)}`),
  projectModel: (projectKey = 'baohe') => request<ProjectModelData>(`/project-model?project=${encodeURIComponent(projectKey)}`),
  saveProjectModel: (model: ProjectModelDefinition, projectKey = 'baohe') => request<ProjectModelData>(`/project-model?project=${encodeURIComponent(projectKey)}`, { method: 'PUT', body: JSON.stringify({ model }) }),
  modelSettings: () => request<ModelSettingsData>('/model-settings'),
  availableModels: () => request<AvailableModels>('/model-settings/models'),
  saveModelSettings: (config: {
    target: ModelTarget;
    gatewayId: string;
    modelName: string;
    modelFamily: string;
    timeout: number;
    temperature: number;
    reasoningEffort: ReasoningEffort;
  }) => request<ModelSettingsData>('/model-settings', { method: 'PUT', body: JSON.stringify(config) }),
  createModelGateway: (gateway: { label: string; baseUrl: string; apiKey: string }) => request<ModelSettingsData>('/model-settings/gateways', { method: 'POST', body: JSON.stringify(gateway) }),
  saveModelGateway: (gatewayId: string, gateway: { label: string; baseUrl: string; apiKey: string }) => request<ModelSettingsData>(`/model-settings/gateways/${encodeURIComponent(gatewayId)}`, { method: 'PUT', body: JSON.stringify(gateway) }),
  resetDefaultModelGateway: () => request<ModelSettingsData>('/model-settings/gateways/zto-newapi/reset', { method: 'POST' }),
  testModelGateway: (gatewayId: string) => request<{ gatewayId: string; ok: boolean; latencyMs: number; modelCount: number }>(`/model-settings/gateways/${encodeURIComponent(gatewayId)}/test`, { method: 'POST' }),
  saveModelMode: (mode: WorkbenchMode) => request<ModelSettingsData>('/model-settings/mode', { method: 'PUT', body: JSON.stringify({ mode }) }),
  deleteModelGateway: (gatewayId: string) => request<ModelSettingsData & { deleted: true; gatewayId: string; clearedTargets: ModelTarget[] }>(`/model-settings/gateways/${encodeURIComponent(gatewayId)}`, { method: 'DELETE' }),
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
  freezeFrame: (forceNewPage = false, collectRuntimeStructure = true) => request<{ frame: FrameMetadata; draft: Draft }>('/frames', { method: 'POST', body: JSON.stringify({ forceNewPage, collectRuntimeStructure }) }),
  frame: (frameId: string) => request<{ frame: FrameMetadata }>(`/frames/${encodeURIComponent(frameId)}`),
  recognitionStream: (
    target: 'manual' | 'ultra_a' | 'ultra_b',
    frameId: string,
    pageContext: string,
    mergeIntoDraft: boolean,
    onEvent: (event: { type: string; [key: string]: unknown }) => void,
    pageId?: string,
    workspaceSessionId?: string,
    includeUiTree = true,
  ) => consumeRecognitionStream(`/recognition/${target}/stream`, { frameId, pageId, pageContext, mergeIntoDraft, workspaceSessionId, includeUiTree }, onEvent),
  recognitionSession: (target: 'manual' | 'ultra_a' | 'ultra_b', workspaceSessionId?: string) => request<{ session: RecognitionResumeSession | null }>(`/recognition/${target}/session${workspaceSessionId ? `?workspaceSessionId=${encodeURIComponent(workspaceSessionId)}` : ''}`),
  reconnectRecognitionStream: (target: 'manual' | 'ultra_a' | 'ultra_b', analysisSessionId: string, lastEventId: number, onEvent: (event: { type: string; [key: string]: unknown }) => void) =>
    consumeRecognitionStream(`/recognition/${target}/stream`, { analysisSessionId, lastEventId }, onEvent),
  resumeRecognitionStream: (target: 'manual' | 'ultra_a' | 'ultra_b', sessionId: string, workspaceSessionId: string, onEvent: (event: { type: string; [key: string]: unknown }) => void) =>
    consumeRecognitionStream(`/recognition/${target}/resume/stream`, { sessionId, workspaceSessionId }, onEvent),
  cancelRecognition: (target: 'manual' | 'ultra_a' | 'ultra_b', workspaceSessionId: string) => request<{ cancelled: boolean }>(`/recognition/${target}/cancel`, { method: 'POST', body: JSON.stringify({ workspaceSessionId }) }),
  applyRecognitionResult: (payload: {
    frameId: string;
    pageId: string;
    recognitionResult: RecognitionResult;
    modelResultRef: string;
    model: string | null;
  }) => request<{ draft: Draft; issues: ValidationIssue[] }>('/recognition/apply', { method: 'POST', body: JSON.stringify(payload) }),
  mergeUltraModelResults: (payload: {
    frameId: string;
    pageId?: string;
    modelAResult: RecognitionResult;
    modelBResult: RecognitionResult;
    selections: UltraModelElementMergeSelection[];
    modelResultRef: string;
    replaceExisting?: boolean;
  }) => request<{ draft: Draft; issues: ValidationIssue[] }>('/recognition/ultra/merge', { method: 'POST', body: JSON.stringify(payload) }),
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
