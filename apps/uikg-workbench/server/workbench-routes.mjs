import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import dotenv from 'dotenv';
import express from 'express';
import { imageSize } from 'image-size';
import {
  beginFrameCapture,
  mergeScoutIntoDraft,
  normalizeDraftForSave,
  normalizeScoutOutput,
  prepareScoutForDraft,
  validateDraft,
  validateScoutConsistency,
} from './draft-model.mjs';
import { buildAIReviewDemand, reviewCandidates } from './ai-review.mjs';
import { ELEMENT_TYPES, SCOUT_ACTIONS, stringUnion } from './element-taxonomy.mjs';
import { loadReviewerModelSettings, loadScoutModelSettings, saveReviewerModelSettings, saveScoutModelSettings } from './model-settings.mjs';
import { recoverScoutCheckpointFromStream, runResumableScout, SCOUT_ERROR_RETRY_LIMIT } from './resumable-scout.mjs';
import { runScoutModel } from './scout-client.mjs';
import { runReviewerModel } from './reviewer-client.mjs';

function imagePayload(base64) {
  const match = String(base64).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
  const mimeType = match?.[1] || 'image/png';
  const buffer = Buffer.from(match?.[2] || base64, 'base64');
  const detected = buffer[0] === 0xff && buffer[1] === 0xd8 ? 'jpeg' : 'png';
  const dimensions = imageSize(buffer);
  return {
    buffer,
    mimeType: match?.[1] || `image/${detected}`,
    extension: detected === 'jpeg' ? 'jpg' : 'png',
    width: dimensions.width,
    height: dimensions.height,
  };
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

const ELEMENT_TYPE_UNION = stringUnion(ELEMENT_TYPES);
const SCOUT_ACTION_UNION = stringUnion(SCOUT_ACTIONS);
const SCOUT_ELEMENT_SHAPE = `{candidateKey: string, label: string|null, visualDescription: string, controlType: ${ELEMENT_TYPE_UNION}, interactive: boolean, enabled: boolean|null, state: string|null, approximateRegion: {x:number,y:number,width:number,height:number}, geometryKind:"boundary"|"tap-target"|"approximate", geometryConfidence:number, meaning:{status:"known"|"candidate"|"unknown",description:string|null,evidence:{visibleTexts:string[],visibleIcons:string[],visibleStates:string[],visualCues:string[],userContext:string|null,unclassified:{type:string,detail:string|null}[]}}, dynamicContent:boolean, riskSignals:string[], confidence:number}`;

function buildScoutPrompt(frameId, pageContext = '') {
  return `请查看完整、稳定的 Android 截图，并严格返回以下结构的一个 JSON 对象。所有自然语言字段必须使用简体中文，不要输出 Markdown：
{
  frameId: string,
  page: {name: string|null, surfaceType: "page"|"dialog"|"drawer"|"bottom-sheet"|"menu"|"shared-component"|"unknown", stateSummary: string, scrollableRegions: string[]},
  elements: [${SCOUT_ELEMENT_SHAPE}],
  relationships: [{fromCandidateKey:string,type:"contains"|"labels"|"controls"|"belongs-to"|"adjacent-to",toCandidateKey:string}],
  actionCandidates: [{triggerCandidateKey:string,action:${SCOUT_ACTION_UNION},expectedOutcome:string|null,basis:"visible-affordance"|"user-context"|"requirement-document"|"existing-graph"|"authority-contract"|"unknown",riskSignals:string[],confidence:number}],
  comparison: {basisFrameId:null,status:"not-requested",changes:[]},
  uncertainties: string[]
}.
按照 Navigation、Action、Input、Selection、Display、List、Container、Overlay、Scroll、Feedback、Progress、Media、Map、System、Gesture、Business 分类选择最具体的 controlType。盘点每个可见元素、标签、图标、状态指示器、结构容器、稳定内容锚点和关系。复合行容器、说明标签、当前值和实际触发器需要分开记录。actionCandidates 使用元素实际支持的操作；手势区域与交互能力必须分离。在 meaning.evidence 中记录可见事实，不要编造 meaning.basis。visibleTexts 放可见文字，visibleIcons 放可识别图标，visibleStates 放选中、禁用或开关状态，visualCues 放其他形状、颜色和布局证据，userContext 放用户提供的知识，其余证据放入 unclassified。JSON 必须紧凑且完整，所有 required 顶层字段都要返回。approximateRegion 使用 0 到 1 的归一化比例且不得越界。candidateKey 必须是稳定、唯一的 ASCII 语义 key。几何信息只是候选范围，不是精确定位器。无法证实的含义保持 unknown。不要规划或执行操作。frameId 必须严格等于 ${JSON.stringify(frameId)}。用户页面上下文：${pageContext || '未提供'}。`;
}

function buildScoutContinuationPrompt(frameId, pageContext, checkpoint, attempt) {
  return `第 ${attempt} 次请求错误后，请从同一冻结画面的断点继续。这是增量续写，不是重新识别；不要从截图顶部重新开始，也不要重复已完成候选。所有自然语言字段必须使用简体中文。
已完成候选和覆盖范围：
${JSON.stringify(checkpoint)}

从归一化纵向位置 ${checkpoint.coveredBottom || 0} 之后开始。如果可见元素已覆盖完毕，则返回 elements:[]，只补齐缺失的顶层字段。禁止返回 completedCandidates 中已有的 candidateKey。只返回剩余工作：
{
  frameId: string,
  page: {name: string|null, surfaceType: "page"|"dialog"|"drawer"|"bottom-sheet"|"menu"|"shared-component"|"unknown", stateSummary: string, scrollableRegions: string[]},
  elements: [${SCOUT_ELEMENT_SHAPE}],
  relationships: [{fromCandidateKey:string,type:"contains"|"labels"|"controls"|"belongs-to"|"adjacent-to",toCandidateKey:string}],
  actionCandidates: [{triggerCandidateKey:string,action:${SCOUT_ACTION_UNION},expectedOutcome:string|null,basis:"visible-affordance"|"user-context"|"requirement-document"|"existing-graph"|"authority-contract"|"unknown",riskSignals:string[],confidence:number}],
  comparison: {basisFrameId:null,status:"not-requested",changes:[]},
  uncertainties: string[],
  done: boolean
}.
仅返回断点中不存在的元素，并使用新的稳定 ASCII candidateKey。必要时可返回涉及已有和新增候选的关系与动作。元素类型和支持操作必须使用上述枚举，元素类型与交互能力需要分开判断。只有断点后的所有可见区域及缺失顶层字段都完成后，才能设置 done=true。证据保持简洁。frameId 仍为 ${JSON.stringify(frameId)}。用户页面上下文：${pageContext || '未提供'}。`;
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

export async function registerWorkbenchRoutes({ server, store, graphWorkflow, workbenchRoot, modelEnvPath, spec }) {
  const router = express.Router();
  router.use(express.json({ limit: '50mb' }));
  const schema = JSON.parse(await readFile(path.join(workbenchRoot, 'server', 'scout-output.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validateScoutSchema = ajv.compile(schema);
  let scoutInProgress = false;
  let reviewInProgress = false;
  let activeScout = null;
  let resumableScout = null;
  let activeReview = null;
  let resumableReview = null;
  let frozenAgent = null;
  let frozenFrameId = null;
  let loadedModelEnvHash = null;

  const syncModelRuntime = async () => {
    if (!modelEnvPath) return false;
    let content;
    try {
      content = await readFile(modelEnvPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    const contentHash = createHash('sha256').update(content).digest('hex');
    if (contentHash === loadedModelEnvHash) return false;
    Object.assign(process.env, dotenv.parse(content));
    server.agent?.modelConfigManager?.clearModelConfigMap();
    loadedModelEnvHash = contentHash;
    return true;
  };

  const loadCombinedModelSettings = async () => ({
    ...await loadScoutModelSettings(modelEnvPath),
    reviewer: await loadReviewerModelSettings(modelEnvPath),
  });

  const persistAnalysisSession = async (session) => {
    if (typeof store.saveAnalysisSession !== 'function') return;
    try {
      await store.saveAnalysisSession(session);
    } catch {
      // Session history must never hide the model result or its error.
    }
  };

  async function executeReview({ frameId, signal, onProgress = () => {}, resumeSession = null }) {
    const modelResultId = `review-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const startedAt = resumeSession?.createdAt || new Date().toISOString();
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
    await persistAnalysisSession({
      id: modelResultId,
      kind: 'review',
      status: sessionStatus,
      frameId,
      model: process.env.MIDSCENE_MODEL_NAME || null,
      startedAt,
      updatedAt: startedAt,
      reasoningContent,
      outputContent,
    });
    try {
      emitProgress({ type: 'stage', phase: 'review', message: '正在重新识别冻结画面' });
      if (!server.agent) throw workbenchError(409, '请先连接 Android 设备');
      if (!process.env.MIDSCENE_MODEL_NAME) throw workbenchError(503, '未配置 AI Reviewer 模型，请设置 MIDSCENE_MODEL_*');
      if (!frameId) throw workbenchError(400, '缺少 frameId');
      if (frozenAgent !== server.agent || frozenFrameId !== frameId) {
        throw workbenchError(409, '当前进程没有该 frameId 的冻结上下文，请重新冻结画面后再识别');
      }
      const frozenFrame = await store.loadFrame(frameId);
      const currentDraft = await store.loadDraft();
      if (currentDraft.currentFrameId !== frameId) throw workbenchError(409, '草稿已经切换到其他冻结帧');
      const candidates = reviewCandidates(currentDraft);
      if (candidates.length === 0) throw workbenchError(422, '当前页面没有可供对照的 Scout 候选');
      signal?.throwIfAborted();
      resumableReview = null;
      const rawResult = await runReviewerModel({
        prompt: buildAIReviewDemand(currentDraft, candidates),
        imagePath: frozenFrame.imagePath,
        mimeType: frozenFrame.mimeType,
        continuationContent: resumeSession?.rawOutput || '',
        signal,
        onChunk: (chunk) => emitProgress({
          type: 'chunk',
          content: chunk.content || '',
          reasoningContent: chunk.reasoning_content || '',
        }),
      });
      signal?.throwIfAborted();
      resumableReview = null;
      emitProgress({ type: 'stage', phase: 'normalize-review', message: '正在整理 Reviewer 识别结果' });
      const { scout: normalizedResult, normalizationIssues } = normalizeScoutOutput(rawResult);
      delete normalizedResult.done;
      const schemaValid = validateScoutSchema(normalizedResult);
      const schemaErrors = structuredClone(validateScoutSchema.errors || []);
      if (!schemaValid) throw workbenchError(422, 'Reviewer 识别结果未通过结构检查', { schemaErrors, normalizationIssues });
      const completedAt = new Date().toISOString();
      const resultPath = await store.saveModelResult(modelResultId, {
        recordType: 'WorkbenchAIReviewResult',
        modelResultId,
        frameId,
        startedAt,
        completedAt,
        model: process.env.MIDSCENE_MODEL_NAME,
        rawResult,
        normalizedResult,
        normalizationIssues,
      });
      sessionStatus = 'completed';
      emitProgress({ type: 'stage', phase: 'review-compare', message: 'Reviewer 识别完成，请选择要保留的元素' });
      return {
        frameId,
        reviewerResult: normalizedResult,
        scoutCandidates: candidates,
        modelResultRef: path.relative(workbenchRoot, resultPath).split(path.sep).join('/'),
        reviewerModel: process.env.MIDSCENE_MODEL_NAME,
        reasoningContent,
        outputContent,
      };
    } catch (error) {
      if (signal?.aborted && (!error || typeof error !== 'object')) error = new Error('用户中断 Reviewer');
      sessionStatus = signal?.aborted ? 'cancelled' : 'failed';
      sessionError = signal?.aborted ? '用户中断 Reviewer' : error instanceof Error ? error.message : String(error);
      if (signal?.aborted) {
        resumableReview = {
          id: modelResultId,
          frameId,
          model: process.env.MIDSCENE_MODEL_NAME || null,
          rawOutput: error && typeof error === 'object' ? error.reviewerOutput || outputContent : outputContent,
          createdAt: startedAt,
          updatedAt: new Date().toISOString(),
          errorMessage: sessionError,
          reasoningContent,
          outputContent,
        };
        if (error && typeof error === 'object') {
          error.details = {
            ...(error.details || {}),
            resumableSession: publicReviewSession(resumableReview, true),
          };
        }
      }
      throw error;
    } finally {
      await persistAnalysisSession({
        id: modelResultId,
        kind: 'review',
        status: sessionStatus,
        frameId,
        model: process.env.MIDSCENE_MODEL_NAME || null,
        startedAt,
        updatedAt: new Date().toISOString(),
        errorMessage: sessionError,
        reasoningContent,
        outputContent,
      });
    }
  }

  const inspectScoutResult = (candidate) => {
    const { scout: normalizedResult, normalizationIssues } = normalizeScoutOutput(candidate);
    const schemaValid = validateScoutSchema(normalizedResult);
    const schemaErrors = structuredClone(validateScoutSchema.errors || []);
    return { normalizedResult, normalizationIssues, schemaValid, schemaErrors };
  };

  const publicScoutSession = (session, includeStreams = false) => session ? {
    id: session.id,
    status: 'paused',
    frameId: session.frameId,
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

  const publicReviewSession = (session, includeStreams = false) => session ? {
    id: session.id,
    status: 'paused',
    frameId: session.frameId,
    model: session.model,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    errorMessage: session.errorMessage,
    ...(includeStreams ? {
      reasoningContent: session.reasoningContent,
      outputContent: session.outputContent,
    } : {}),
  } : null;

  async function executeScout({ frameId, pageContext = '', signal, onProgress = () => {}, resumeSession = null }) {
    const modelResultId = `scout-${Date.now()}-${randomUUID().slice(0, 8)}`;
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
        kind: 'scout',
        status: sessionStatus,
        frameId: frameId || null,
        model: process.env.MIDSCENE_SCOUT_MODEL_NAME || null,
        startedAt: sessionStartedAt,
        updatedAt: new Date().toISOString(),
        reasoningContent,
        outputContent,
      });
      await syncModelRuntime();
      emitProgress({ type: 'stage', phase: 'validate', message: '正在校验冻结帧' });
      if (!server.agent) throw workbenchError(409, '请先连接 Android 设备');
      if (!process.env.MIDSCENE_SCOUT_MODEL_NAME) {
        throw workbenchError(503, '未配置独立 Scout 模型，请设置 MIDSCENE_SCOUT_MODEL_*');
      }
      if (!frameId) throw workbenchError(400, '缺少 frameId');
      const frozenFrame = await store.loadFrame(frameId);
      if (frozenAgent !== server.agent || frozenFrameId !== frameId) {
        throw workbenchError(409, '当前进程没有该 frameId 的冻结上下文，请重新冻结画面后再分析');
      }
      signal?.throwIfAborted();

      const startedAt = sessionStartedAt;
      modelStarted = true;
      emitProgress({
        type: 'stage',
        phase: resumeSession ? 'resume' : 'model',
        message: resumeSession ? '正在从已保存断点继续 Scout' : '模型正在分析画面',
      });
      resumableScout = null;
      const run = await runResumableScout({
        initialPrompt: buildScoutPrompt(frameId, pageContext),
        initialResult: resumeSession?.rawResult,
        initialFallback: { frameId, elements: [] },
        callScout: async (prompt, attempt) => {
          let accumulated = '';
          try {
            const onChunk = (chunk) => {
              accumulated = chunk.accumulated || accumulated;
              emitProgress({
                type: 'chunk',
                content: chunk.content || '',
                reasoningContent: process.env.MIDSCENE_SCOUT_MODEL_REASONING_ENABLED === 'true'
                  ? chunk.reasoning_content || ''
                  : '',
              });
            };
            if (typeof server.agent.aiScout === 'function') {
              return await server.agent.aiScout(prompt, {
                domIncluded: false,
                screenshotIncluded: true,
                stream: true,
                abortSignal: attempt.signal,
                onChunk,
              });
            }
            return await runScoutModel({
              prompt,
              imagePath: frozenFrame.imagePath,
              mimeType: frozenFrame.mimeType,
              signal: attempt.signal,
              onChunk,
            });
          } catch (error) {
            const recovered = recoverScoutCheckpointFromStream(accumulated);
            if (error && typeof error === 'object') {
              error.scoutCheckpoint = recovered;
              error.receivedContent = Boolean(accumulated.trim());
            }
            throw error;
          }
        },
        buildContinuationPrompt: (checkpoint, attempt) => buildScoutContinuationPrompt(frameId, pageContext, checkpoint, attempt),
        isComplete: (candidate) => inspectScoutResult(candidate).schemaValid,
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
      const { normalizedResult, normalizationIssues, schemaValid, schemaErrors } = inspectScoutResult(rawResult);
      const consistencyIssues = schemaValid ? validateScoutConsistency(normalizedResult) : [];
      const blockingConsistencyIssues = consistencyIssues.filter((issue) => issue.startsWith('候选键重复'));
      const record = {
        recordType: 'WorkbenchRawScoutResult',
        modelResultId,
        frameId,
        startedAt,
        completedAt: new Date().toISOString(),
        model: process.env.MIDSCENE_SCOUT_MODEL_NAME,
        frameIntegrity: frozenAgent === server.agent && frozenFrameId === frameId,
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
        resumableScout = {
          id: modelResultId,
          frameId,
          pageContext,
          model: process.env.MIDSCENE_SCOUT_MODEL_NAME || null,
          rawResult,
          completedCandidates: Array.isArray(rawResult?.elements) ? rawResult.elements.length : 0,
          retryAttempts,
          createdAt: sessionStartedAt,
          updatedAt: new Date().toISOString(),
          errorMessage: run.lastError,
          reasoningContent,
          outputContent,
        };
        throw workbenchError(502, run.lastError, {
          modelResultRef,
          retryLimit: SCOUT_ERROR_RETRY_LIMIT,
          retryAttempts,
          completedCandidates: Array.isArray(rawResult?.elements) ? rawResult.elements.length : 0,
          resumableSession: publicScoutSession(resumableScout, true),
        });
      }
      if (!schemaValid || !run.completed || blockingConsistencyIssues.length > 0) {
        throw workbenchError(422, 'Scout 输出未通过结构检查，原始结果已保留', {
          modelResultRef,
          schemaErrors,
          consistencyIssues,
        });
      }
      resumableScout = null;
      if (normalizedResult.frameId !== frameId) {
        throw workbenchError(422, 'Scout 返回的 frameId 与冻结帧不一致', { modelResultRef });
      }
      signal?.throwIfAborted();

      emitProgress({ type: 'stage', phase: 'merge', message: '正在合并候选元素到草稿' });
      const currentDraft = await store.loadDraft();
      const draft = mergeScoutIntoDraft(currentDraft, prepareScoutForDraft(normalizedResult), modelResultRef, process.env.MIDSCENE_SCOUT_MODEL_NAME);
      const issues = validateDraft(draft);
      signal?.throwIfAborted();
      await store.saveDraft(draft);
      emitProgress({ type: 'stage', phase: 'complete', message: 'Scout 分析完成' });
      sessionStatus = 'completed';
      return { draft, issues, modelResultRef };
    } catch (error) {
      if (signal?.aborted && (!error || typeof error !== 'object')) error = new Error('用户中断 Scout');
      sessionStatus = signal?.aborted ? 'cancelled' : 'failed';
      sessionError = signal?.aborted ? '用户中断 Scout' : error instanceof Error ? error.message : String(error);
      if (signal?.aborted) {
        const rawCheckpoint = error && typeof error === 'object'
          ? error.scoutRawResult || recoverScoutCheckpointFromStream(outputContent)
          : recoverScoutCheckpointFromStream(outputContent);
        const rawResultForResume = rawCheckpoint || { frameId, elements: [] };
        resumableScout = {
          id: modelResultId,
          frameId,
          pageContext,
          model: process.env.MIDSCENE_SCOUT_MODEL_NAME || null,
          rawResult: rawResultForResume,
          completedCandidates: Array.isArray(rawResultForResume?.elements) ? rawResultForResume.elements.length : 0,
          retryAttempts,
          createdAt: sessionStartedAt,
          updatedAt: new Date().toISOString(),
          errorMessage: sessionError,
          reasoningContent,
          outputContent,
        };
        if (error && typeof error === 'object') {
          error.details = {
            ...(error.details || {}),
            resumableSession: publicScoutSession(resumableScout, true),
          };
        }
      }
      if (modelStarted && !resultSaved) {
        try {
          const resultPath = await store.saveModelResult(modelResultId, {
            recordType: signal?.aborted ? 'WorkbenchScoutCancellation' : 'WorkbenchRawScoutFailure',
            modelResultId,
            frameId: frameId || null,
            completedAt: new Date().toISOString(),
            model: process.env.MIDSCENE_SCOUT_MODEL_NAME || null,
            error: signal?.aborted ? '用户中断 Scout' : error instanceof Error ? error.message : String(error),
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
        kind: 'scout',
        status: sessionStatus,
        frameId: frameId || null,
        model: process.env.MIDSCENE_SCOUT_MODEL_NAME || null,
        startedAt: sessionStartedAt,
        updatedAt: new Date().toISOString(),
        errorMessage: sessionError,
        reasoningContent,
        outputContent,
        retryAttempts,
      });
    }
  }

  function beginScoutSession() {
    if (activeScout) throw workbenchError(409, '已有 Scout 分析正在运行');
    const session = { id: randomUUID(), controller: new AbortController() };
    activeScout = session;
    scoutInProgress = true;
    return session;
  }

  function endScoutSession(session) {
    if (activeScout?.id !== session.id) return;
    activeScout = null;
    scoutInProgress = false;
  }

  function beginReviewSession() {
    if (scoutInProgress || reviewInProgress) throw workbenchError(409, '已有 AI 分析正在运行');
    const session = { id: randomUUID(), controller: new AbortController() };
    activeReview = session;
    reviewInProgress = true;
    return session;
  }

  function endReviewSession(session) {
    if (activeReview?.id !== session.id) return;
    activeReview = null;
    reviewInProgress = false;
  }

  server.app.use((req, res, next) => {
    if ((scoutInProgress || reviewInProgress) && req.path === '/interact') {
      return res.status(423).json({ error: 'AI 正在分析冻结帧，设备操作已临时锁定' });
    }
    next();
  });

  router.get('/status', async (_req, res, next) => {
    try {
      await syncModelRuntime();
      const session = server.getSessionState?.() || null;
      res.json({
        ok: true,
        agentConnected: Boolean(server.agent),
        scoutRunning: scoutInProgress,
        scoutConfigured: Boolean(process.env.MIDSCENE_SCOUT_MODEL_NAME),
        scoutModel: process.env.MIDSCENE_SCOUT_MODEL_NAME || null,
        reviewerConfigured: Boolean(process.env.MIDSCENE_MODEL_NAME),
        reviewerModel: process.env.MIDSCENE_MODEL_NAME || null,
        scoutSession: publicScoutSession(resumableScout),
        reviewSession: publicReviewSession(resumableReview),
        spec,
        session,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/scout/session', (_req, res) => {
    res.json({ session: publicScoutSession(resumableScout, true) });
  });

  router.get('/review/session', (_req, res) => {
    res.json({ session: publicReviewSession(resumableReview, true) });
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

  router.put('/model-settings', async (req, res, next) => {
    try {
      if (scoutInProgress || reviewInProgress) return res.status(409).json({ error: 'AI 分析正在运行，结束后才能切换模型' });
      const role = req.body?.role === 'reviewer' ? 'reviewer' : 'scout';
      if (role === 'reviewer') await saveReviewerModelSettings(modelEnvPath, req.body);
      else await saveScoutModelSettings(modelEnvPath, req.body);
      let runtimeReloaded = true;
      try {
        server.agent?.modelConfigManager?.clearModelConfigMap();
      } catch {
        runtimeReloaded = false;
      }
      res.json({ ...await loadCombinedModelSettings(), runtimeReloaded });
    } catch (error) {
      next(error);
    }
  });

  router.post('/device/tap', async (req, res, next) => {
    try {
      if (scoutInProgress || reviewInProgress) return res.status(423).json({ error: 'AI 正在分析冻结帧，设备操作已临时锁定' });
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

  router.post('/frames', async (_req, res, next) => {
    try {
      if (!server.agent) return res.status(409).json({ error: '请先连接 Android 设备' });
      await syncModelRuntime();
      const frame = await freezeAndCapture(server.agent);
      frozenAgent = server.agent;
      frozenFrameId = frame.frameId;
      const metadata = await store.saveFrame(frame);
      const draft = await store.loadDraft();
      const nextDraft = beginFrameCapture(draft, frame.frameId);
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

  router.post('/scout', async (req, res, next) => {
    let session;
    try {
      session = beginScoutSession();
      res.json(await executeScout({
        frameId: req.body?.frameId,
        pageContext: req.body?.pageContext || '',
        signal: session.controller.signal,
      }));
    } catch (error) {
      next(error);
    } finally {
      if (session) endScoutSession(session);
    }
  });

  async function streamScout(req, res, resumeSession = null) {
    let session;
    try {
      session = beginScoutSession();
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
      if (!responseComplete && activeScout?.id === session.id) session.controller.abort('Scout 流连接已关闭');
    });

    try {
      const result = await executeScout({
        frameId: resumeSession?.frameId || req.body?.frameId,
        pageContext: resumeSession?.pageContext || req.body?.pageContext || '',
        signal: session.controller.signal,
        onProgress: (event) => send(event.type, event),
        resumeSession,
      });
      send('result', result);
    } catch (error) {
      if (session.controller.signal.aborted) {
        send('cancelled', { message: 'Scout 已中断', ...(error?.details || {}) });
      } else {
        send('error', {
          message: error instanceof Error ? error.message : String(error),
          ...(error?.details || {}),
        });
      }
    } finally {
      responseComplete = true;
      endScoutSession(session);
      if (!res.writableEnded) res.end();
    }
  }

  router.post('/scout/stream', async (req, res) => {
    await streamScout(req, res);
  });

  router.post('/scout/resume/stream', async (req, res) => {
    if (!resumableScout || resumableScout.id !== req.body?.sessionId) {
      return res.status(404).json({ error: '没有可从断点继续的 Scout 会话' });
    }
    await streamScout(req, res, resumableScout);
  });

  router.post('/scout/cancel', (_req, res) => {
    if (!activeScout) return res.json({ cancelled: false });
    activeScout.controller.abort('用户中断 Scout');
    res.json({ cancelled: true });
  });

  async function streamReview(req, res, resumeSession = null) {
    let session;
    try {
      session = beginReviewSession();
      await syncModelRuntime();
    } catch (error) {
      if (session) endReviewSession(session);
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
      if (!responseComplete && activeReview?.id === session.id) session.controller.abort('Reviewer 流连接已关闭');
    });
    try {
      const result = await executeReview({
        frameId: resumeSession?.frameId || String(req.body?.frameId || ''),
        signal: session.controller.signal,
        onProgress: (event) => send(event.type, event),
        resumeSession,
      });
      send('result', result);
    } catch (error) {
      send(session.controller.signal.aborted ? 'cancelled' : 'error', {
        message: session.controller.signal.aborted ? 'Reviewer 已中断' : error instanceof Error ? error.message : String(error),
        ...(error?.details || {}),
      });
    } finally {
      responseComplete = true;
      endReviewSession(session);
      if (!res.writableEnded) res.end();
    }
  }

  router.post('/review/stream', async (req, res) => {
    await streamReview(req, res);
  });

  router.post('/review/resume/stream', async (req, res) => {
    if (!resumableReview || resumableReview.id !== req.body?.sessionId) {
      return res.status(404).json({ error: '没有可从断点继续的 Reviewer 会话' });
    }
    await streamReview(req, res, resumableReview);
  });

  router.post('/review/cancel', (_req, res) => {
    if (!activeReview) return res.json({ cancelled: false });
    activeReview.controller.abort('用户中断 Reviewer');
    res.json({ cancelled: true });
  });

  router.post('/review', async (req, res, next) => {
    if (scoutInProgress || reviewInProgress) return res.status(409).json({ error: '已有 AI 分析正在运行' });
    reviewInProgress = true;
    try {
      await syncModelRuntime();
      const result = await executeReview({ frameId: String(req.body?.frameId || '') });
      res.json(result);
    } catch (error) {
      next(error);
    } finally {
      reviewInProgress = false;
    }
  });

  router.post('/review/apply', async (req, res, next) => {
    try {
      const frameId = String(req.body?.frameId || '');
      const currentDraft = await store.loadDraft();
      if (!frameId || currentDraft.currentFrameId !== frameId) throw workbenchError(409, '草稿已经切换到其他冻结帧');
      const selectedScoutKeys = new Set(Array.isArray(req.body?.selectedScoutKeys) ? req.body.selectedScoutKeys.map(String) : []);
      const selectedReviewerKeys = new Set(Array.isArray(req.body?.selectedReviewerKeys) ? req.body.selectedReviewerKeys.map(String) : []);
      const { scout: reviewerResult } = normalizeScoutOutput(req.body?.reviewerResult || {});
      const selectedScout = currentDraft.elements.filter((element) => selectedScoutKeys.has(element.candidateKey));
      const scoutElements = selectedScout.map((element) => ({
        candidateKey: element.candidateKey,
        label: element.label,
        visualDescription: element.visualDescription,
        controlType: element.controlType,
        interactive: element.actionable === 'yes',
        enabled: element.enabled,
        state: element.state || null,
        approximateRegion: element.bbox,
        geometryKind: element.geometryKind,
        geometryConfidence: element.geometryConfidence,
        meaning: element.meaning,
        dynamicContent: element.dynamicContent,
        riskSignals: element.riskSignals,
        confidence: element.confidence,
      }));
      const selectedReviewerElements = (reviewerResult.elements || []).filter((element) => selectedReviewerKeys.has(element.candidateKey));
      const candidateByKey = new Map(scoutElements.map((element) => [element.candidateKey, element]));
      for (const element of selectedReviewerElements) candidateByKey.set(element.candidateKey, element);
      const selectedKeys = new Set(candidateByKey.keys());
      const combinedResult = {
        ...reviewerResult,
        frameId,
        elements: [...candidateByKey.values()],
        relationships: (reviewerResult.relationships || []).filter((relationship) => selectedKeys.has(relationship.fromCandidateKey) && selectedKeys.has(relationship.toCandidateKey)),
        actionCandidates: [
          ...(reviewerResult.actionCandidates || []).filter((action) => selectedKeys.has(action.triggerCandidateKey)),
          ...selectedScout.flatMap((element) => element.capabilities.map((capability) => ({
            triggerCandidateKey: element.candidateKey,
            action: SCOUT_ACTIONS.includes(capability) ? capability : 'other',
            expectedOutcome: null,
            basis: 'existing-graph',
            riskSignals: [],
            confidence: element.confidence,
          }))),
        ],
      };
      const draft = mergeScoutIntoDraft(currentDraft, prepareScoutForDraft(combinedResult), String(req.body?.modelResultRef || 'review-selection'), process.env.MIDSCENE_MODEL_NAME);
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

  router.get('/staging/:stageId', async (req, res, next) => {
    try {
      res.json(await graphWorkflow.loadStage(req.params.stageId));
    } catch (error) {
      next(error);
    }
  });

  router.post('/publish', async (req, res, next) => {
    try {
      const draft = await store.loadDraft();
      const result = await graphWorkflow.publish(req.body?.stageId, draft.revision);
      res.json(result);
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
