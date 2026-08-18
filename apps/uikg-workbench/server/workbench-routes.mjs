import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import express from 'express';
import { imageSize } from 'image-size';
import {
  beginFrameCapture,
  mergeWorkerIntoDraft,
  normalizeDraftForSave,
  normalizeWorkerOutput,
  prepareWorkerForDraft,
  removePagesFromDraft,
  validateDraft,
  validateWorkerConsistency,
} from './draft-model.mjs';
import { deleteModelGateway, fetchAvailableModelsByGateway, loadModelGateways, loadTargetModelSettings, MODEL_TARGETS, resolveTargetModelConfig, saveModelGateway, saveTargetModelSettings } from './model-settings.mjs';
import { reasoningBudgetForModel } from './model-compatibility.mjs';
import { getModelRuntime, setModelRuntime } from './model-runtime.mjs';
import { recoverWorkerCheckpointFromStream, runResumableWorker, WORKER_ERROR_RETRY_LIMIT } from './resumable-worker.mjs';
import { runWorkerModel } from './worker-client.mjs';
import { buildWorkerContinuationPrompt, buildWorkerPrompt } from './worker-prompt.mjs';
import { canonicalFullPageAssetPath, loadCanonicalGraph } from './canonical-graph.mjs';

const MAX_PAGE_UPLOAD_BATCH = 20;
const MAX_PAGE_IMAGE_BYTES = 25 * 1024 * 1024;

function imageBufferPayload(buffer, mimeType = '') {
  let dimensions;
  try {
    dimensions = imageSize(buffer);
  } catch {
    throw workbenchError(415, '图片文件损坏或格式无法识别');
  }
  const detected = dimensions.type === 'jpg' ? 'jpeg' : dimensions.type;
  if (!['jpeg', 'png', 'webp'].includes(detected)) {
    throw workbenchError(415, '仅支持 PNG、JPEG 或 WebP 图片');
  }
  return {
    buffer,
    mimeType: `image/${detected}`,
    extension: detected === 'jpeg' ? 'jpg' : detected,
    width: dimensions.width,
    height: dimensions.height,
  };
}

function imagePayload(base64) {
  const match = String(base64).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
  return imageBufferPayload(Buffer.from(match?.[2] || base64, 'base64'), match?.[1] || 'image/png');
}

function hashFrame(buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

function workbenchError(status, message, details = {}) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

async function freezeAndCapture(agent) {
  await agent.unfreezePageContext();
  await agent.freezePageContext();
  const context = await agent._snapshotContext();
  const image = imagePayload(context.screenshot.base64);
  return {
    ...image,
    frameId: hashFrame(image.buffer),
    capturedAt: new Date(context.screenshot.capturedAt).toISOString(),
  };
}

export async function registerWorkbenchRoutes({ server, store, modelStore, graphWorkflow, workbenchRoot, spec }) {
  const router = express.Router();
  router.use(express.json({ limit: '50mb' }));
  const schema = JSON.parse(await readFile(path.join(workbenchRoot, 'server', 'worker-output.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validateWorkerSchema = ajv.compile(schema);
  const activeWorkerA = new Map();
  const activeWorkerB = new Map();
  const resumableWorkerA = new Map();
  const resumableWorkerB = new Map();
  let loadedModelRuntimeSignature = null;
  let uploadDraftQueue = Promise.resolve();
  let annotationDraftQueue = Promise.resolve();
  const activePageUploadControllers = new Map();
  const deletedPageUploadIds = new Set();
  const workspaceSessionKey = (value) => String(value || 'default').trim().slice(0, 160) || 'default';
  const workersInProgress = () => activeWorkerA.size > 0 || activeWorkerB.size > 0;
  const queueAnnotationDraftMutation = (operation) => {
    const run = annotationDraftQueue.then(operation, operation);
    annotationDraftQueue = run.catch(() => {});
    return run;
  };

  const selectDraftPage = (draft, pageId, frameId) => {
    const page = draft.pages.find((candidate) => candidate.id === pageId);
    if (!page) return null;
    const selectedFrameId = frameId === null
      ? null
      : frameId && page.frameIds.includes(frameId) ? frameId : page.frameIds.at(-1) || null;
    return {
      ...draft,
      currentPageId: page.id,
      currentFrameId: selectedFrameId,
      page: {
        id: page.id,
        key: page.key,
        name: page.name,
        surfaceType: page.surfaceType,
        stateSummary: page.stateSummary,
        scrollableRegions: page.scrollableRegions,
      },
    };
  };

  const mergeAnnotationPage = (current, incoming, pageId) => {
    const incomingPage = incoming.pages?.find((page) => page.id === pageId);
    if (!incomingPage) throw workbenchError(400, '标注草稿中缺少目标 Page');
    if (!current.pages.some((page) => page.id === pageId)) throw workbenchError(404, '目标 Page 不存在或已被删除');

    const incomingElements = (incoming.elements || []).filter((element) => element.pageId === pageId || element.availableOnPageIds?.includes(pageId));
    const incomingById = new Map(incomingElements.map((element) => [element.id, element]));
    const mergedElements = current.elements
      .filter((element) => element.pageId !== pageId)
      .map((element) => incomingById.get(element.id) || element);
    const retainedIds = new Set(mergedElements.map((element) => element.id));
    for (const element of incomingElements) if (!retainedIds.has(element.id)) mergedElements.push(element);

    const affectedElementIds = new Set([
      ...current.elements.filter((element) => element.pageId === pageId).map((element) => element.id),
      ...incomingElements.map((element) => element.id),
    ]);
    const incomingTransitions = (incoming.transitions || []).filter((transition) => transition.sourcePageId === pageId || transition.targetPageId === pageId);
    const incomingRecords = (incoming.elementEditRecords || []).filter((record) => affectedElementIds.has(record.elementId));
    const pages = current.pages.map((page) => page.id === pageId ? incomingPage : page);
    const currentPage = pages.find((page) => page.id === current.currentPageId) || incomingPage;
    return normalizeDraftForSave({
      ...current,
      revision: current.revision + 1,
      pages,
      elements: mergedElements,
      transitions: [
        ...current.transitions.filter((transition) => transition.sourcePageId !== pageId && transition.targetPageId !== pageId),
        ...incomingTransitions,
      ],
      elementEditRecords: [
        ...current.elementEditRecords.filter((record) => !affectedElementIds.has(record.elementId)),
        ...incomingRecords,
      ],
      rawModelResultRef: incoming.rawModelResultRef,
      lastWorkerModel: incoming.lastWorkerModel,
      currentPageId: currentPage.id,
      currentFrameId: currentPage.frameIds.includes(current.currentFrameId) ? current.currentFrameId : currentPage.frameIds.at(-1) || null,
      page: currentPage,
      updatedAt: new Date().toISOString(),
    });
  };
  const syncModelRuntime = async () => {
    if (!modelStore) return false;
    const configs = Object.fromEntries(MODEL_TARGETS.map((target) => [target, resolveTargetModelConfig(modelStore, target)]));
    const signature = JSON.stringify(configs);
    if (signature === loadedModelRuntimeSignature) return false;
    for (const target of MODEL_TARGETS) {
      if (configs[target]) setModelRuntime(target, configs[target]);
    }
    const midscene = configs.midscene;
    if (midscene) {
      const mappings = {
        MIDSCENE_MODEL_BASE_URL: midscene.baseUrl,
        MIDSCENE_MODEL_API_KEY: midscene.apiKey,
        MIDSCENE_MODEL_NAME: midscene.modelName,
        MIDSCENE_MODEL_FAMILY: midscene.modelFamily,
        MIDSCENE_MODEL_TIMEOUT: String(midscene.timeout),
        MIDSCENE_MODEL_TEMPERATURE: String(midscene.temperature),
        MIDSCENE_MODEL_REASONING_EFFORT: midscene.reasoningEffort,
        MIDSCENE_MODEL_REASONING_ENABLED: 'true',
        MIDSCENE_MODEL_REASONING_BUDGET: String(reasoningBudgetForModel(midscene.modelName, midscene.reasoningEffort) || ''),
      };
      Object.assign(process.env, mappings);
    }
    server.agent?.modelConfigManager?.clearModelConfigMap();
    loadedModelRuntimeSignature = signature;
    return true;
  };

  const loadCombinedModelSettings = () => ({
    workerA: loadTargetModelSettings(modelStore, 'worker_a'),
    workerB: loadTargetModelSettings(modelStore, 'worker_b'),
    midscene: loadTargetModelSettings(modelStore, 'midscene'),
    gateways: loadModelGateways(modelStore),
  });

  router.get('/knowledge-graph', async (req, res, next) => {
    try {
      res.json(await loadCanonicalGraph({
        graphRoot: graphWorkflow.graphRoot,
        yaml: graphWorkflow.yaml,
        appKey: req.query.appKey || 'zto.connect',
      }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/knowledge-graph/assets/:appKey/full-pages/:frameRef', async (req, res, next) => {
    try {
      const imagePath = canonicalFullPageAssetPath({
        graphRoot: graphWorkflow.graphRoot,
        appKey: req.params.appKey,
        frameRef: req.params.frameRef,
      });
      res.type('png').sendFile(imagePath);
    } catch (error) {
      next(error);
    }
  });

  const queueUploadDraftMutation = (operation) => {
    const run = uploadDraftQueue.then(operation, operation);
    uploadDraftQueue = run.catch(() => {});
    return run;
  };

  const loadPageUploadTask = async (taskId) => {
    try {
      return await store.loadPageUploadTask(taskId);
    } catch (error) {
      if (error?.code === 'ENOENT') throw workbenchError(404, '上传任务不存在或已删除');
      throw error;
    }
  };

  const updatePageUploadTask = async (task, patch) => store.savePageUploadTask({
    ...task,
    ...patch,
    updatedAt: new Date().toISOString(),
  });

  const failPageUploadTask = async (task, error) => updatePageUploadTask(task, {
    status: 'failed',
    errorReason: error instanceof Error ? error.message : String(error),
  });

  const finalizePageUpload = async (task) => {
    if (deletedPageUploadIds.has(task.id)) throw workbenchError(410, '上传任务已删除');
    const buffer = await store.loadPageUploadBuffer(task.id);
    if (buffer.length > MAX_PAGE_IMAGE_BYTES) throw workbenchError(413, '单张图片不能超过 25 MB');
    if (task.totalBytes && buffer.length !== task.totalBytes) {
      throw workbenchError(409, `图片尚未上传完整：${buffer.length}/${task.totalBytes} 字节`);
    }
    const image = imageBufferPayload(buffer, task.mimeType);
    const frame = {
      ...image,
      frameId: hashFrame(buffer),
      capturedAt: new Date().toISOString(),
    };
    const metadata = await store.saveFrame(frame);
    const draft = await queueUploadDraftMutation(async () => {
      if (deletedPageUploadIds.has(task.id)) throw workbenchError(410, '上传任务已删除');
      const currentDraft = await store.loadDraft();
      const nextDraft = beginFrameCapture(currentDraft, frame.frameId, { forceNewPage: true });
      await store.saveDraft(nextDraft);
      return nextDraft;
    });
    if (deletedPageUploadIds.has(task.id)) throw workbenchError(410, '上传任务已删除');
    const completedTask = await updatePageUploadTask(task, {
      status: 'completed',
      uploadedBytes: buffer.length,
      totalBytes: buffer.length,
      mimeType: metadata.mimeType,
      frameId: metadata.frameId,
      pageId: draft.currentPageId,
      errorReason: null,
    });
    return { task: completedTask, draft };
  };

  const persistAnalysisSession = async (session) => {
    if (typeof store.saveAnalysisSession !== 'function') return;
    try {
      await store.saveAnalysisSession(session);
    } catch {
      // Session history must never hide the model result or its error.
    }
  };

  const inspectWorkerResult = (candidate) => {
    const { workerResult: normalizedResult, normalizationIssues } = normalizeWorkerOutput(candidate);
    const schemaValid = validateWorkerSchema(normalizedResult);
    const schemaErrors = structuredClone(validateWorkerSchema.errors || []);
    return { normalizedResult, normalizationIssues, schemaValid, schemaErrors };
  };

  const publicWorkerSession = (session, includeStreams = false) => session ? {
    id: session.id,
    status: 'paused',
    frameId: session.frameId,
    pageId: session.pageId || null,
    pageContext: session.pageContext,
    model: session.model,
    completedCandidates: session.completedCandidates,
    retryAttempts: session.retryAttempts,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    errorMessage: session.errorMessage,
    ...(includeStreams ? {
      reasoningContent: session.reasoningContent,
      outputContent: session.outputContent,
    } : {}),
  } : null;

  async function executeWorker({ worker, frameId, pageId = null, pageContext = '', mergeIntoDraft = false, signal, onProgress = () => {}, resumeSession = null, workspaceSessionId = 'default' }) {
    const label = worker === 'worker_a' ? 'Worker A' : 'Worker B';
    await syncModelRuntime();
    const runtime = getModelRuntime(worker);
    const model = runtime?.modelName || null;
    const setResumable = (value) => {
      const sessions = worker === 'worker_a' ? resumableWorkerA : resumableWorkerB;
      if (value) sessions.set(workspaceSessionId, value);
      else sessions.delete(workspaceSessionId);
    };
    const modelResultId = `${worker}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const sessionStartedAt = resumeSession?.createdAt || new Date().toISOString();
    let rawResult = null;
    let modelStarted = false;
    let resultSaved = false;
    let retryAttempts = [];
    let reasoningContent = resumeSession?.reasoningContent || '';
    let outputContent = resumeSession?.outputContent || '';
    let sessionStatus = 'running';
    let sessionError = null;
    const emitProgress = (event) => {
      if (event.type === 'chunk') {
        reasoningContent += event.reasoningContent || '';
        outputContent += event.content || '';
      }
      onProgress(event);
    };
    try {
      await persistAnalysisSession({
        id: modelResultId,
        kind: worker,
        status: sessionStatus,
        frameId: frameId || null,
        pageId: pageId || null,
        model,
        startedAt: sessionStartedAt,
        updatedAt: new Date().toISOString(),
        reasoningContent,
        outputContent,
      });
      emitProgress({ type: 'stage', phase: 'validate', message: '正在校验页面截图' });
      if (!model) {
        throw workbenchError(503, `未配置 ${label} 模型，请在模型配置页面完成指派`);
      }
      if (!frameId) throw workbenchError(400, '缺少 frameId');
      const frozenFrame = await store.loadFrame(frameId);
      signal?.throwIfAborted();

      const startedAt = sessionStartedAt;
      modelStarted = true;
      emitProgress({
        type: 'stage',
        phase: resumeSession ? 'resume' : 'model',
        message: resumeSession ? `正在从已保存断点继续 ${label}` : `${label} 正在分析画面`,
      });
      setResumable(null);
      const run = await runResumableWorker({
        initialPrompt: buildWorkerPrompt(frameId, pageContext),
        initialResult: resumeSession?.rawResult,
        initialFallback: { frameId, elements: [] },
        callWorker: async (prompt, attempt) => {
          let accumulated = '';
          try {
            const onChunk = (chunk) => {
              accumulated = chunk.accumulated || accumulated;
              emitProgress({
                type: 'chunk',
                content: chunk.content || '',
                reasoningContent: chunk.reasoning_content || '',
              });
            };
            const workerRunner = typeof server.runWorkerModel === 'function' ? server.runWorkerModel : runWorkerModel;
            return await workerRunner({
              worker,
              prompt,
              imagePath: frozenFrame.imagePath,
              mimeType: frozenFrame.mimeType,
              responseSchema: schema,
              continuation: attempt.continuation,
              signal: attempt.signal,
              onChunk,
            });
          } catch (error) {
            const recovered = recoverWorkerCheckpointFromStream(accumulated);
            if (error && typeof error === 'object') {
              error.workerCheckpoint = recovered;
              error.receivedContent = Boolean(accumulated.trim());
            }
            throw error;
          }
        },
        buildContinuationPrompt: (checkpoint, attempt) => buildWorkerContinuationPrompt(frameId, pageContext, checkpoint, attempt),
        isComplete: (candidate) => inspectWorkerResult(candidate).schemaValid,
        signal,
        onRetry: ({ attempt, retryLimit, checkpoint }) => emitProgress({
          type: 'stage',
          phase: 'retry',
          message: `正在重试：${attempt}/${retryLimit}`,
          attempt,
          retryLimit,
          completedCandidates: checkpoint.completedCandidates.length,
        }),
      });
      rawResult = run.rawResult;
      retryAttempts = run.retryAttempts;
      signal?.throwIfAborted();

      emitProgress({ type: 'stage', phase: 'normalize', message: '正在归一化并校验模型输出' });
      const { normalizedResult, normalizationIssues, schemaValid, schemaErrors } = inspectWorkerResult(rawResult);
      const consistencyIssues = schemaValid ? validateWorkerConsistency(normalizedResult) : [];
      const blockingConsistencyIssues = consistencyIssues.filter((issue) => issue.startsWith('候选键重复'));
      const record = {
        recordType: 'WorkbenchWorkerResult',
        modelResultId,
        frameId,
        startedAt,
        completedAt: new Date().toISOString(),
        worker,
        model,
        frameIntegrity: frozenFrame.frameId === frameId,
        schemaValid,
        schemaErrors,
        normalizationIssues,
        consistencyIssues,
        continuationCompleted: run.completed,
        retryAttempts,
        initialError: run.initialError,
        rawResult,
        normalizedResult,
      };
      const resultPath = await store.saveModelResult(modelResultId, record);
      resultSaved = true;
      const modelResultRef = path.relative(workbenchRoot, resultPath).split(path.sep).join('/');

      if (run.lastError) {
        const resumableSession = {
          id: modelResultId,
          workspaceSessionId,
          frameId,
          pageId,
          pageContext,
          worker,
          model,
          rawResult,
          completedCandidates: Array.isArray(rawResult?.elements) ? rawResult.elements.length : 0,
          retryAttempts,
          createdAt: sessionStartedAt,
          updatedAt: new Date().toISOString(),
          errorMessage: run.lastError,
          reasoningContent,
          outputContent,
          mergeIntoDraft,
        };
        setResumable(resumableSession);
        throw workbenchError(502, run.lastError, {
          modelResultRef,
          retryLimit: WORKER_ERROR_RETRY_LIMIT,
          retryAttempts,
          completedCandidates: Array.isArray(rawResult?.elements) ? rawResult.elements.length : 0,
          resumableSession: publicWorkerSession(resumableSession, true),
        });
      }
      if (!schemaValid || !run.completed || blockingConsistencyIssues.length > 0) {
        throw workbenchError(422, `${label} 输出未通过结构检查，原始结果已保留`, {
          modelResultRef,
          schemaErrors,
          consistencyIssues,
        });
      }
      setResumable(null);
      if (normalizedResult.frameId !== frameId) {
        throw workbenchError(422, `${label} 返回的 frameId 与冻结帧不一致`, { modelResultRef });
      }
      signal?.throwIfAborted();

      let draft;
      let issues;
      if (mergeIntoDraft) {
        emitProgress({ type: 'stage', phase: 'merge', message: '正在合并候选元素到草稿' });
        draft = await queueAnnotationDraftMutation(async () => {
          const currentDraft = await store.loadDraft();
          const pageDraft = pageId ? selectDraftPage(currentDraft, pageId, frameId) || currentDraft : currentDraft;
          const merged = mergeWorkerIntoDraft(pageDraft, prepareWorkerForDraft(normalizedResult), modelResultRef, model);
          await store.saveDraft(merged);
          return merged;
        });
        issues = validateDraft(draft);
        signal?.throwIfAborted();
      }
      emitProgress({ type: 'stage', phase: 'complete', message: `${label} 分析完成` });
      sessionStatus = 'completed';
      return { frameId, worker, workerResult: normalizedResult, modelResultRef, model, reasoningContent, outputContent, ...(draft ? { draft, issues } : {}) };
    } catch (error) {
      if (signal?.aborted && (!error || typeof error !== 'object')) error = new Error(`用户中断 ${label}`);
      sessionStatus = signal?.aborted ? 'cancelled' : 'failed';
      sessionError = signal?.aborted ? `用户中断 ${label}` : error instanceof Error ? error.message : String(error);
      if (signal?.aborted) {
        const rawCheckpoint = error && typeof error === 'object'
          ? error.workerRawResult || recoverWorkerCheckpointFromStream(outputContent)
          : recoverWorkerCheckpointFromStream(outputContent);
        const rawResultForResume = rawCheckpoint || { frameId, elements: [] };
        const resumableSession = {
          id: modelResultId,
          workspaceSessionId,
          frameId,
          pageId,
          pageContext,
          worker,
          model,
          rawResult: rawResultForResume,
          completedCandidates: Array.isArray(rawResultForResume?.elements) ? rawResultForResume.elements.length : 0,
          retryAttempts,
          createdAt: sessionStartedAt,
          updatedAt: new Date().toISOString(),
          errorMessage: sessionError,
          reasoningContent,
          outputContent,
          mergeIntoDraft,
        };
        setResumable(resumableSession);
        if (error && typeof error === 'object') {
          error.details = {
            ...(error.details || {}),
            resumableSession: publicWorkerSession(resumableSession, true),
          };
        }
      }
      if (modelStarted && !resultSaved) {
        try {
          const resultPath = await store.saveModelResult(modelResultId, {
            recordType: signal?.aborted ? 'WorkbenchWorkerCancellation' : 'WorkbenchWorkerFailure',
            modelResultId,
            frameId: frameId || null,
            completedAt: new Date().toISOString(),
            worker,
            model,
            error: signal?.aborted ? `用户中断 ${label}` : error instanceof Error ? error.message : String(error),
          });
          if (error && typeof error === 'object') {
            error.details = {
              ...(error.details || {}),
              modelResultRef: path.relative(workbenchRoot, resultPath).split(path.sep).join('/'),
            };
          }
        } catch {}
      }
      throw error;
    } finally {
      await persistAnalysisSession({
        id: modelResultId,
        kind: worker,
        status: sessionStatus,
        frameId: frameId || null,
        pageId: pageId || null,
        model,
        startedAt: sessionStartedAt,
        updatedAt: new Date().toISOString(),
        errorMessage: sessionError,
        reasoningContent,
        outputContent,
        retryAttempts,
      });
    }
  }

  function beginWorkerASession(workspaceSessionId = 'default') {
    if (activeWorkerA.has(workspaceSessionId)) throw workbenchError(409, '当前标签页已有 Worker A 分析正在运行');
    const session = { id: randomUUID(), workspaceSessionId, controller: new AbortController() };
    activeWorkerA.set(workspaceSessionId, session);
    return session;
  }

  function endWorkerASession(session) {
    if (activeWorkerA.get(session.workspaceSessionId)?.id !== session.id) return;
    activeWorkerA.delete(session.workspaceSessionId);
  }

  function beginWorkerBSession(workspaceSessionId = 'default') {
    if (activeWorkerB.has(workspaceSessionId)) throw workbenchError(409, '当前标签页已有 Worker B 分析正在运行');
    const session = { id: randomUUID(), workspaceSessionId, controller: new AbortController() };
    activeWorkerB.set(workspaceSessionId, session);
    return session;
  }

  function endWorkerBSession(session) {
    if (activeWorkerB.get(session.workspaceSessionId)?.id !== session.id) return;
    activeWorkerB.delete(session.workspaceSessionId);
  }

  server.app.use((req, res, next) => {
    if (workersInProgress() && req.path === '/interact') {
      return res.status(423).json({ error: 'AI 正在分析冻结帧，设备操作已临时锁定' });
    }
    next();
  });

  router.get('/status', async (req, res, next) => {
    try {
      await syncModelRuntime();
      const session = server.getSessionState?.() || null;
      res.json({
        ok: true,
        agentConnected: Boolean(server.agent),
        workersRunning: workersInProgress(),
        workerAConfigured: Boolean(getModelRuntime('worker_a')?.modelName),
        workerAModel: getModelRuntime('worker_a')?.modelName || null,
        workerBConfigured: Boolean(getModelRuntime('worker_b')?.modelName),
        workerBModel: getModelRuntime('worker_b')?.modelName || null,
        workerASession: publicWorkerSession(resumableWorkerA.get(workspaceSessionKey(req.query.workspaceSessionId))),
        workerBSession: publicWorkerSession(resumableWorkerB.get(workspaceSessionKey(req.query.workspaceSessionId))),
        spec,
        session,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/workers/a/session', (req, res) => {
    res.json({ session: publicWorkerSession(resumableWorkerA.get(workspaceSessionKey(req.query.workspaceSessionId)), true) });
  });

  router.get('/workers/b/session', (req, res) => {
    res.json({ session: publicWorkerSession(resumableWorkerB.get(workspaceSessionKey(req.query.workspaceSessionId)), true) });
  });

  router.get('/sessions', async (_req, res, next) => {
    try {
      const sessions = typeof store.listAnalysisSessions === 'function' ? await store.listAnalysisSessions() : [];
      res.json({ sessions });
    } catch (error) {
      next(error);
    }
  });

  router.get('/model-settings', async (_req, res, next) => {
    try {
      await syncModelRuntime();
      res.json(await loadCombinedModelSettings());
    } catch (error) {
      next(error);
    }
  });

  router.get('/model-settings/models', async (_req, res, next) => {
    try {
      await syncModelRuntime();
      res.json(await fetchAvailableModelsByGateway(modelStore));
    } catch (error) {
      next(error);
    }
  });

  router.put('/model-settings', async (req, res, next) => {
    try {
      if (workersInProgress()) return res.status(409).json({ error: 'AI 分析正在运行，结束后才能切换模型' });
      saveTargetModelSettings(modelStore, req.body);
      let runtimeReloaded = true;
      try {
        await syncModelRuntime();
      } catch {
        runtimeReloaded = false;
      }
      res.json({ ...await loadCombinedModelSettings(), runtimeReloaded });
    } catch (error) {
      next(error);
    }
  });

  router.put('/model-settings/gateways/:gatewayId', async (req, res, next) => {
    try {
      if (workersInProgress()) return res.status(409).json({ error: 'AI 分析正在运行，结束后才能修改模型网关' });
      saveModelGateway(modelStore, { ...req.body, id: req.params.gatewayId });
      await syncModelRuntime();
      res.json(loadCombinedModelSettings());
    } catch (error) {
      next(error);
    }
  });

  router.delete('/model-settings/gateways/:gatewayId', async (req, res, next) => {
    try {
      if (workersInProgress()) return res.status(409).json({ error: 'AI 分析正在运行，结束后才能移除模型网关' });
      const deleted = deleteModelGateway(modelStore, req.params.gatewayId);
      res.json({ ...loadCombinedModelSettings(), ...deleted });
    } catch (error) {
      next(error);
    }
  });

  router.post('/device/tap', async (req, res, next) => {
    try {
      if (workersInProgress()) return res.status(423).json({ error: 'AI 正在分析冻结帧，设备操作已临时锁定' });
      if (!server.agent) return res.status(409).json({ error: '请先连接 Android 设备' });
      const x = Number(req.body?.x);
      const y = Number(req.body?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
        return res.status(400).json({ error: '点击坐标无效' });
      }
      const device = server.agent.interface;
      if (typeof device.getAdb === 'function' && typeof device.adjustCoordinates === 'function') {
        const adb = await device.getAdb();
        const adjusted = await device.adjustCoordinates(Math.round(x), Math.round(y));
        const displayArg = typeof device.getDisplayArg === 'function' ? device.getDisplayArg() : '';
        await adb.shell(`input${displayArg} tap ${Math.round(adjusted.x)} ${Math.round(adjusted.y)}`);
      } else {
        const tap = device.inputPrimitives?.pointer?.tap;
        if (!tap) return res.status(404).json({ error: '当前设备不支持直接点击' });
        await tap({ x: Math.round(x), y: Math.round(y) });
      }
      res.json({});
    } catch (error) {
      next(error);
    }
  });

  router.get('/draft', async (_req, res, next) => {
    try {
      const draft = await store.loadDraft();
      res.json({ draft, issues: validateDraft(draft) });
    } catch (error) {
      next(error);
    }
  });

  router.put('/draft', async (req, res, next) => {
    try {
      const current = await store.loadDraft();
      if (req.body?.revision !== current.revision) {
        return res.status(409).json({ error: '草稿已被其他修改更新，请刷新后重试', current });
      }
      const nextDraft = normalizeDraftForSave({
        ...req.body,
        revision: current.revision + 1,
      });
      const issues = validateDraft(nextDraft);
      await store.saveDraft(nextDraft);
      res.json({ draft: nextDraft, issues });
    } catch (error) {
      next(error);
    }
  });

  router.put('/draft/pages/:pageId', async (req, res, next) => {
    try {
      const pageId = String(req.params.pageId || '');
      const nextDraft = await queueAnnotationDraftMutation(async () => {
        const current = await store.loadDraft();
        const merged = mergeAnnotationPage(current, req.body || {}, pageId);
        await store.saveDraft(merged);
        return merged;
      });
      const responseDraft = selectDraftPage(nextDraft, pageId, req.body?.currentFrameId);
      res.json({ draft: responseDraft || nextDraft, issues: validateDraft(nextDraft) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/page-uploads', async (_req, res, next) => {
    try {
      const tasks = (await store.listPageUploadTasks()).map((task) => ({
        ...task,
        processing: activePageUploadControllers.has(task.id),
      }));
      res.json({ tasks });
    } catch (error) {
      next(error);
    }
  });

  router.post('/page-uploads', async (req, res, next) => {
    try {
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      if (items.length === 0) throw workbenchError(400, '请选择至少一张图片或填写图片链接');
      if (items.length > MAX_PAGE_UPLOAD_BATCH) throw workbenchError(400, '单次最多上传 20 张图片');
      const now = new Date().toISOString();
      const tasks = [];
      for (const item of items) {
        const sourceType = item?.sourceType === 'url' ? 'url' : 'file';
        const url = sourceType === 'url' ? String(item.url || '').trim() : null;
        if (sourceType === 'url') {
          let parsed;
          try {
            parsed = new URL(url);
          } catch {
            throw workbenchError(400, `图片链接格式无效：${url || '空链接'}`);
          }
          if (!['http:', 'https:'].includes(parsed.protocol)) throw workbenchError(400, '图片链接仅支持 HTTP 或 HTTPS');
        }
        const totalBytes = sourceType === 'file' ? Number(item.size) : null;
        if (sourceType === 'file' && (!Number.isSafeInteger(totalBytes) || totalBytes <= 0)) throw workbenchError(400, '本地图片大小无效');
        if (totalBytes && totalBytes > MAX_PAGE_IMAGE_BYTES) throw workbenchError(413, '单张图片不能超过 25 MB');
        const mimeType = String(item.mimeType || '');
        if (sourceType === 'file' && !mimeType.startsWith('image/')) throw workbenchError(415, '只能上传图片文件');
        const task = {
          id: `page-upload-${randomUUID()}`,
          sourceType,
          name: String(item.name || (url ? decodeURIComponent(new URL(url).pathname.split('/').pop() || '') : '') || '待上传图片'),
          url,
          mimeType: mimeType || null,
          totalBytes,
          uploadedBytes: 0,
          status: 'queued',
          errorReason: null,
          pageId: null,
          frameId: null,
          createdAt: now,
          updatedAt: now,
        };
        await store.savePageUploadTask(task);
        tasks.push(task);
      }
      res.status(201).json({ tasks });
    } catch (error) {
      next(error);
    }
  });

  router.put('/page-uploads/:taskId/chunk', express.raw({ type: 'application/octet-stream', limit: '3mb' }), async (req, res, next) => {
    let task;
    try {
      task = await loadPageUploadTask(req.params.taskId);
      if (task.sourceType !== 'file') throw workbenchError(400, '链接任务不能接收本地文件分片');
      if (task.status === 'completed') return res.json({ task });
      const offset = Number(req.header('x-upload-offset'));
      if (!Number.isSafeInteger(offset) || offset < 0) throw workbenchError(400, '缺少有效的上传偏移');
      const chunk = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (chunk.length === 0) throw workbenchError(400, '上传分片不能为空');
      if (offset + chunk.length > task.totalBytes) throw workbenchError(400, '上传数据超过文件大小');
      let uploadedBytes;
      try {
        uploadedBytes = await store.appendPageUploadChunk(task.id, offset, chunk);
      } catch (error) {
        if (error?.code === 'UPLOAD_OFFSET_MISMATCH') throw workbenchError(409, error.message, { expectedOffset: error.expectedOffset });
        throw error;
      }
      task = await updatePageUploadTask(task, { status: 'uploading', uploadedBytes, errorReason: null });
      if (uploadedBytes === task.totalBytes) return res.json(await finalizePageUpload(task));
      res.json({ task });
    } catch (error) {
      if (task && !deletedPageUploadIds.has(task.id) && error?.status !== 409) await failPageUploadTask(task, error).catch(() => {});
      next(error);
    }
  });

  router.post('/page-uploads/:taskId/process', async (req, res, next) => {
    let task;
    let timeout;
    try {
      task = await loadPageUploadTask(req.params.taskId);
      if (task.status === 'completed') return res.json({ task, draft: await store.loadDraft() });
      const partSize = await store.pageUploadPartSize(task.id);
      task = await updatePageUploadTask(task, { status: 'uploading', uploadedBytes: partSize, errorReason: null });
      if (task.sourceType === 'file') {
        if (partSize !== task.totalBytes) throw workbenchError(409, '请重新选择原文件，从已上传位置继续');
        return res.json(await finalizePageUpload(task));
      }

      const controller = new AbortController();
      activePageUploadControllers.set(task.id, controller);
      timeout = setTimeout(() => controller.abort(new Error('图片下载超过 120 秒')), 120_000);
      const headers = partSize > 0 ? { Range: `bytes=${partSize}-` } : {};
      let response;
      try {
        response = await fetch(task.url, { headers, redirect: 'follow', signal: controller.signal });
      } catch (error) {
        const reason = error?.cause?.message || error?.message || String(error);
        throw workbenchError(502, `图片链接访问失败：${reason}`);
      }
      if (!response.ok && response.status !== 206) throw workbenchError(502, `图片下载失败：HTTP ${response.status}`);
      const contentType = response.headers.get('content-type') || task.mimeType || '';
      if (contentType && !contentType.startsWith('image/') && contentType !== 'application/octet-stream') {
        throw workbenchError(415, `链接返回的不是图片：${contentType}`);
      }
      let offset = partSize;
      if (partSize > 0 && response.status !== 206) {
        await store.resetPageUploadPart(task.id);
        offset = 0;
      }
      const contentRangeTotal = Number(response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1]);
      const contentLength = Number(response.headers.get('content-length'));
      const totalBytes = Number.isSafeInteger(contentRangeTotal) && contentRangeTotal > 0
        ? contentRangeTotal
        : Number.isSafeInteger(contentLength) && contentLength > 0 ? offset + contentLength : task.totalBytes;
      if (totalBytes && totalBytes > MAX_PAGE_IMAGE_BYTES) throw workbenchError(413, '单张图片不能超过 25 MB');
      if (!response.body) throw workbenchError(502, '图片链接没有返回可下载内容');
      const reader = response.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        if (offset + chunk.length > MAX_PAGE_IMAGE_BYTES) throw workbenchError(413, '单张图片不能超过 25 MB');
        offset = await store.appendPageUploadChunk(task.id, offset, chunk);
        task = await updatePageUploadTask(task, { status: 'uploading', uploadedBytes: offset, totalBytes: totalBytes || null, mimeType: contentType || null, errorReason: null });
      }
      return res.json(await finalizePageUpload(task));
    } catch (error) {
      if (task && !deletedPageUploadIds.has(task.id)) await failPageUploadTask(task, error).catch(() => {});
      next(error);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (task) activePageUploadControllers.delete(task.id);
    }
  });

  router.delete('/page-uploads', async (req, res, next) => {
    try {
      const ids = [...new Set(Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [])];
      if (ids.length === 0) throw workbenchError(400, '请选择要删除的上传记录');
      const tasks = await Promise.all(ids.map(loadPageUploadTask));
      ids.forEach((id) => deletedPageUploadIds.add(id));
      for (const task of tasks) activePageUploadControllers.get(task.id)?.abort(new Error('上传任务已删除'));
      const draft = await queueUploadDraftMutation(async () => {
        const currentDraft = await store.loadDraft();
        if (req.body?.deletePages !== true) return currentDraft;
        const latestTasks = await Promise.all(tasks.map(async (task) => {
          try { return await store.loadPageUploadTask(task.id); } catch { return task; }
        }));
        const pageIds = latestTasks.map((task) => task.pageId).filter(Boolean);
        if (pageIds.length === 0) return currentDraft;
        const nextDraft = removePagesFromDraft(currentDraft, pageIds);
        await store.saveDraft(nextDraft);
        return nextDraft;
      });
      await Promise.all(tasks.map((task) => store.deletePageUploadTask(task.id)));
      res.json({ deletedIds: ids, draft });
    } catch (error) {
      next(error);
    }
  });

  router.post('/frames', async (req, res, next) => {
    try {
      if (!server.agent) return res.status(409).json({ error: '请先连接 Android 设备' });
      await syncModelRuntime();
      const draft = await store.loadDraft();
      const replacePageId = typeof req.body?.replacePageId === 'string' ? req.body.replacePageId : null;
      if (replacePageId && !draft.pages.some((page) => page.id === replacePageId)) {
        return res.status(404).json({ error: '需要重新冻结的页面不存在' });
      }
      const frame = await freezeAndCapture(server.agent);
      const metadata = await store.saveFrame(frame);
      const nextDraft = beginFrameCapture(draft, frame.frameId, { forceNewPage: req.body?.forceNewPage === true, replacePageId });
      await store.saveDraft(nextDraft);
      res.json({
        frame: {
          ...metadata,
          imagePath: undefined,
          imageUrl: `/workbench/api/frames/${encodeURIComponent(frame.frameId)}/image`,
        },
        draft: nextDraft,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/frames/:frameId/image', async (req, res, next) => {
    try {
      const frame = await store.loadFrame(req.params.frameId);
      res.type(frame.mimeType).sendFile(frame.imagePath);
    } catch (error) {
      next(error);
    }
  });

  router.post('/workers/a', async (req, res, next) => {
    let session;
    try {
      const workspaceSessionId = workspaceSessionKey(req.body?.workspaceSessionId);
      session = beginWorkerASession(workspaceSessionId);
      res.json(await executeWorker({
        worker: 'worker_a',
        frameId: req.body?.frameId,
        pageId: req.body?.pageId,
        pageContext: req.body?.pageContext || '',
        mergeIntoDraft: Boolean(req.body?.mergeIntoDraft),
        signal: session.controller.signal,
        workspaceSessionId,
      }));
    } catch (error) {
      next(error);
    } finally {
      if (session) endWorkerASession(session);
    }
  });

  async function streamWorkerA(req, res, resumeSession = null) {
    let session;
    const workspaceSessionId = workspaceSessionKey(resumeSession?.workspaceSessionId || req.body?.workspaceSessionId);
    try {
      session = beginWorkerASession(workspaceSessionId);
    } catch (error) {
      return res.status(error?.status || 500).json({ error: error instanceof Error ? error.message : String(error), ...(error?.details || {}) });
    }

    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    let responseComplete = false;
    const send = (event, data) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    res.on('close', () => {
      if (!responseComplete && activeWorkerA.get(workspaceSessionId)?.id === session.id) session.controller.abort('Worker A 流连接已关闭');
    });

    try {
      const result = await executeWorker({
        worker: 'worker_a',
        frameId: resumeSession?.frameId || req.body?.frameId,
        pageId: resumeSession?.pageId || req.body?.pageId || null,
        pageContext: resumeSession?.pageContext || req.body?.pageContext || '',
        mergeIntoDraft: resumeSession?.mergeIntoDraft ?? Boolean(req.body?.mergeIntoDraft),
        signal: session.controller.signal,
        onProgress: (event) => send(event.type, event),
        resumeSession,
        workspaceSessionId,
      });
      send('result', result);
    } catch (error) {
      if (session.controller.signal.aborted) {
        send('cancelled', { message: 'Worker A 已中断', ...(error?.details || {}) });
      } else {
        send('error', {
          message: error instanceof Error ? error.message : String(error),
          ...(error?.details || {}),
        });
      }
    } finally {
      responseComplete = true;
      endWorkerASession(session);
      if (!res.writableEnded) res.end();
    }
  }

  router.post('/workers/a/stream', async (req, res) => {
    await streamWorkerA(req, res);
  });

  router.post('/workers/a/resume/stream', async (req, res) => {
    const workspaceSessionId = workspaceSessionKey(req.body?.workspaceSessionId);
    const resumeSession = resumableWorkerA.get(workspaceSessionId);
    if (!resumeSession || resumeSession.id !== req.body?.sessionId) {
      return res.status(404).json({ error: '没有可从断点继续的 Worker A 会话' });
    }
    await streamWorkerA(req, res, resumeSession);
  });

  router.post('/workers/a/cancel', (req, res) => {
    const session = activeWorkerA.get(workspaceSessionKey(req.body?.workspaceSessionId));
    if (!session) return res.json({ cancelled: false });
    session.controller.abort('用户中断 Worker A');
    res.json({ cancelled: true });
  });

  async function streamWorkerB(req, res, resumeSession = null) {
    let session;
    const workspaceSessionId = workspaceSessionKey(resumeSession?.workspaceSessionId || req.body?.workspaceSessionId);
    try {
      session = beginWorkerBSession(workspaceSessionId);
      await syncModelRuntime();
    } catch (error) {
      if (session) endWorkerBSession(session);
      return res.status(error?.status || 500).json({ error: error instanceof Error ? error.message : String(error) });
    }
    let responseComplete = false;
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    }).flushHeaders();
    const send = (event, data) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    res.on('close', () => {
      if (!responseComplete && activeWorkerB.get(workspaceSessionId)?.id === session.id) session.controller.abort('Worker B 流连接已关闭');
    });
    try {
      const result = await executeWorker({
        worker: 'worker_b',
        frameId: resumeSession?.frameId || String(req.body?.frameId || ''),
        pageId: resumeSession?.pageId || req.body?.pageId || null,
        pageContext: resumeSession?.pageContext || req.body?.pageContext || '',
        mergeIntoDraft: false,
        signal: session.controller.signal,
        onProgress: (event) => send(event.type, event),
        resumeSession,
        workspaceSessionId,
      });
      send('result', result);
    } catch (error) {
      send(session.controller.signal.aborted ? 'cancelled' : 'error', {
        message: session.controller.signal.aborted ? 'Worker B 已中断' : error instanceof Error ? error.message : String(error),
        ...(error?.details || {}),
      });
    } finally {
      responseComplete = true;
      endWorkerBSession(session);
      if (!res.writableEnded) res.end();
    }
  }

  router.post('/workers/b/stream', async (req, res) => {
    await streamWorkerB(req, res);
  });

  router.post('/workers/b/resume/stream', async (req, res) => {
    const workspaceSessionId = workspaceSessionKey(req.body?.workspaceSessionId);
    const resumeSession = resumableWorkerB.get(workspaceSessionId);
    if (!resumeSession || resumeSession.id !== req.body?.sessionId) {
      return res.status(404).json({ error: '没有可从断点继续的 Worker B 会话' });
    }
    await streamWorkerB(req, res, resumeSession);
  });

  router.post('/workers/b/cancel', (req, res) => {
    const session = activeWorkerB.get(workspaceSessionKey(req.body?.workspaceSessionId));
    if (!session) return res.json({ cancelled: false });
    session.controller.abort('用户中断 Worker B');
    res.json({ cancelled: true });
  });

  router.post('/workers/b', async (req, res, next) => {
    let session;
    try {
      const workspaceSessionId = workspaceSessionKey(req.body?.workspaceSessionId);
      session = beginWorkerBSession(workspaceSessionId);
      await syncModelRuntime();
      const result = await executeWorker({
        worker: 'worker_b',
        frameId: String(req.body?.frameId || ''),
        pageId: req.body?.pageId,
        pageContext: req.body?.pageContext || '',
        signal: session.controller.signal,
        workspaceSessionId,
      });
      res.json(result);
    } catch (error) {
      next(error);
    } finally {
      if (session) endWorkerBSession(session);
    }
  });

  router.post('/workers/merge', async (req, res, next) => {
    try {
      const frameId = String(req.body?.frameId || '');
      const pageId = String(req.body?.pageId || '');
      const currentDraft = await store.loadDraft();
      const pageDraft = pageId ? selectDraftPage(currentDraft, pageId, frameId) : currentDraft;
      if (!frameId || !pageDraft || pageDraft.currentFrameId !== frameId) throw workbenchError(409, '草稿已经切换到其他冻结帧');
      const selections = Array.isArray(req.body?.selections) ? req.body.selections.filter((selection) => selection && typeof selection === 'object') : [];
      const { workerResult: workerAResult } = normalizeWorkerOutput(req.body?.workerAResult || {});
      const { workerResult: workerBResult } = normalizeWorkerOutput(req.body?.workerBResult || {});
      const workerAByKey = new Map((workerAResult.elements || []).map((element) => [element.candidateKey, element]));
      const workerBByKey = new Map((workerBResult.elements || []).map((element) => [element.candidateKey, element]));
      const candidateByKey = new Map();
      const actionSourceByKey = new Map();
      const workerAKeyToMergedKey = new Map();
      const workerBKeyToMergedKey = new Map();
      for (const selection of selections) {
        const candidateKey = String(selection.candidateKey || '');
        const workerACandidateKey = String(selection.workerACandidateKey || candidateKey);
        const workerBCandidateKey = String(selection.workerBCandidateKey || candidateKey);
        const workerA = workerAByKey.get(workerACandidateKey);
        const workerB = workerBByKey.get(workerBCandidateKey);
        const baseSource = selection.baseSource === 'workerB' && workerB ? 'workerB' : workerA ? 'workerA' : workerB ? 'workerB' : null;
        if (!candidateKey || !baseSource) continue;
        const base = structuredClone(baseSource === 'workerB' ? workerB : workerA);
        for (const [field, source] of Object.entries(selection.fieldSources || {})) {
          if (field === 'actions') continue;
          const sourceCandidate = source === 'workerB' ? workerB : workerA;
          if (sourceCandidate && Object.hasOwn(sourceCandidate, field)) base[field] = structuredClone(sourceCandidate[field]);
        }
        let mergedKey = String(base.candidateKey || candidateKey);
        if (candidateByKey.has(mergedKey)) {
          const suffix = baseSource === 'workerA' ? 'worker_a' : 'worker_b';
          let sequence = 1;
          let uniqueKey = `${mergedKey}.${suffix}`;
          while (candidateByKey.has(uniqueKey)) uniqueKey = `${mergedKey}.${suffix}.${sequence++}`;
          mergedKey = uniqueKey;
          base.candidateKey = mergedKey;
        }
        candidateByKey.set(mergedKey, base);
        actionSourceByKey.set(mergedKey, selection.fieldSources?.actions === 'workerB' ? 'workerB' : baseSource);
        if (workerA) workerAKeyToMergedKey.set(workerACandidateKey, mergedKey);
        if (workerB) workerBKeyToMergedKey.set(workerBCandidateKey, mergedKey);
      }
      const workerBActions = (workerBResult.actionCandidates || []).flatMap((action) => {
        const mergedKey = workerBKeyToMergedKey.get(action.triggerCandidateKey);
        return mergedKey && actionSourceByKey.get(mergedKey) === 'workerB' ? [{ ...action, triggerCandidateKey: mergedKey }] : [];
      });
      const workerAActions = (workerAResult.actionCandidates || []).flatMap((action) => {
        const mergedKey = workerAKeyToMergedKey.get(action.triggerCandidateKey);
        return mergedKey && actionSourceByKey.get(mergedKey) === 'workerA' ? [{ ...action, triggerCandidateKey: mergedKey }] : [];
      });
      const remapRelationships = (relationships, keyMap) => (relationships || []).flatMap((relationship) => {
        const fromCandidateKey = keyMap.get(relationship.fromCandidateKey);
        const toCandidateKey = keyMap.get(relationship.toCandidateKey);
        return fromCandidateKey && toCandidateKey ? [{ ...relationship, fromCandidateKey, toCandidateKey }] : [];
      });
      const combinedResult = {
        ...(workerAResult.page ? workerAResult : workerBResult),
        frameId,
        elements: [...candidateByKey.values()],
        relationships: [...remapRelationships(workerAResult.relationships, workerAKeyToMergedKey), ...remapRelationships(workerBResult.relationships, workerBKeyToMergedKey)],
        actionCandidates: [...workerBActions, ...workerAActions],
      };
      const draft = mergeWorkerIntoDraft(pageDraft, prepareWorkerForDraft(combinedResult), String(req.body?.modelResultRef || 'worker-merge'), null);
      await store.saveDraft(draft);
      res.json({ draft, issues: validateDraft(draft) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/staging', async (_req, res, next) => {
    try {
      const draft = await store.loadDraft();
      const result = await graphWorkflow.prepare(draft);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/staging', async (_req, res, next) => {
    try {
      res.json({ versions: await graphWorkflow.listStages() });
    } catch (error) {
      next(error);
    }
  });

  router.post('/staging/merge', async (req, res, next) => {
    try {
      res.json(await graphWorkflow.mergeStages(req.body?.stageIds));
    } catch (error) {
      next(error);
    }
  });

  router.get('/staging/:stageId', async (req, res, next) => {
    try {
      res.json(await graphWorkflow.loadStage(req.params.stageId));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/staging/:stageId', async (req, res, next) => {
    try {
      res.json(await graphWorkflow.deleteStage(req.params.stageId));
    } catch (error) {
      next(error);
    }
  });

  router.post('/staging/:stageId/archive', async (req, res, next) => {
    try {
      res.json(await graphWorkflow.archiveStage(req.params.stageId));
    } catch (error) {
      next(error);
    }
  });

  router.post('/staging/:stageId/rollback', async (req, res, next) => {
    try {
      const result = await graphWorkflow.rollback(req.params.stageId);
      const draft = await store.loadDraft();
      const now = new Date().toISOString();
      const nextDraft = normalizeDraftForSave({
        ...draft,
        revision: draft.revision + 1,
        pages: draft.pages.map((page) => ({ ...page, publishedAt: null })),
        updatedAt: now,
      });
      const issues = validateDraft(nextDraft);
      await store.saveDraft(nextDraft);
      res.json({ ...result, draft: nextDraft, issues });
    } catch (error) {
      next(error);
    }
  });

  router.post('/publish', async (req, res, next) => {
    try {
      const draft = await store.loadDraft();
      const result = await graphWorkflow.publish(req.body?.stageId);
      const publishedAt = new Date().toISOString();
      const publishesCurrentDraft = result.version.draftRevision === draft.revision && result.version.operation !== 'rollback';
      const nextDraft = normalizeDraftForSave({
        ...draft,
        revision: draft.revision + 1,
        pages: draft.pages.map((page) => ({
          ...page,
          publishedAt: publishesCurrentDraft && page.frameIds.length > 0 ? publishedAt : null,
        })),
        updatedAt: publishedAt,
      });
      const issues = validateDraft(nextDraft);
      await store.saveDraft(nextDraft);
      res.json({ ...result, draft: nextDraft, issues });
    } catch (error) {
      next(error);
    }
  });

  router.use((error, _req, res, _next) => {
    console.error('[workbench]', error);
    res.status(error?.status || 500).json({
      error: error instanceof Error ? error.message : String(error),
      ...(error?.details || {}),
    });
  });

  server.app.use('/workbench/api', router);
}
