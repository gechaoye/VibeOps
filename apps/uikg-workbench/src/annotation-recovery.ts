import type { AnnotationTarget } from './annotation-tabs';
import type { Draft } from './types';

const ANNOTATION_RECOVERY_STORAGE_KEY = 'uikg-workbench.annotation-recovery.v1';

export interface UnsavedAnnotationRecovery {
  version: 1;
  tabId: string;
  title: string;
  sessionId: string;
  annotationTarget: AnnotationTarget | null;
  draft: Draft;
  savedAt: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRecoveryEntry(value: unknown): value is UnsavedAnnotationRecovery {
  if (!isObject(value) || value.version !== 1) return false;
  if (typeof value.tabId !== 'string' || typeof value.title !== 'string' || typeof value.sessionId !== 'string' || typeof value.savedAt !== 'string') return false;
  if (!isObject(value.draft) || !Array.isArray(value.draft.pages) || !Array.isArray(value.draft.elements) || typeof value.draft.currentPageId !== 'string') return false;
  if (value.annotationTarget === null) return true;
  return isObject(value.annotationTarget)
    && typeof value.annotationTarget.pageId === 'string'
    && (typeof value.annotationTarget.frameId === 'string' || value.annotationTarget.frameId === null)
    && typeof value.annotationTarget.sessionId === 'string';
}

export function readUnsavedAnnotationRecoveries(): UnsavedAnnotationRecovery[] {
  try {
    const raw = window.localStorage.getItem(ANNOTATION_RECOVERY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const byTabId = new Map<string, UnsavedAnnotationRecovery>();
    parsed.filter(isRecoveryEntry).forEach((entry) => byTabId.set(entry.tabId, entry));
    return [...byTabId.values()].sort((left, right) => left.savedAt.localeCompare(right.savedAt));
  } catch {
    return [];
  }
}

export function upsertUnsavedAnnotationRecovery(entry: UnsavedAnnotationRecovery): boolean {
  try {
    const entries = readUnsavedAnnotationRecoveries();
    const next = [...entries.filter((candidate) => candidate.tabId !== entry.tabId), entry];
    window.localStorage.setItem(ANNOTATION_RECOVERY_STORAGE_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

export function removeUnsavedAnnotationRecovery(tabId: string): void {
  try {
    const next = readUnsavedAnnotationRecoveries().filter((entry) => entry.tabId !== tabId);
    if (next.length > 0) window.localStorage.setItem(ANNOTATION_RECOVERY_STORAGE_KEY, JSON.stringify(next));
    else window.localStorage.removeItem(ANNOTATION_RECOVERY_STORAGE_KEY);
  } catch {}
}

export function clearUnsavedAnnotationRecoveries(): void {
  try {
    window.localStorage.removeItem(ANNOTATION_RECOVERY_STORAGE_KEY);
  } catch {}
}
