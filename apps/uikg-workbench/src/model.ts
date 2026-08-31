import type { BBox, Draft, DraftElement, DraftPage, DraftTransition, ValidationIssue } from './types';

type Option = readonly [value: string, label: string];
type OptionGroup = { label: string; options: readonly Option[] };

export type PageWorkflowStatus = 'pending-recognition' | 'pending-review' | 'ready' | 'published';

export const pageWorkflowStatusLabels: Record<PageWorkflowStatus, string> = {
  'pending-recognition': '待识别',
  'pending-review': '待审核',
  ready: '待发布',
  published: '已发布',
};

export function recognizedFrameIdsForPage(draft: Draft, page: DraftPage): Set<string> {
  const frameIds = new Set(page.frameIds);
  return new Set(draft.elements
    .filter((element) => element.sourceFrameId
      && frameIds.has(element.sourceFrameId)
      && elementAvailableOnPage(element, page.id, draft.elements))
    .map((element) => element.sourceFrameId as string));
}

export function pageWorkflowStatus(draft: Draft, page: DraftPage): PageWorkflowStatus {
  const pageElements = draft.elements.filter((element) => elementAvailableOnPage(element, page.id, draft.elements));
  if (page.frameIds.length === 0
    || pageElements.length === 0
    || recognizedFrameIdsForPage(draft, page).size < page.frameIds.length) return 'pending-recognition';
  if (pageElements.some((element) => element.reviewStatus === 'pending')) return 'pending-review';
  return page.publishedAt ? 'published' : 'ready';
}

export const elementTypeGroups: readonly OptionGroup[] = [
  { label: '导航 Navigation', options: [
    ['navigation-bar', '导航栏'], ['sidebar', '侧边栏'], ['drawer', '抽屉'], ['hamburger', '汉堡菜单'],
    ['tab', '标签页'], ['breadcrumb', '面包屑'], ['page-indicator', '页面指示器'], ['pagination', '分页器'],
  ] },
  { label: '按钮/开关 Button & Switch', options: [
    ['text-button', '文字按钮'], ['icon-button', '图标按钮'], ['floating-button', '悬浮按钮'],
    ['switch', '开关'], ['slider', '滑块'],
  ] },
  { label: '输入 Input', options: [
    ['input', '单行输入框'], ['text-area', '多行输入框'], ['rich-text-input', '富文本输入框'],
  ] },
  { label: '选择器 Selector', options: [
    ['dropdown-selector', '下拉选择器'], ['radio', '单选选择器'], ['checkbox', '多选选择器'], ['wheel-picker', '滚轮选择器'],
    ['date-picker', '日期选择器'], ['time-picker', '时间选择器'], ['date-time-picker', '日期时间选择器'], ['number-picker', '数字选择器'],
    ['cascader', '级联选择器'], ['tag-selector', '标签选择器'], ['segmented-selector', '分段选择器'],
  ] },
  { label: '展示 Display', options: [
    ['text', '文本'], ['static-label', '静态标签'], ['title', '标题'], ['subtitle', '副标题'], ['caption', '辅助说明'], ['badge', '角标'],
    ['avatar', '头像'], ['image', '图片'], ['banner', '横幅'],
    ['thumbnail', '缩略图'], ['preview', '预览图'], ['carousel', '轮播图'],
  ] },
  { label: '容器 Container', options: [
    ['avatar-group', '头像组'], ['list', '列表'], ['list-item', '列表项'], ['grouped-list', '分组列表'], ['swipe-list', '侧滑列表'], ['expandable-list', '可展开列表'],
    ['card', '卡片'], ['panel', '面板'], ['section', '页面区域'], ['form', '表单'], ['table', '表格'], ['chart', '图表'],
    ['audio', '音频播放器'], ['video', '视频播放器'], ['image-viewer', '图片查看器'], ['file-preview', '文件预览器'],
  ] },
  { label: '弹层与反馈 Overlay & Feedback', options: [
    ['dialog', '弹窗'], ['confirm-dialog', '确认框'], ['bottom-sheet', '底部弹层'],
    ['popover', '泡泡框'], ['floating-card', '浮层卡片'], ['toast', 'Toast'],
  ] },
  { label: '进度 Progress', options: [
    ['progress-bar', '进度条'], ['loading', 'Loading'],
  ] },
  { label: '地图 Map', options: [
    ['map', '地图'], ['marker', '地图标记'], ['location', '位置'], ['route', '路线'], ['zoom-control', '缩放控件'], ['compass', '指南针'],
  ] },
  { label: '系统 System', options: [
    ['status-bar', '状态栏'], ['system-navigation-bar', '系统导航栏'], ['permission-dialog', '权限对话框'], ['keyboard', '键盘'],
    ['ime', '输入法'], ['system-dialog', '系统对话框'], ['notification', '通知'], ['quick-settings', '快捷设置'],
    ['system-date-picker', '系统日期选择器'], ['system-picker', '系统选择器'], ['share-sheet', '系统分享面板'],
  ] },
  { label: '手势 Gesture', options: [
    ['gesture-region', '手势区域'],
  ] },
];

export const elementTypeOptions = elementTypeGroups.flatMap((group) => group.options);

export const capabilityGroups: readonly OptionGroup[] = [{ label: '元素动作', options: [
  ['none', '无'], ['tap', '点击'], ['double_tap', '双击'], ['long_press', '长按'], ['input', '输入'],
  ['scroll_vertical', '纵向滚动'], ['scroll_horizontal', '横向滚动'], ['swipe', '滑动'], ['drag', '拖拽'], ['zoom', '缩放'], ['multi_touch', '多点触控'],
] }];

export const capabilityOptions = capabilityGroups.flatMap((group) => group.options);

export const capabilityLabel = (value: string) =>
  capabilityOptions.find(([key]) => key === value)?.[1] || value;

export const reviewStatusLabels = {
  pending: '待审核',
  accepted: '已审核通过',
  edited: '人工修订',
  rejected: '已忽略',
} as const;

export const elementTypeLabel = (value: string) =>
  elementTypeOptions.find(([key]) => key === value)?.[1] || value;

const typeGroup = (value: string) => elementTypeGroups.find((group) => group.options.some(([key]) => key === value));

export function defaultDescriptionForElementType(value: string) {
  const label = elementTypeLabel(value);
  const specificTemplates: Record<string, string> = {
    form: '围绕数据录入或提交组织的一组字段与操作',
    table: '按稳定的行列结构展示或编辑多条数据',
    dialog: '覆盖当前页面并承载内容或操作的弹窗',
    'confirm-dialog': '要求用户明确确认或取消的确认框',
    'bottom-sheet': '从屏幕底部出现的半屏或底部弹层',
    popover: '依附具体元素出现的上下文泡泡框',
    'floating-card': '悬浮于页面上方、可交互且可能自动消失的卡片；广告用途写入元素描述',
    toast: '无需交互、短暂显示的结果或状态反馈；具体级别写入元素描述',
  };
  if (specificTemplates[value]) return specificTemplates[value];
  const group = typeGroup(value)?.label.split(' ')[0] || '业务';
  const templates: Record<string, string> = {
    导航: `用于页面、层级或内容位置导航的${label}`,
    '按钮/开关': `用于触发操作或调整连续值的${label}`,
    输入: `用于接收用户输入的${label}`,
    选择器: `用于从候选项中选择一个或多个值的${label}`,
    展示: `用于展示页面内容的${label}`,
    容器: `用于组织、承载或呈现页面内容的${label}`,
    弹层与反馈: `覆盖当前页面或反馈操作结果的${label}`,
    滚动: `用于承载可滚动内容的${label}`,
    进度: `用于展示任务进度的${label}`,
    地图: `用于展示或操作地理信息的${label}`,
    系统: `由系统提供的${label}`,
    手势: `用于接收手势输入的${label}`,
  };
  return templates[group] || `页面中的${label}`;
}

const noActionGroups = new Set(['展示 Display', '进度 Progress', '系统 System']);
const noActionTypes = new Set(['avatar-group', 'card', 'panel', 'section', 'form', 'table', 'chart', 'dialog', 'confirm-dialog', 'bottom-sheet', 'popover', 'floating-card', 'toast']);
const inputTypes = new Set(['input', 'text-area', 'rich-text-input']);

export function recommendedActionsForElementType(value: string): string[] {
  const group = typeGroup(value)?.label || '';
  if (inputTypes.has(value)) return ['input'];
  if (value === 'slider') return ['tap', 'drag'];
  if (value === 'wheel-picker') return ['swipe'];
  if (value === 'number-picker') return ['tap', 'swipe'];
  if (['list', 'grouped-list'].includes(value)) return ['scroll_vertical'];
  if (value === 'carousel') return ['scroll_horizontal', 'swipe'];
  if (value === 'swipe-list') return ['scroll_vertical', 'swipe'];
  if (value === 'image-viewer') return ['swipe', 'zoom', 'multi_touch'];
  if (value === 'map') return ['tap', 'drag', 'zoom', 'multi_touch'];
  if (['sidebar', 'drawer'].includes(value)) return ['tap', 'swipe'];
  if (noActionTypes.has(value)) return ['none'];
  if (noActionGroups.has(group)) return ['none'];
  return ['tap'];
}

export function defaultActionEffect(value: string, action: string) {
  const label = elementTypeLabel(value);
  const group = typeGroup(value)?.label.split(' ')[0] || '业务';
  if (action === 'none') return `${label}仅展示或承载内容，不触发交互`;
  if (action === 'input') return `向${label}输入文本或数值`;
  if (action === 'scroll_vertical') return `纵向滚动${label}中的内容`;
  if (action === 'scroll_horizontal') return `横向滚动${label}中的内容`;
  if (action === 'swipe') return `滑动${label}以切换内容或状态`;
  if (action === 'drag') return `拖拽${label}或其中的目标对象`;
  if (action === 'zoom') return `缩放${label}中的内容`;
  if (action === 'multi_touch') return `在${label}上执行多点触控`;
  if (action === 'double_tap') return `双击${label}触发对应交互`;
  if (action === 'long_press') return `长按${label}打开扩展操作或状态`;
  if (group === '导航') return `点击${label}切换导航位置或进入对应内容`;
  if (group === '选择器') return `点击${label}更新当前选择`;
  if (group === '弹层与反馈') return `点击${label}触发弹层中的对应操作`;
  return `点击${label}触发对应操作`;
}

export function actionEffectsFor(value: string, actions: string[], current: DraftElement['actionEffects'] = []) {
  return actions.map((action) => ({ action, effect: current.find((item) => item.action === action)?.effect || defaultActionEffect(value, action) }));
}

export function interactionBoundaryForActions(actions: string[], current = 'candidate_bbox') {
  if (!actions.some((action) => action !== 'none')) return 'none';
  return current === 'none' ? 'candidate_bbox' : current;
}

export function normalizeGridCount(value: number) {
  return Math.min(12, Math.max(1, Math.round(Number(value) || 1)));
}

export function inferGridForBox(bbox: BBox) {
  const grid = gridForBox(bbox);
  return { columns: grid.columns, rows: grid.rows };
}

function gridAxisForBox(offset: number, size: number, maximumCount: number) {
  const maximum = normalizeGridCount(maximumCount);
  const candidateFor = (count: number) => {
    const start = Math.floor(offset * count);
    const end = Math.ceil((offset + size) * count - 1e-9) - 1;
    if (start !== end || start < 0 || end >= count) return null;
    const leftMargin = offset * count - start;
    const rightMargin = start + 1 - (offset + size) * count;
    // Keep at least 10% of the element size clear on both sides when possible.
    const minimumMargin = Math.max(0.025, size * count * 0.1);
    return { count, index: start, hasTolerance: Math.min(leftMargin, rightMargin) >= minimumMargin };
  };

  let fallback: { count: number; index: number; hasTolerance: boolean } | null = null;
  for (let count = maximum; count >= 1; count -= 1) {
    const candidate = candidateFor(count);
    if (!candidate) continue;
    fallback ||= candidate;
    if (candidate.hasTolerance) return candidate;
  }
  return fallback || { count: 1, index: 0, hasTolerance: false };
}

export function gridForBox(bbox: BBox, maximumColumns = 12, maximumRows = 12) {
  const column = gridAxisForBox(bbox.x, bbox.width, maximumColumns);
  const row = gridAxisForBox(bbox.y, bbox.height, maximumRows);
  return {
    columns: column.count,
    rows: row.count,
    region: row.index * column.count + column.index + 1,
  };
}

export function createHumanElement(bbox: BBox, pageId: string): DraftElement {
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
  const grid = gridForBox(bbox);
  return {
    id: `element-manual-${suffix}`,
    candidateKey: `manual.element.${suffix}`,
    label: '新元素',
    visualDescription: '',
    displayCondition: '',
    elementType: '',
    role: 'unknown',
    capabilities: ['none'],
    actionEffects: actionEffectsFor('', ['none']),
    enabled: null,
    state: '',
    dynamicContent: false,
    abstraction: null,
    bbox,
    gridColumns: grid.columns,
    gridRows: grid.rows,
    gridRegion: grid.region,
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
    interactionBoundary: 'none',
    reviewStatus: 'edited',
    source: 'human',
    aiModel: null,
    lastModelProposal: null,
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
    primaryFrameId: frameId,
    elementIds: [],
    publishedAt: null,
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
    capability: 'tap',
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
  for (const element of draft.elements) {
    if (!element.label.trim() && element.reviewStatus !== 'rejected') {
      issues.push({ level: 'error', code: 'label_required', elementId: element.id, message: '元素名称不能为空' });
    }
    if (!element.candidateKey.trim()) issues.push({ level: 'error', code: 'candidate_key_required', elementId: element.id, message: '候选键不能为空' });
    if (!element.elementType && element.reviewStatus !== 'rejected') issues.push({ level: 'error', code: 'element_type_required', elementId: element.id, message: '元素类型未识别，请由 AI 重新识别或人工补齐' });
    const b = element.bbox;
    if (b.x < 0 || b.y < 0 || b.width <= 0 || b.height <= 0 || b.x + b.width > 1 || b.y + b.height > 1) {
      issues.push({ level: 'error', code: 'bbox_invalid', elementId: element.id, message: '元素边框必须位于截图范围内' });
    }
    const calculatedGrid = gridForBox(element.bbox, element.gridColumns, element.gridRows);
    const validGrid = Number.isInteger(element.gridColumns) && element.gridColumns >= 1 && element.gridColumns <= 12
      && Number.isInteger(element.gridRows) && element.gridRows >= 1 && element.gridRows <= 12
      && element.gridColumns === calculatedGrid.columns
      && element.gridRows === calculatedGrid.rows
      && element.gridRegion === calculatedGrid.region;
    if (!validGrid) {
      issues.push({ level: 'error', code: 'grid_region_invalid', elementId: element.id, message: '宫格分块必须为 1 至 12，且单一区域需完整覆盖元素边框' });
    }
    if (element.parentId && !byId.has(element.parentId)) {
      issues.push({ level: 'error', code: 'parent_missing', elementId: element.id, message: '父级元素不存在' });
    }
    if (element.capabilities.length === 0) issues.push({ level: 'warning', code: 'capability_missing', elementId: element.id, message: '元素尚未设置动作' });
    if (element.capabilities.includes('none') && element.capabilities.length > 1) issues.push({ level: 'error', code: 'capability_none_conflict', elementId: element.id, message: '“无”不能与其他元素动作同时选择' });
    if (element.actionEffects.length !== element.capabilities.length) issues.push({ level: 'warning', code: 'action_effect_missing', elementId: element.id, message: '元素动作尚未填写完整效果' });
    if (element.reviewStatus === 'pending') {
      issues.push({ level: 'warning', code: 'review_pending', elementId: element.id, message: 'AI 候选尚未完成人工审核' });
    }
    if (element.riskSignals.includes('geometry-clamped-to-frame')) {
      issues.push({ level: 'warning', code: 'model_bbox_clamped', elementId: element.id, message: 'AI 候选框超出截图边缘，已自动裁剪，请人工校准' });
    }
    if (element.riskSignals.includes('model-action-inconsistent')) {
      issues.push({ level: 'warning', code: 'model_action_inconsistent', elementId: element.id, message: 'AI 对该元素的可操作性判断存在矛盾，请人工确认' });
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
      issues.push({
        level: 'error',
        code: 'transition_evidence_incomplete',
        pageIds: [transition.sourcePageId],
        message: `${transition.key}：${message}`,
      });
    }
  }

  const candidateKeyGroups = new Map<string, DraftElement[]>();
  for (const element of draft.elements) {
    const candidateKey = element.candidateKey.trim();
    if (!candidateKey) continue;
    const group = candidateKeyGroups.get(candidateKey) || [];
    group.push(element);
    candidateKeyGroups.set(candidateKey, group);
  }
  const pageIdsByElement = new Map(draft.elements.map((element) => [
    element.id,
    draft.pages.filter((page) => elementAvailableOnPage(element, page.id, draft.elements)).map((page) => page.id),
  ]));
  const pageName = (pageId: string) => draft.pages.find((page) => page.id === pageId)?.name || pageId;
  for (const [candidateKey, elements] of candidateKeyGroups) {
    if (elements.length < 2) continue;
    for (const element of elements) {
      const ownPageIds = pageIdsByElement.get(element.id) || [];
      const samePageElements = elements.filter((candidate) => candidate.id !== element.id && (pageIdsByElement.get(candidate.id) || []).some((pageId) => ownPageIds.includes(pageId)));
      if (samePageElements.length > 0) {
        const commonPageIds = [...new Set(samePageElements.flatMap((candidate) => (pageIdsByElement.get(candidate.id) || []).filter((pageId) => ownPageIds.includes(pageId))))];
        const pageLabel = commonPageIds.includes(draft.currentPageId)
          ? `本页面“${pageName(draft.currentPageId)}”`
          : `页面“${commonPageIds.map(pageName).join('、')}”`;
        issues.push({
          level: 'error',
          code: 'candidate_key_duplicate_current_page',
          elementId: element.id,
          candidateKey,
          relatedElementIds: [element.id, ...samePageElements.map((candidate) => candidate.id)],
          pageIds: commonPageIds,
          message: `${pageLabel}内有 ${samePageElements.length + 1} 个元素使用候选键：${candidateKey}`,
        });
      }
      const otherPageElements = elements.filter((candidate) => candidate.id !== element.id && !(pageIdsByElement.get(candidate.id) || []).some((pageId) => ownPageIds.includes(pageId)));
      if (otherPageElements.length > 0) {
        const otherPageIds = [...new Set(otherPageElements.flatMap((candidate) => pageIdsByElement.get(candidate.id) || []))];
        issues.push({
          level: 'error',
          code: 'candidate_key_duplicate_other_page',
          elementId: element.id,
          candidateKey,
          relatedElementIds: [element.id, ...otherPageElements.map((candidate) => candidate.id)],
          pageIds: [...new Set([...ownPageIds, ...otherPageIds])],
          message: `候选键 ${candidateKey} 与其他页面“${otherPageIds.map(pageName).join('、')}”的元素重复`,
        });
      }
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
