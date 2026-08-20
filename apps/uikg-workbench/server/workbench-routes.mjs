import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import express from 'express';
import { imageSize } from 'image-size';
import {
  beginFrameCapture,
  mergeRecognitionIntoDraft,
  normalizeDraftForSave,
  normalizeRecognitionOutput,
  prepareRecognitionForDraft,
  removePagesFromDraft,
  validateDraft,
  validateRecognitionConsistency,
} from './draft-model.mjs';
import { deleteModelGateway, fetchAvailableModelsByGateway, loadModelGateways, loadTargetModelSettings, loadWorkbenchPreferences, MODEL_TARGETS, resolveTargetModelConfig, resetDefaultModelGateway, saveModelGateway, saveTargetModelSettings, saveWorkbenchMode, testModelGateway } from './model-settings.mjs';
import { reasoningBudgetForModel } from './model-compatibility.mjs';
import { clearModelRuntime, getModelRuntime, setModelRuntime } from './model-runtime.mjs';
import { recoverRecognitionCheckpointFromStream, runResumableRecognition, RECOGNITION_ERROR_RETRY_LIMIT } from './resumable-recognition.mjs';
import { runRecognitionModel } from './recognition-client.mjs';
import { buildRecognitionContinuationPrompt, buildRecognitionPrompt } from './recognition-prompt.mjs';
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

export async function registerWorkbenchRoutes({ server, store, modelStore, graphWorkflow, graphRoot, workbenchRoot, spec }) {
  const router = express.Router();
  router.use(express.json({ limit: '50mb' }));
  const schema = JSON.parse(await readFile(path.join(workbenchRoot, 'server', 'recognition-output.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validateRecognitionSchema = ajv.compile(schema);
  const activeRecognitionSessions = new Map([
    ['manual', new Map()],
    ['ultra_a', new Map()],
    ['ultra_b', new Map()],
  ]);
  const resumableRecognitionSessions = new Map([
    ['manual', new Map()],
    ['ultra_a', new Map()],
    ['ultra_b', new Map()],
  ]);
  let loadedModelRuntimeSignature = null;
  let uploadDraftQueue = Promise.resolve();
  let annotationDraftQueue = Promise.resolve();
  const activePageUploadControllers = new Map();
  const deletedPageUploadIds = new Set();
  const workspaceSessionKey = (value) => String(value || 'default').trim().slice(0, 160) || 'default';
  const runProjectModelService = (command, projectKey, payload = null) => new Promise((resolve, reject) => {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(projectKey)) {
      reject(workbenchError(400, '项目标识无效'));
      return;
    }
    const script = path.join(graphRoot, 'tools', 'project_model_service.py');
    const child = spawn('python', [script, command, '--root', graphRoot, '--project', projectKey], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        try { resolve(JSON.parse(stdout)); } catch { reject(workbenchError(500, '模型配置服务返回了无效数据')); }
        return;
      }
      let details = {};
      try { details = JSON.parse(stderr); } catch {}
      reject(workbenchError(400, details.error || '模型配置保存失败', details));
    });
    if (payload) child.stdin.end(JSON.stringify(payload));
    else child.stdin.end();
  });
  const recognitionInProgress = () => [...activeRecognitionSessions.values()].some((sessions) => sessions.size > 0);
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
        functionRef: page.functionRef,
        implementationType: page.implementationType,
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
      lastAiModel: incoming.lastAiModel,
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
      else clearModelRuntime(target);
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
    } else {
      for (const key of ['MIDSCENE_MODEL_BASE_URL', 'MIDSCENE_MODEL_API_KEY', 'MIDSCENE_MODEL_NAME', 'MIDSCENE_MODEL_FAMILY', 'MIDSCENE_MODEL_TIMEOUT', 'MIDSCENE_MODEL_TEMPERATURE', 'MIDSCENE_MODEL_REASONING_EFFORT', 'MIDSCENE_MODEL_REASONING_ENABLED', 'MIDSCENE_MODEL_REASONING_BUDGET']) delete process.env[key];
    }
    server.agent?.modelConfigManager?.clearModelConfigMap();
    loadedModelRuntimeSignature = signature;
    return true;
  };

  const loadCombinedModelSettings = () => ({
    settingsSchemaVersion: 2,
    sections: [
      { id: 'model-gateways', label: '模型网关', order: 10 },
      { id: 'mode-configuration', label: '模式配置', order: 20 },
    ],
    manual: loadTargetModelSettings(modelStore, 'manual'),
    auto: loadTargetModelSettings(modelStore, 'auto'),
    ultraModelA: loadTargetModelSettings(modelStore, 'ultra_a'),
    ultraModelB: loadTargetModelSettings(modelStore, 'ultra_b'),
    midscene: loadTargetModelSettings(modelStore, 'midscene'),
    gateways: loadModelGateways(modelStore),
    modeConfiguration: loadWorkbenchPreferences(modelStore),
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

  const inspectRecognitionResult = (candidate) => {
    const { recognitionResult: normalizedResult, normalizationIssues } = normalizeRecognitionOutput(candidate);
    const schemaValid = validateRecognitionSchema(normalizedResult);
    const schemaErrors = structuredClone(validateRecognitionSchema.errors || []);
    return { normalizedResult, normalizationIssues, schemaValid, schemaErrors };
  };

  const publicRecognitionSession = (session, includeStreams = false) => session ? {
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

  const recognitionLabels = {
    manual: 'Manual 页面识别模型',
    ultra_a: 'Model A',
    ultra_b: 'Model B',
  };

  async function executeRecognition({ target, frameId, pageId = null, pageContext = '', mergeIntoDraft = false, signal, onProgress = () => {}, resumeSession = null, workspaceSessionId = 'default' }) {
    const label = recognitionLabels[target];
    if (!label) throw workbenchError(400, `未知识别目标：${target}`);
    await syncModelRuntime();
    const runtime = getModelRuntime(target);
    const model = runtime?.modelName || null;
    const setResumable = (value) => {
      const sessions = resumableRecognitionSessions.get(target);
      if (value) sessions.set(workspaceSessionId, value);
      else sessions.delete(workspaceSessionId);
    };
    const modelResultId = `${target}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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
        kind: target,
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
        throw workbenchError(503, `未配置 ${label} 模型，请在设置页面完成指派`);
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
      const run = await runResumableRecognition({
        initialPrompt: buildRecognitionPrompt(frameId, pageContext),
        initialResult: resumeSession?.rawResult,
        initialFallback: { frameId, elements: [] },
        callModel: async (prompt, attempt) => {
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
            const recognitionRunner = typeof server.runRecognitionModel === 'function' ? server.runRecognitionModel : runRecognitionModel;
            return await recognitionRunner({
              target,
              prompt,
              imagePath: frozenFrame.imagePath,
              mimeType: frozenFrame.mimeType,
              responseSchema: schema,
              continuation: attempt.continuation,
              signal: attempt.signal,
              onChunk,
            });
          } catch (error) {
            const recovered = recoverRecognitionCheckpointFromStream(accumulated);
            if (error && typeof error === 'object') {
              error.recognitionCheckpoint = recovered;
              error.receivedContent = Boolean(accumulated.trim());
            }
            throw error;
          }
        },
        buildContinuationPrompt: (checkpoint, attempt) => buildRecognitionContinuationPrompt(frameId, pageContext, checkpoint, attempt),
        isComplete: (candidate) => inspectRecognitionResult(candidate).schemaValid,
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
      const { normalizedResult, normalizationIssues, schemaValid, schemaErrors } = inspectRecognitionResult(rawResult);
      const consistencyIssues = schemaValid ? validateRecognitionConsistency(normalizedResult) : [];
      const blockingConsistencyIssues = consistencyIssues.filter((issue) => issue.startsWith('候选键重复'));
      const record = {
        recordType: 'WorkbenchRecognitionResult',
        modelResultId,
        frameId,
        startedAt,
        completedAt: new Date().toISOString(),
        target,
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
          target,
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
          retryLimit: RECOGNITION_ERROR_RETRY_LIMIT,
          retryAttempts,
          completedCandidates: Array.isArray(rawResult?.elements) ? rawResult.elements.length : 0,
          resumableSession: publicRecognitionSession(resumableSession, true),
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
          const merged = mergeRecognitionIntoDraft(pageDraft, prepareRecognitionForDraft(normalizedResult), modelResultRef, model);
          await store.saveDraft(merged);
          return merged;
        });
        issues = validateDraft(draft);
        signal?.throwIfAborted();
      }
      emitProgress({ type: 'stage', phase: 'complete', message: `${label} 分析完成` });
      sessionStatus = 'completed';
      return { frameId, target, recognitionResult: normalizedResult, modelResultRef, model, reasoningContent, outputContent, ...(draft ? { draft, issues } : {}) };
    } catch (error) {
      if (signal?.aborted && (!error || typeof error !== 'object')) error = new Error(`用户中断 ${label}`);
      sessionStatus = signal?.aborted ? 'cancelled' : 'failed';
      sessionError = signal?.aborted ? `用户中断 ${label}` : error instanceof Error ? error.message : String(error);
      if (signal?.aborted) {
        const rawCheckpoint = error && typeof error === 'object'
          ? error.recognitionRawResult || recoverRecognitionCheckpointFromStream(outputContent)
          : recoverRecognitionCheckpointFromStream(outputContent);
        const rawResultForResume = rawCheckpoint || { frameId, elements: [] };
        const resumableSession = {
          id: modelResultId,
          workspaceSessionId,
          frameId,
          pageId,
          pageContext,
          target,
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
            resumableSession: publicRecognitionSession(resumableSession, true),
          };
        }
      }
      if (modelStarted && !resultSaved) {
        try {
          const resultPath = await store.saveModelResult(modelResultId, {
            recordType: signal?.aborted ? 'WorkbenchRecognitionCancellation' : 'WorkbenchRecognitionFailure',
            modelResultId,
            frameId: frameId || null,
            completedAt: new Date().toISOString(),
            target,
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
        kind: target,
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

  function beginRecognitionSession(target, workspaceSessionId = 'default') {
    const sessions = activeRecognitionSessions.get(target);
    const label = recognitionLabels[target];
    if (!sessions || !label) throw workbenchError(400, `未知识别目标：${target}`);
    if (sessions.has(workspaceSessionId)) throw workbenchError(409, `当前标签页已有 ${label} 分析正在运行`);
    const session = { id: randomUUID(), workspaceSessionId, controller: new AbortController() };
    sessions.set(workspaceSessionId, session);
    return session;
  }

  function endRecognitionSession(target, session) {
    const sessions = activeRecognitionSessions.get(target);
    if (sessions?.get(session.workspaceSessionId)?.id !== session.id) return;
    sessions.delete(session.workspaceSessionId);
  }

  server.app.use((req, res, next) => {
    if (recognitionInProgress() && req.path === '/interact') {
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
        recognitionRunning: recognitionInProgress(),
        manualModelConfigured: Boolean(getModelRuntime('manual')?.modelName),
        manualModel: getModelRuntime('manual')?.modelName || null,
        ultraModelAConfigured: Boolean(getModelRuntime('ultra_a')?.modelName),
        ultraModelA: getModelRuntime('ultra_a')?.modelName || null,
        ultraModelBConfigured: Boolean(getModelRuntime('ultra_b')?.modelName),
        ultraModelB: getModelRuntime('ultra_b')?.modelName || null,
        manualSession: publicRecognitionSession(resumableRecognitionSessions.get('manual').get(workspaceSessionKey(req.query.workspaceSessionId))),
        ultraModelASession: publicRecognitionSession(resumableRecognitionSessions.get('ultra_a').get(workspaceSessionKey(req.query.workspaceSessionId))),
        ultraModelBSession: publicRecognitionSession(resumableRecognitionSessions.get('ultra_b').get(workspaceSessionKey(req.query.workspaceSessionId))),
        spec,
        session,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/recognition/:target/session', (req, res) => {
    const sessions = resumableRecognitionSessions.get(req.params.target);
    if (!sessions) return res.status(404).json({ error: '未知识别目标' });
    res.json({ session: publicRecognitionSession(sessions.get(workspaceSessionKey(req.query.workspaceSessionId)), true) });
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

  router.get('/project-model', async (req, res, next) => {
    try {
      res.json(await runProjectModelService('read', String(req.query.project || 'baohe')));
    } catch (error) {
      next(error);
    }
  });

  router.put('/project-model', async (req, res, next) => {
    try {
      res.json(await runProjectModelService('save', String(req.query.project || 'baohe'), req.body));
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
      if (recognitionInProgress()) return res.status(409).json({ error: 'AI 分析正在运行，结束后才能切换模型' });
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
      if (recognitionInProgress()) return res.status(409).json({ error: 'AI 分析正在运行，结束后才能修改模型网关' });
      saveModelGateway(modelStore, { ...req.body, id: req.params.gatewayId });
      await syncModelRuntime();
      res.json(loadCombinedModelSettings());
    } catch (error) {
      next(error);
    }
  });

  router.post('/model-settings/gateways', async (req, res, next) => {
    try {
      if (recognitionInProgress()) return res.status(409).json({ error: 'AI 分析正在运行，结束后才能新增模型网关' });
      saveModelGateway(modelStore, req.body);
      await syncModelRuntime();
      res.json(loadCombinedModelSettings());
    } catch (error) {
      next(error);
    }
  });

  router.post('/model-settings/gateways/:gatewayId/test', async (req, res, next) => {
    try {
      res.json(await testModelGateway(modelStore, req.params.gatewayId));
    } catch (error) {
      next(error);
    }
  });

  router.post('/model-settings/gateways/:gatewayId/reset', async (req, res, next) => {
    try {
      if (recognitionInProgress()) return res.status(409).json({ error: 'AI 分析正在运行，结束后才能重置模型网关' });
      resetDefaultModelGateway(modelStore);
      await syncModelRuntime();
      res.json(loadCombinedModelSettings());
    } catch (error) {
      next(error);
    }
  });

  router.put('/model-settings/mode', async (req, res, next) => {
    try {
      if (recognitionInProgress()) return res.status(409).json({ error: 'AI 分析正在运行，结束后才能切换模式' });
      saveWorkbenchMode(modelStore, req.body?.mode);
      res.json(loadCombinedModelSettings());
    } catch (error) {
      next(error);
    }
  });

  router.delete('/model-settings/gateways/:gatewayId', async (req, res, next) => {
    try {
      if (recognitionInProgress()) return res.status(409).json({ error: 'AI 分析正在运行，结束后才能移除模型网关' });
      const deleted = deleteModelGateway(modelStore, req.params.gatewayId);
      res.json({ ...loadCombinedModelSettings(), ...deleted });
    } catch (error) {
      next(error);
    }
  });

  router.post('/device/tap', async (req, res, next) => {
    try {
      if (recognitionInProgress()) return res.status(423).json({ error: 'AI 正在分析冻结帧，设备操作已临时锁定' });
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

  async function streamRecognition(target, req, res, resumeSession = null) {
    let session;
    const workspaceSessionId = workspaceSessionKey(resumeSession?.workspaceSessionId || req.body?.workspaceSessionId);
    try {
      session = beginRecognitionSession(target, workspaceSessionId);
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
      const activeSessions = activeRecognitionSessions.get(target);
      if (!responseComplete && activeSessions?.get(workspaceSessionId)?.id === session.id) session.controller.abort(`${recognitionLabels[target]} 流连接已关闭`);
    });

    try {
      const result = await executeRecognition({
        target,
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
        send('cancelled', { message: `${recognitionLabels[target]} 已中断`, ...(error?.details || {}) });
      } else {
        send('error', {
          message: error instanceof Error ? error.message : String(error),
          ...(error?.details || {}),
        });
      }
    } finally {
      responseComplete = true;
      endRecognitionSession(target, session);
      if (!res.writableEnded) res.end();
    }
  }

  router.post('/recognition/:target/stream', async (req, res) => {
    if (!activeRecognitionSessions.has(req.params.target)) return res.status(404).json({ error: '未知识别目标' });
    await streamRecognition(req.params.target, req, res);
  });

  router.post('/recognition/:target/resume/stream', async (req, res) => {
    const target = req.params.target;
    const sessions = resumableRecognitionSessions.get(target);
    if (!sessions) return res.status(404).json({ error: '未知识别目标' });
    const workspaceSessionId = workspaceSessionKey(req.body?.workspaceSessionId);
    const resumeSession = sessions.get(workspaceSessionId);
    if (!resumeSession || resumeSession.id !== req.body?.sessionId) {
      return res.status(404).json({ error: `没有可从断点继续的 ${recognitionLabels[target]} 会话` });
    }
    await streamRecognition(target, req, res, resumeSession);
  });

  router.post('/recognition/:target/cancel', (req, res) => {
    const target = req.params.target;
    const sessions = activeRecognitionSessions.get(target);
    if (!sessions) return res.status(404).json({ error: '未知识别目标' });
    const session = sessions.get(workspaceSessionKey(req.body?.workspaceSessionId));
    if (!session) return res.json({ cancelled: false });
    session.controller.abort(`用户中断 ${recognitionLabels[target]}`);
    res.json({ cancelled: true });
  });

  router.post('/recognition/:target', async (req, res, next) => {
    let session;
    try {
      const target = req.params.target;
      if (!activeRecognitionSessions.has(target)) throw workbenchError(404, '未知识别目标');
      const workspaceSessionId = workspaceSessionKey(req.body?.workspaceSessionId);
      session = beginRecognitionSession(target, workspaceSessionId);
      res.json(await executeRecognition({
        target,
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
      if (session) endRecognitionSession(req.params.target, session);
    }
  });

  router.post('/recognition/ultra/merge', async (req, res, next) => {
    try {
      const frameId = String(req.body?.frameId || '');
      const pageId = String(req.body?.pageId || '');
      const currentDraft = await store.loadDraft();
      const pageDraft = pageId ? selectDraftPage(currentDraft, pageId, frameId) : currentDraft;
      if (!frameId || !pageDraft || pageDraft.currentFrameId !== frameId) throw workbenchError(409, '草稿已经切换到其他冻结帧');
      const selections = Array.isArray(req.body?.selections) ? req.body.selections.filter((selection) => selection && typeof selection === 'object') : [];
      const { recognitionResult: modelAResult } = normalizeRecognitionOutput(req.body?.modelAResult || {});
      const { recognitionResult: modelBResult } = normalizeRecognitionOutput(req.body?.modelBResult || {});
      const modelAByKey = new Map((modelAResult.elements || []).map((element) => [element.candidateKey, element]));
      const modelBByKey = new Map((modelBResult.elements || []).map((element) => [element.candidateKey, element]));
      const candidateByKey = new Map();
      const actionSourceByKey = new Map();
      const modelAKeyToMergedKey = new Map();
      const modelBKeyToMergedKey = new Map();
      for (const selection of selections) {
        const candidateKey = String(selection.candidateKey || '');
        const modelACandidateKey = String(selection.modelACandidateKey || candidateKey);
        const modelBCandidateKey = String(selection.modelBCandidateKey || candidateKey);
        const modelA = modelAByKey.get(modelACandidateKey);
        const modelB = modelBByKey.get(modelBCandidateKey);
        const baseSource = selection.baseSource === 'modelB' && modelB ? 'modelB' : modelA ? 'modelA' : modelB ? 'modelB' : null;
        if (!candidateKey || !baseSource) continue;
        const base = structuredClone(baseSource === 'modelB' ? modelB : modelA);
        for (const [field, source] of Object.entries(selection.fieldSources || {})) {
          if (field === 'actions') continue;
          const sourceCandidate = source === 'modelB' ? modelB : modelA;
          if (sourceCandidate && Object.hasOwn(sourceCandidate, field)) base[field] = structuredClone(sourceCandidate[field]);
        }
        let mergedKey = String(base.candidateKey || candidateKey);
        if (candidateByKey.has(mergedKey)) {
          const suffix = baseSource === 'modelA' ? 'ultra_a' : 'ultra_b';
          let sequence = 1;
          let uniqueKey = `${mergedKey}.${suffix}`;
          while (candidateByKey.has(uniqueKey)) uniqueKey = `${mergedKey}.${suffix}.${sequence++}`;
          mergedKey = uniqueKey;
          base.candidateKey = mergedKey;
        }
        candidateByKey.set(mergedKey, base);
        actionSourceByKey.set(mergedKey, selection.fieldSources?.actions === 'modelB' ? 'modelB' : baseSource);
        if (modelA) modelAKeyToMergedKey.set(modelACandidateKey, mergedKey);
        if (modelB) modelBKeyToMergedKey.set(modelBCandidateKey, mergedKey);
      }
      const modelBActions = (modelBResult.actionCandidates || []).flatMap((action) => {
        const mergedKey = modelBKeyToMergedKey.get(action.triggerCandidateKey);
        return mergedKey && actionSourceByKey.get(mergedKey) === 'modelB' ? [{ ...action, triggerCandidateKey: mergedKey }] : [];
      });
      const modelAActions = (modelAResult.actionCandidates || []).flatMap((action) => {
        const mergedKey = modelAKeyToMergedKey.get(action.triggerCandidateKey);
        return mergedKey && actionSourceByKey.get(mergedKey) === 'modelA' ? [{ ...action, triggerCandidateKey: mergedKey }] : [];
      });
      const remapRelationships = (relationships, keyMap) => (relationships || []).flatMap((relationship) => {
        const fromCandidateKey = keyMap.get(relationship.fromCandidateKey);
        const toCandidateKey = keyMap.get(relationship.toCandidateKey);
        return fromCandidateKey && toCandidateKey ? [{ ...relationship, fromCandidateKey, toCandidateKey }] : [];
      });
      const combinedResult = {
        ...(modelAResult.page ? modelAResult : modelBResult),
        frameId,
        elements: [...candidateByKey.values()],
        relationships: [...remapRelationships(modelAResult.relationships, modelAKeyToMergedKey), ...remapRelationships(modelBResult.relationships, modelBKeyToMergedKey)],
        actionCandidates: [...modelBActions, ...modelAActions],
      };
      const draft = mergeRecognitionIntoDraft(pageDraft, prepareRecognitionForDraft(combinedResult), String(req.body?.modelResultRef || 'ultra-model-merge'), null);
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
