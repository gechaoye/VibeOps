import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmptyDraft, mergeScoutIntoDraft } from './draft-model.mjs';
import { draftTransitionIssues } from './graph-workflow.mjs';

function minimalScout() {
  return {
    frameId: 'sha256:before',
    page: { name: '来源页', surfaceType: 'page', stateSummary: '默认', scrollableRegions: [] },
    elements: [{
      candidateKey: 'source.open', label: '打开详情', visualDescription: '入口', controlType: 'button', interactive: true, enabled: true, state: null,
      approximateRegion: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 }, geometryKind: 'tap-target', geometryConfidence: 0.9,
      meaning: {
        status: 'known',
        description: '打开详情',
        evidence: { visibleTexts: ['打开详情'], visibleIcons: [], visibleStates: [], visualCues: [], userContext: null, unclassified: [] },
      }, dynamicContent: false, riskSignals: [], confidence: 0.9,
    }],
    relationships: [],
    actionCandidates: [{ triggerCandidateKey: 'source.open', action: 'tap', expectedOutcome: '详情页', basis: 'visible-affordance', riskSignals: [], confidence: 0.9 }],
    comparison: { basisFrameId: null, status: 'not-requested', changes: [] },
    uncertainties: [],
  };
}

test('Transition 仅在完整动作证据闭环后通过', () => {
  const draft = mergeScoutIntoDraft(createEmptyDraft(), minimalScout(), 'model.json', 'qwen3-vl-plus');
  draft.pages.push({ ...draft.pages[0], id: 'draft-page-target', key: 'page.target', name: '目标页', frameIds: ['sha256:after'], elementIds: [] });
  const transition = {
    id: 'draft-transition-1', key: 'source.open_target', sourcePageId: draft.currentPageId, sourceStateKey: 'default',
    triggerElementId: draft.elements[0].id, action: 'aiTap', capability: 'click', targetPageId: 'draft-page-target', targetStateKey: 'default',
    reversible: true, risk: 'safe',
    evidence: { beforeFrameId: 'sha256:before', locatorFrameId: 'sha256:before', actionTraceRef: 'trace:1', afterFrameId: 'sha256:after', postcondition: 'pass', semanticAssertions: ['目标页标题可见'] },
  };
  assert.deepEqual(draftTransitionIssues(transition, draft), []);
  transition.evidence.locatorFrameId = 'sha256:other';
  transition.evidence.postcondition = 'pending';
  assert.deepEqual(draftTransitionIssues(transition, draft), ['locator 必须属于 before Frame', '后置条件尚未通过']);
});
