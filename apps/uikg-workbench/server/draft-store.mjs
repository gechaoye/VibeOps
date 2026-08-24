import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createEmptyDraft, normalizeDraftShape } from './draft-model.mjs';

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export class DraftStore {
  constructor(root) {
    this.root = root;
    this.draftPath = path.join(root, 'draft.json');
    this.framesRoot = path.join(root, 'evidence', 'frames');
    this.modelResultsRoot = path.join(root, 'evidence', 'model-results');
    this.sessionsRoot = path.join(root, 'sessions');
    this.pageUploadsRoot = path.join(root, 'page-uploads');
    this.pageUploadPartsRoot = path.join(this.pageUploadsRoot, 'parts');
  }

  async initialize() {
    await Promise.all([
      mkdir(this.framesRoot, { recursive: true }),
      mkdir(this.modelResultsRoot, { recursive: true }),
      mkdir(this.sessionsRoot, { recursive: true }),
      mkdir(this.pageUploadPartsRoot, { recursive: true }),
    ]);
    if (!(await exists(this.draftPath))) {
      await this.saveDraft(createEmptyDraft());
    }
    const interruptedTasks = (await this.listPageUploadTasks()).filter((task) => task.status === 'uploading');
    await Promise.all(interruptedTasks.map((task) => this.savePageUploadTask({
      ...task,
      status: 'failed',
      errorReason: '上传进程已中断，请重试以从断点继续',
      updatedAt: new Date().toISOString(),
    })));
    const interruptedSessions = (await this.listAnalysisSessions()).filter((session) => session.status === 'running');
    await Promise.all(interruptedSessions.map((session) => this.saveAnalysisSession({
      ...session,
      status: 'failed',
      errorMessage: '分析服务已重启，原模型连接无法继续',
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })));
  }

  async loadDraft() {
    const draft = JSON.parse(await readFile(this.draftPath, 'utf8'));
    return normalizeDraftShape(draft);
  }

  async saveDraft(draft) {
    await mkdir(path.dirname(this.draftPath), { recursive: true });
    const temporaryPath = `${this.draftPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.draftPath);
    return draft;
  }

  framePath(frameId, extension = 'png') {
    const digest = frameId.replace(/^sha256:/, '');
    return path.join(this.framesRoot, `${digest}.${extension}`);
  }

  frameMetadataPath(frameId) {
    const digest = frameId.replace(/^sha256:/, '');
    return path.join(this.framesRoot, `${digest}.json`);
  }

  async saveFrame(frame) {
    const imagePath = this.framePath(frame.frameId, frame.extension);
    if (!(await exists(imagePath))) await writeFile(imagePath, frame.buffer);
    const metadata = {
      frameId: frame.frameId,
      mimeType: frame.mimeType,
      extension: frame.extension,
      width: frame.width,
      height: frame.height,
      bytes: frame.buffer.length,
      capturedAt: frame.capturedAt,
      runtimeStructure: frame.runtimeStructure || null,
      imagePath,
    };
    const metadataPath = this.frameMetadataPath(frame.frameId);
    if (!(await exists(metadataPath))) {
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    } else if (metadata.runtimeStructure) {
      const existingMetadata = await this.loadFrame(frame.frameId);
      if (!existingMetadata.runtimeStructure) {
        await writeFile(metadataPath, `${JSON.stringify({ ...existingMetadata, runtimeStructure: metadata.runtimeStructure }, null, 2)}\n`, 'utf8');
      }
    }
    return metadata;
  }

  async loadFrame(frameId) {
    return JSON.parse(await readFile(this.frameMetadataPath(frameId), 'utf8'));
  }

  async saveModelResult(modelResultId, value) {
    const resultPath = path.join(this.modelResultsRoot, `${modelResultId}.json`);
    await writeFile(resultPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    return resultPath;
  }

  async saveAnalysisSession(session) {
    const safeId = String(session.id).replace(/[^a-zA-Z0-9._-]/g, '-');
    const sessionPath = path.join(this.sessionsRoot, `${safeId}.json`);
    const temporaryPath = `${sessionPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, sessionPath);
    return session;
  }

  async listAnalysisSessions() {
    const entries = await readdir(this.sessionsRoot, { withFileTypes: true });
    const sessions = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => JSON.parse(await readFile(path.join(this.sessionsRoot, entry.name), 'utf8'))));
    return sessions.sort((a, b) => String(b.updatedAt || b.startedAt).localeCompare(String(a.updatedAt || a.startedAt)));
  }

  pageUploadTaskPath(taskId) {
    return path.join(this.pageUploadsRoot, `${String(taskId).replace(/[^a-zA-Z0-9._-]/g, '-')}.json`);
  }

  pageUploadPartPath(taskId) {
    return path.join(this.pageUploadPartsRoot, `${String(taskId).replace(/[^a-zA-Z0-9._-]/g, '-')}.part`);
  }

  async savePageUploadTask(task) {
    const taskPath = this.pageUploadTaskPath(task.id);
    const temporaryPath = `${taskPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, taskPath);
    return task;
  }

  async loadPageUploadTask(taskId) {
    return JSON.parse(await readFile(this.pageUploadTaskPath(taskId), 'utf8'));
  }

  async listPageUploadTasks() {
    const entries = await readdir(this.pageUploadsRoot, { withFileTypes: true });
    const tasks = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => JSON.parse(await readFile(path.join(this.pageUploadsRoot, entry.name), 'utf8'))));
    return tasks.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async pageUploadPartSize(taskId) {
    try {
      return (await stat(this.pageUploadPartPath(taskId))).size;
    } catch (error) {
      if (error?.code === 'ENOENT') return 0;
      throw error;
    }
  }

  async appendPageUploadChunk(taskId, offset, buffer) {
    const currentSize = await this.pageUploadPartSize(taskId);
    if (currentSize !== offset) {
      const error = new Error(`上传偏移不一致，服务端已接收 ${currentSize} 字节`);
      error.code = 'UPLOAD_OFFSET_MISMATCH';
      error.expectedOffset = currentSize;
      throw error;
    }
    await writeFile(this.pageUploadPartPath(taskId), buffer, { flag: 'a' });
    return currentSize + buffer.length;
  }

  async resetPageUploadPart(taskId) {
    await writeFile(this.pageUploadPartPath(taskId), Buffer.alloc(0));
  }

  async loadPageUploadBuffer(taskId) {
    return readFile(this.pageUploadPartPath(taskId));
  }

  async deletePageUploadTask(taskId) {
    await Promise.allSettled([
      unlink(this.pageUploadTaskPath(taskId)),
      unlink(this.pageUploadPartPath(taskId)),
    ]);
  }
}
