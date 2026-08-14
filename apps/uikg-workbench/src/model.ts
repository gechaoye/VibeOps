import type { BBox, Draft, DraftElement, DraftPage, DraftTransition, ValidationIssue } from './types';

export const controlTypeOptions = [
  ['button', '按钮'], ['icon-button', '图标按钮'], ['switch', '开关'], ['checkbox', '复选框'],
  ['radio', '单选项'], ['tab', '标签页'], ['menu-item', '菜单项'], ['list-item', '列表项'],
  ['input', '输入框'], ['slider', '滑块'], ['status', '状态指示'], ['badge', '角标'],
  ['label', '文字标签'], ['image', '图片'], ['container', '容器'], ['other', '其他'],
] as const;

export const roleOptions = [
  ['container', '结构容器'], ['label', '说明文字'], ['current_value', '当前值'],
  ['action_trigger', '操作入口'], ['setting_control', '设置控件'], ['help_trigger', '帮助入口'],
  ['help_content', '帮助内容'], ['navigation', '导航元素'], ['status_indicator', '状态指示'],
  ['content_anchor', '内容锚点'], ['unknown', '待确认'],
] as const;

export const capabilityOptions = [
  ['click', '点击'], ['input', '输入'], ['toggle', '切换'], ['scroll_vertical', '纵向滚动'],
  ['swipe_horizontal', '横向滑动'], ['long_press', '长按'], ['drag', '拖动'],
  ['select', '选择'], ['open', '打开'], ['dismiss', '关闭'], ['back', '返回'], ['other', '其他'],
] as const;

export const reviewStatusLabels = {
  pending: '待审核',
  accepted: '已确认',
  edited: '人工修订',
  rejected: '已忽略',
} as const;

export const controlTypeLabel = (value: string) =>
  controlTypeOptions.find(([key]) => key === value)?.[1] || value;

export function createHumanElement(bbox: BBox, pageId: string): DraftElement {
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
  return {
    id: `element-manual-${suffix}`,
    candidateKey: `manual.element.${suffix}`,
    label: '新元素',
    visualDescription: '人工绘制的元素',
    controlType: 'other',
    role: 'unknown',
    capabilities: [],
    actionable: 'unknown',
    enabled: null,
    state: '',
    dynamicContent: false,
    bbox,
    geometryKind: 'approximate',
    geometryConfidence: 1,
    confidence: 1,
    meaning: {
      status: 'known',
      description: '人工标注',
      evidence: {
        visibleTexts: [],
        visibleIcons: [],
        visibleStates: [],
        visualCues: [],
        userContext: '人工绘制并标注',
        unclassified: [],
      },
    },
    riskSignals: [],
    ownerKind: 'page',
    ownerRef: pageId,
    parentId: null,
    childrenIds: [],
    pageId,
    availableOnPageIds: [],
    interactionBoundary: 'candidate_bbox',
    reviewStatus: 'edited',
    source: 'human',
    scoutModel: null,
    lastModelProposal: null,
    aiReview: null,
  };
}

export function createDraftPage(frameId: string | null): DraftPage {
  const suffix = crypto.randomUUID().slice(0, 8);
  return {
    id: `draft-page-${crypto.randomUUID()}`,
    key: `page.manual.${suffix}`,
    name: '新页面',
    surfaceType: 'page',
    stateSummary: '',
    scrollableRegions: [],
    featurePath: ['待归类'],
    frameIds: frameId ? [frameId] : [],
    elementIds: [],
  };
}

export function createDraftTransition(sourcePageId: string, targetPageId: string, triggerElementId: string, beforeFrameId = '', afterFrameId = ''): DraftTransition {
  const suffix = crypto.randomUUID().slice(0, 8);
  return {
    id: `draft-transition-${crypto.randomUUID()}`,
    key: `transition.manual.${suffix}`,
    sourcePageId,
    sourceStateKey: 'default',
    triggerElementId,
    action: 'aiTap',
    capability: 'click',
    targetPageId,
    targetStateKey: 'default',
    reversible: true,
    risk: 'safe',
    evidence: {
      beforeFrameId,
      locatorFrameId: beforeFrameId,
      actionTraceRef: '',
      afterFrameId,
      postcondition: 'pending',
      semanticAssertions: [],
    },
  };
}

export function transitionEvidenceIssues(transition: DraftTransition, draft: Draft): string[] {
  const issues: string[] = [];
  const trigger = draft.elements.find((element) => element.id === transition.triggerElementId);
  if (!draft.pages.some((page) => page.id === transition.sourcePageId)) issues.push('来源 Page 不存在');
  if (!draft.pages.some((page) => page.id === transition.targetPageId)) issues.push('目标 Page 不存在');
  if (!trigger) issues.push('触发元素不存在');
  if (trigger && !trigger.capabilities.includes(transition.capability)) issues.push('触发元素不具备所选能力');
  if (!transition.evidence.beforeFrameId) issues.push('缺少操作前画面');
  if (!transition.evidence.locatorFrameId) issues.push('缺少定位器所属画面');
  if (transition.evidence.locatorFrameId && transition.evidence.beforeFrameId !== transition.evidence.locatorFrameId) issues.push('定位器必须属于操作前画面');
  if (!transition.evidence.actionTraceRef.trim()) issues.push('缺少动作轨迹引用');
  if (!transition.evidence.afterFrameId) issues.push('缺少操作后画面');
  if (transition.evidence.postcondition !== 'pass') issues.push('后置条件尚未通过');
  if (!transition.evidence.semanticAssertions.some((item) => item.trim())) issues.push('缺少语义断言');
  return issues;
}

export function elementAvailableOnPage(element: DraftElement, pageId: string, elements: DraftElement[]): boolean {
  if (element.pageId === pageId) return true;
  const byId = new Map(elements.map((item) => [item.id, item]));
  let cursor: DraftElement | undefined = element;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    if (cursor.ownerKind === 'application' && cursor.availableOnPageIds.includes(pageId)) return true;
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return false;
}

export function validateDraftClient(draft: Draft): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map(draft.elements.map((element) => [element.id, element]));
  const keys = new Set<string>();
  for (const element of draft.elements) {
    if (!element.label.trim() && element.reviewStatus !== 'rejected') {
      issues.push({ level: 'error', code: 'label_required', elementId: element.id, message: '元素名称不能为空' });
    }
    if (keys.has(element.candidateKey)) {
      issues.push({ level: 'error', code: 'candidate_key_duplicate', elementId: element.id, message: `候选键重复：${element.candidateKey}` });
    }
    keys.add(element.candidateKey);
    const b = element.bbox;
    if (b.x < 0 || b.y < 0 || b.width <= 0 || b.height <= 0 || b.x + b.width > 1 || b.y + b.height > 1) {
      issues.push({ level: 'error', code: 'bbox_invalid', elementId: element.id, message: '元素边框必须位于截图范围内' });
    }
    if (element.parentId && !byId.has(element.parentId)) {
      issues.push({ level: 'error', code: 'parent_missing', elementId: element.id, message: '父级元素不存在' });
    }
    if (element.actionable === 'yes' && element.capabilities.length === 0) {
      issues.push({ level: 'warning', code: 'capability_missing', elementId: element.id, message: '可操作元素尚未设置支持操作' });
    }
    if (element.reviewStatus === 'pending') {
      issues.push({ level: 'warning', code: 'review_pending', elementId: element.id, message: 'AI 候选尚未完成人工审核' });
    }
    if (element.riskSignals.includes('geometry-clamped-to-frame')) {
      issues.push({ level: 'warning', code: 'scout_bbox_clamped', elementId: element.id, message: 'AI 候选框超出截图边缘，已自动裁剪，请人工校准' });
    }
    if (element.riskSignals.includes('model-action-inconsistent')) {
      issues.push({ level: 'warning', code: 'scout_action_inconsistent', elementId: element.id, message: 'AI 对该元素的可操作性判断存在矛盾，请人工确认' });
    }
    const visited = new Set([element.id]);
    let cursor: DraftElement | undefined = element;
    while (cursor?.parentId) {
      if (visited.has(cursor.parentId)) {
        issues.push({ level: 'error', code: 'owner_cycle', elementId: element.id, message: '元素父子关系存在循环' });
        break;
      }
      visited.add(cursor.parentId);
      cursor = byId.get(cursor.parentId);
    }
  }
  for (const transition of draft.transitions) {
    for (const message of transitionEvidenceIssues(transition, draft)) {
      issues.push({ level: 'error', code: 'transition_evidence_incomplete', message: `${transition.key}：${message}` });
    }
  }
  return issues;
}

export function clampBox(box: BBox): BBox {
  const width = Math.min(Math.max(box.width, 0.01), 1);
  const height = Math.min(Math.max(box.height, 0.01), 1);
  return {
    x: Math.min(Math.max(box.x, 0), 1 - width),
    y: Math.min(Math.max(box.y, 0), 1 - height),
    width,
    height,
  };
}
