import type { Draft } from './types';

export interface AnnotationTarget {
  pageId: string;
  frameId: string | null;
  sessionId: string;
}

export function createAnnotationSessionId(): string {
  if (typeof window.crypto?.randomUUID === 'function') return window.crypto.randomUUID();
  return `annotation-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function draftForAnnotationTarget(draft: Draft, target: AnnotationTarget): Draft | null {
  const page = draft.pages.find((candidate) => candidate.id === target.pageId);
  if (!page) return null;
  const frameId = target.frameId && page.frameIds.includes(target.frameId)
    ? target.frameId
    : page.frameIds.at(-1) || null;
  return {
    ...draft,
    currentPageId: page.id,
    currentFrameId: frameId,
    page: {
      id: page.id,
      key: page.key,
      name: page.name,
      surfaceType: page.surfaceType,
      stateSummary: page.stateSummary,
      scrollableRegions: page.scrollableRegions,
    },
  };
}
