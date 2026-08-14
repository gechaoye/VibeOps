import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
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
import { applyAIReviews, buildAIReviewDemand, normalizeAIReviewOutput, reviewCandidates } from './ai-review.mjs';
import { loadReviewerModelSettings, loadScoutModelSettings, saveReviewerModelSettings, saveScoutModelSettings } from './model-settings.mjs';
import { recoverScoutCheckpointFromStream, runResumableScout, SCOUT_CONTINUATION_RETRY_LIMIT } from './resumable-scout.mjs';
import { runScoutModel } from './scout-client.mjs';

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

const SCOUT_ELEMENT_SHAPE = '{candidateKey: string, label: string|null, visualDescription: string, controlType: "button"|"icon-button"|"switch"|"checkbox"|"radio"|"tab"|"menu-item"|"list-item"|"input"|"slider"|"status"|"badge"|"label"|"image"|"container"|"other", interactive: boolean, enabled: boolean|null, state: string|null, approximateRegion: {x:number,y:number,width:number,height:number}, geometryKind:"boundary"|"tap-target"|"approximate", geometryConfidence:number, meaning:{status:"known"|"candidate"|"unknown",description:string|null,evidence:{visibleTexts:string[],visibleIcons:string[],visibleStates:string[],visualCues:string[],userContext:string|null,unclassified:{type:string,detail:string|null}[]}}, dynamicContent:boolean, riskSignals:string[], confidence:number}';

function buildScoutPrompt(frameId, pageContext = '') {
  return `Return one JSON object with exactly this structure:
{
  frameId: string,
  page: {name: string|null, surfaceType: "page"|"dialog"|"drawer"|"bottom-sheet"|"menu"|"shared-component"|"unknown", stateSummary: string, scrollableRegions: string[]},
  elements: [${SCOUT_ELEMENT_SHAPE}],
  relationships: [{fromCandidateKey:string,type:"contains"|"labels"|"controls"|"belongs-to"|"adjacent-to",toCandidateKey:string}],
  actionCandidates: [{triggerCandidateKey:string,action:"tap"|"input"|"scroll-vertical"|"swipe-horizontal"|"long-press"|"drag"|"toggle"|"select"|"open"|"dismiss"|"back"|"other",expectedOutcome:string|null,basis:"visible-affordance"|"user-context"|"requirement-document"|"existing-graph"|"authority-contract"|"unknown",riskSignals:string[],confidence:number}],
  comparison: {basisFrameId:null,status:"not-requested",changes:[]},
  uncertainties: string[]
}.
Inspect the entire stable Android screenshot. Inventory every visible control, label, icon, status indicator, structural container, stable content anchor and relationship. Separate a compound row container, descriptive label, current value and actual trigger. Distinguish vertical content scrolling (scroll-vertical), horizontal paging or control gestures (swipe-horizontal), holding in place (long-press), and moving an object to another position (drag). Record concrete observations in meaning.evidence; do not invent a categorical meaning.basis. Put visible strings in visibleTexts, recognizable icon shapes in visibleIcons, selected/disabled/toggle states in visibleStates, other shape/color/layout evidence in visualCues, and supplied user knowledge in userContext. Put evidence that does not fit these fields in unclassified without discarding it. Keep the JSON compact so the complete object finishes: use concise labels and descriptions, omit repeated wording, keep each evidence array to the smallest sufficient set, and always include every required top-level field through uncertainties before ending the response. approximateRegion uses normalized 0-to-1 fractions and must stay inside the frame. Candidate keys must be stable ASCII semantic keys and unique within the frame. Geometry is only a candidate, not a precise locator. Preserve unsupported meanings as unknown. Do not plan or execute actions. Set frameId exactly to ${JSON.stringify(frameId)}. User page context: ${pageContext || 'none supplied'}.`;
}

function buildScoutContinuationPrompt(frameId, pageContext, checkpoint, attempt) {
  return `Continue the same frozen-frame Scout inventory from checkpoint ${attempt}. Do not restart or repeat completed candidates.
Already completed candidates and coverage:
${JSON.stringify(checkpoint)}

Inspect the same screenshot and return one compact JSON object with only the remaining work:
{
  frameId: string,
  page: {name: string|null, surfaceType: "page"|"dialog"|"drawer"|"bottom-sheet"|"menu"|"shared-component"|"unknown", stateSummary: string, scrollableRegions: string[]},
  elements: [${SCOUT_ELEMENT_SHAPE}],
  relationships: [{fromCandidateKey:string,type:"contains"|"labels"|"controls"|"belongs-to"|"adjacent-to",toCandidateKey:string}],
  actionCandidates: [{triggerCandidateKey:string,action:"tap"|"input"|"scroll-vertical"|"swipe-horizontal"|"long-press"|"drag"|"toggle"|"select"|"open"|"dismiss"|"back"|"other",expectedOutcome:string|null,basis:"visible-affordance"|"user-context"|"requirement-document"|"existing-graph"|"authority-contract"|"unknown",riskSignals:string[],confidence:number}],
  comparison: {basisFrameId:null,status:"not-requested",changes:[]},
  uncertainties: string[],
  done: boolean
}.
Return only elements not listed in the checkpoint, using new stable ASCII candidateKey values. Include relationships and actions involving both existing and new candidate keys when needed. Distinguish scroll-vertical, swipe-horizontal, long-press, and drag; do not return the legacy action scroll. Set done=true only after every visible region through the bottom of the frame and every required top-level section is complete. Keep evidence concise. FrameId remains ${JSON.stringify(frameId)}. User page context: ${pageContext || 'none supplied'}.`;
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
  let frozenAgent = null;
  let frozenFrameId = null;

  const loadCombinedModelSettings = async () => ({
    ...await loadScoutModelSettings(modelEnvPath),
    reviewer: await loadReviewerModelSettings(modelEnvPath),
  });

  const inspectScoutResult = (candidate) => {
    const { scout: normalizedResult, normalizationIssues } = normalizeScoutOutput(candidate);
    const schemaValid = validateScoutSchema(normalizedResult);
    const schemaErrors = structuredClone(validateScoutSchema.errors || []);
    return { normalizedResult, normalizationIssues, schemaValid, schemaErrors };
  };

  const shouldContinueScout = (candidate) => inspectScoutResult(candidate).schemaErrors.some((error) => (
    error.instancePath === '' && error.keyword === 'required'
  ));

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

  async function executeScout({ frameId, pageContext = '', signal, onProgress = () => {}, resumeSession = null }) {
    const modelResultId = `scout-${Date.now()}-${randomUUID().slice(0, 8)}`;
    let rawResult = null;
    let modelStarted = false;
    let resultSaved = false;
    let retryAttempts = [];
    let reasoningContent = resumeSession?.reasoningContent || '';
    let outputContent = resumeSession?.outputContent || '';
    const emitProgress = (event) => {
      if (event.type === 'chunk') {
        reasoningContent += event.reasoningContent || '';
        outputContent += event.content || '';
      }
      onProgress(event);
    };
    try {
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

      const startedAt = resumeSession?.createdAt || new Date().toISOString();
      modelStarted = true;
      emitProgress({
        type: 'stage',
        phase: resumeSession ? 'resume' : 'model',
        message: resumeSession ? '正在从已保存断点继续 Scout' : '模型正在分析画面',
      });
      if (!resumeSession) resumableScout = null;
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
                reasoningContent: chunk.reasoning_content || '',
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
            if (signal?.aborted) signal.throwIfAborted();
            const recovered = recoverScoutCheckpointFromStream(accumulated);
            if (recovered) return recovered;
            throw error;
          }
        },
        buildContinuationPrompt: (checkpoint, attempt) => buildScoutContinuationPrompt(frameId, pageContext, checkpoint, attempt),
        isComplete: (candidate) => inspectScoutResult(candidate).schemaValid,
        shouldContinue: shouldContinueScout,
        signal,
        onRetry: ({ attempt, retryLimit, retryTimeoutMs, checkpoint }) => emitProgress({
          type: 'stage',
          phase: 'resume',
          message: `Scout 续写 ${attempt}/${retryLimit} · ${retryTimeoutMs / 1000} 秒`,
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

      const retryExhausted = !run.completed && retryAttempts.length === SCOUT_CONTINUATION_RETRY_LIMIT;
      if (retryExhausted) {
        const now = new Date().toISOString();
        resumableScout = {
          id: resumeSession?.id || randomUUID(),
          frameId,
          pageContext,
          model: process.env.MIDSCENE_SCOUT_MODEL_NAME,
          rawResult,
          completedCandidates: Array.isArray(rawResult?.elements) ? rawResult.elements.length : 0,
          retryAttempts,
          reasoningContent,
          outputContent,
          createdAt: resumeSession?.createdAt || startedAt,
          updatedAt: now,
          errorMessage: '自动续写 5 次仍未完成',
          modelResultRef,
        };
        throw workbenchError(422, 'Scout 自动续写 5 次仍未完成，可从断点继续', {
          modelResultRef,
          schemaErrors,
          consistencyIssues,
          resumableSession: publicScoutSession(resumableScout),
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
      return { draft, issues, modelResultRef };
    } catch (error) {
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

  server.app.use((req, res, next) => {
    if ((scoutInProgress || reviewInProgress) && req.path === '/interact') {
      return res.status(423).json({ error: 'AI 正在分析冻结帧，设备操作已临时锁定' });
    }
    next();
  });

  router.get('/status', async (_req, res) => {
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
      spec,
      session,
    });
  });

  router.get('/scout/session', (_req, res) => {
    res.json({ session: publicScoutSession(resumableScout, true) });
  });

  router.get('/model-settings', async (_req, res, next) => {
    try {
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
        send('cancelled', { message: 'Scout 已中断' });
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

  router.post('/review', async (req, res, next) => {
    if (scoutInProgress || reviewInProgress) return res.status(409).json({ error: '已有 AI 分析正在运行' });
    try {
      reviewInProgress = true;
      if (!server.agent) throw workbenchError(409, '请先连接 Android 设备');
      if (!process.env.MIDSCENE_MODEL_NAME) throw workbenchError(503, '未配置 AI Reviewer 模型，请设置 MIDSCENE_MODEL_*');
      const frameId = String(req.body?.frameId || '');
      if (!frameId) throw workbenchError(400, '缺少 frameId');
      if (frozenAgent !== server.agent || frozenFrameId !== frameId) {
        throw workbenchError(409, '当前进程没有该 frameId 的冻结上下文，请重新冻结画面后再初审');
      }
      const currentDraft = await store.loadDraft();
      if (currentDraft.currentFrameId !== frameId) throw workbenchError(409, '草稿已经切换到其他冻结帧');
      const candidates = reviewCandidates(currentDraft);
      if (candidates.length === 0) throw workbenchError(422, '当前页面没有可供 AI 初审的 Scout 候选');
      const modelResultId = `review-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const startedAt = new Date().toISOString();
      const rawResult = await server.agent.aiQuery(buildAIReviewDemand(currentDraft, candidates), {
        domIncluded: false,
        screenshotIncluded: true,
      });
      const reviewedAt = new Date().toISOString();
      const normalizedReviews = normalizeAIReviewOutput(rawResult, candidates, process.env.MIDSCENE_MODEL_NAME, reviewedAt);
      const resultPath = await store.saveModelResult(modelResultId, {
        recordType: 'WorkbenchAIReviewResult',
        modelResultId,
        frameId,
        startedAt,
        completedAt: reviewedAt,
        model: process.env.MIDSCENE_MODEL_NAME,
        rawResult,
        normalizedReviews,
      });
      const draft = applyAIReviews(currentDraft, normalizedReviews);
      await store.saveDraft(draft);
      res.json({
        draft,
        issues: validateDraft(draft),
        modelResultRef: path.relative(workbenchRoot, resultPath).split(path.sep).join('/'),
        reviewed: normalizedReviews.length,
        reviewerModel: process.env.MIDSCENE_MODEL_NAME,
      });
    } catch (error) {
      next(error);
    } finally {
      reviewInProgress = false;
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
