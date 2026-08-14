import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
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
  }

  async initialize() {
    await Promise.all([
      mkdir(this.framesRoot, { recursive: true }),
      mkdir(this.modelResultsRoot, { recursive: true }),
      mkdir(this.sessionsRoot, { recursive: true }),
    ]);
    if (!(await exists(this.draftPath))) {
      await this.saveDraft(createEmptyDraft());
    }
  }

  async loadDraft() {
    const draft = JSON.parse(await readFile(this.draftPath, 'utf8'));
    if (!draft.lastScoutModel && draft.rawModelResultRef) {
      const resultPath = path.join(this.modelResultsRoot, path.basename(draft.rawModelResultRef));
      if (await exists(resultPath)) {
        const modelResult = JSON.parse(await readFile(resultPath, 'utf8'));
        draft.lastScoutModel = modelResult.model || null;
      }
    }
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
      imagePath,
    };
    const metadataPath = this.frameMetadataPath(frame.frameId);
    if (!(await exists(metadataPath))) {
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
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
}
