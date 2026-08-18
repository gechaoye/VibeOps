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

export function pageWorkflowStatus(draft: Draft, page: DraftPage): PageWorkflowStatus {
  const pageElements = draft.elements.filter((element) => elementAvailableOnPage(element, page.id, draft.elements));
  if (page.frameIds.length === 0 || pageElements.length === 0) return 'pending-recognition';
  if (pageElements.some((element) => element.reviewStatus === 'pending')) return 'pending-review';
  return page.publishedAt ? 'published' : 'ready';
}

export const elementTypeGroups: readonly OptionGroup[] = [
  { label: '导航 Navigation', options: [
    ['navigation-bar', '导航栏'], ['sidebar', '侧边栏'], ['drawer', '抽屉'], ['hamburger', '汉堡菜单'],
    ['tab', '标签页'], ['breadcrumb', '面包屑'], ['page-indicator', '页面指示器'], ['pagination', '分页器'],
  ] },
  { label: '操作 Action', options: [
    ['text-button', '文字按钮'], ['icon-button', '图标按钮'], ['floating-button', '悬浮按钮'],
    ['radio', '单选项'], ['checkbox', '复选框'], ['switch', '开关'],
  ] },
  { label: '输入 Input', options: [
    ['input', '文本输入框'], ['search-input', '搜索输入框'], ['password-input', '密码输入框'], ['number-input', '数字输入框'],
    ['amount-input', '金额输入框'], ['url-input', 'URL 输入框'], ['email-input', '邮箱输入框'], ['phone-input', '手机号输入框'],
    ['verification-code-input', '验证码输入框'], ['pin-input', 'PIN 输入框'], ['text-area', '多行文本框'], ['search', '搜索组件'],
  ] },
  { label: '选择 Selection', options: [
    ['dropdown', '下拉框'], ['spinner', '下拉选择器'], ['select', '选择器'], ['date-picker', '日期选择器'],
    ['time-picker', '时间选择器'], ['date-time-picker', '日期时间选择器'], ['city-picker', '城市选择器'], ['number-picker', '数字选择器'],
    ['address-picker', '地址选择器'], ['autocomplete', '自动补全'], ['slider', '滑块'],
  ] },
  { label: '展示 Display', options: [
    ['text', '文本'], ['label', '文字标签'], ['title', '标题'], ['subtitle', '副标题'], ['caption', '辅助说明'], ['badge', '角标'],
    ['static-chip', '静态标签块'], ['selectable-chip', '可选标签块'], ['filter-chip', '筛选标签块'], ['action-chip', '操作标签块'],
    ['input-chip', '输入标签块'], ['avatar', '头像'], ['avatar-group', '头像组'], ['image', '图片'], ['banner', '横幅'],
    ['thumbnail', '缩略图'], ['preview', '预览图'], ['product-image', '商品图片'], ['carousel', '轮播图'],
  ] },
  { label: '列表 List', options: [
    ['list', '列表'], ['list-item', '列表项'], ['grouped-list', '分组列表'], ['swipe-list', '侧滑列表'], ['expandable-list', '可展开列表'],
  ] },
  { label: '容器 Container', options: [
    ['container', '容器'], ['card', '卡片'], ['panel', '面板'], ['section', '页面区域'], ['group', '元素组'], ['form', '表单'], ['grid', '网格'],
  ] },
  { label: '弹层 Overlay', options: [
    ['dialog', '对话框'], ['alert', '警告弹层'], ['confirm-dialog', '确认对话框'], ['bottom-sheet', '底部弹层'],
    ['popup', '弹出层'], ['tooltip', '文字提示'], ['snackbar', '底部提示条'], ['toast', '轻提示'],
  ] },
  { label: '滚动 Scroll', options: [
    ['scroll-view', '纵向滚动区'], ['horizontal-scroll', '横向滚动区'], ['recycler-view', '回收列表'], ['pager', '翻页容器'],
  ] },
  { label: '反馈 Feedback', options: [
    ['error', '错误反馈'], ['warning', '警告反馈'], ['success', '成功反馈'], ['info', '信息反馈'], ['status', '状态信息'],
  ] },
  { label: '进度 Progress', options: [
    ['progress-bar', '进度条'], ['circular-progress', '环形进度'], ['loading', '加载状态'], ['skeleton', '骨架屏'], ['download-progress', '下载进度'],
  ] },
  { label: '媒体 Media', options: [
    ['video', '视频'], ['audio', '音频'], ['image-viewer', '图片查看器'], ['camera', '相机'], ['file-preview', '文件预览'],
    ['live-stream', '直播'], ['screen-share', '屏幕共享'], ['remote-control', '远程控制'],
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
  { label: '业务 Business', options: [
    ['message-bubble', '消息气泡'], ['chat-input', '聊天输入框'], ['send-button', '发送按钮'], ['voice-button', '语音按钮'],
    ['emoji-button', '表情按钮'], ['attachment-button', '附件按钮'], ['mention', '提及'], ['reply', '回复'], ['forward', '转发'],
    ['read-status', '已读状态'], ['typing-indicator', '输入状态'], ['product-card', '商品卡片'], ['price', '价格'], ['discount', '折扣'],
    ['sku-selector', 'SKU 选择器'], ['quantity-stepper', '数量步进器'], ['cart-button', '购物车按钮'], ['buy-button', '购买按钮'],
    ['coupon', '优惠券'], ['approval-node', '审批节点'], ['approval-status', '审批状态'], ['signature', '签名'],
    ['department-selector', '部门选择器'], ['employee-selector', '人员选择器'], ['date-range', '日期范围'], ['file-item', '文件项'],
    ['folder', '文件夹'], ['file-tree', '文件树'], ['upload', '上传入口'], ['download', '下载入口'], ['rename', '重命名入口'],
    ['move', '移动入口'], ['share', '分享入口'], ['other', '其他元素'],
  ] },
];

export const elementTypeOptions = elementTypeGroups.flatMap((group) => group.options);

export const capabilityGroups: readonly OptionGroup[] = [{ label: '元素动作', options: [
  ['none', '无'], ['tap', '点击'], ['double_tap', '双击'], ['long_press', '长按'], ['input', '输入'], ['delete', '删除'],
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
  const group = typeGroup(value)?.label.split(' ')[0] || '业务';
  const templates: Record<string, string> = {
    导航: `用于页面、层级或内容位置导航的${label}`,
    操作: `用于触发用户操作的${label}`,
    输入: `用于接收用户输入的${label}`,
    选择: `用于选择候选值的${label}`,
    展示: `用于展示页面内容的${label}`,
    列表: `用于组织和展示重复内容的${label}`,
    容器: `用于组织页面元素的${label}`,
    弹层: `覆盖在当前页面上方的${label}`,
    滚动: `用于承载可滚动内容的${label}`,
    反馈: `用于反馈当前结果或状态的${label}`,
    进度: `用于展示任务进度的${label}`,
    媒体: `用于展示或控制媒体内容的${label}`,
    地图: `用于展示或操作地理信息的${label}`,
    系统: `由系统提供的${label}`,
    手势: `用于接收手势输入的${label}`,
    业务: `承载具体业务信息或操作的${label}`,
  };
  return templates[group] || `页面中的${label}`;
}

const noActionGroups = new Set(['展示 Display', '容器 Container', '反馈 Feedback', '进度 Progress', '系统 System']);
const inputTypes = new Set(['input', 'search-input', 'password-input', 'number-input', 'amount-input', 'url-input', 'email-input', 'phone-input', 'verification-code-input', 'pin-input', 'text-area', 'chat-input']);

export function recommendedActionsForElementType(value: string): string[] {
  const group = typeGroup(value)?.label || '';
  if (inputTypes.has(value)) return ['input'];
  if (['scroll-view', 'recycler-view', 'list', 'grouped-list'].includes(value)) return ['scroll_vertical'];
  if (['horizontal-scroll', 'carousel', 'pager'].includes(value)) return ['scroll_horizontal', 'swipe'];
  if (value === 'swipe-list') return ['scroll_vertical', 'swipe'];
  if (value === 'image-viewer') return ['swipe', 'zoom', 'multi_touch'];
  if (value === 'map') return ['tap', 'drag', 'zoom', 'multi_touch'];
  if (value === 'remote-control' || value === 'gesture-region') return ['tap', 'swipe', 'drag', 'zoom', 'multi_touch'];
  if (value === 'screen-share') return ['tap', 'zoom'];
  if (['sidebar', 'drawer'].includes(value)) return ['tap', 'swipe'];
  if (noActionGroups.has(group)) return ['none'];
  return ['tap'];
}

export function defaultActionEffect(value: string, action: string) {
  const label = elementTypeLabel(value);
  const group = typeGroup(value)?.label.split(' ')[0] || '业务';
  if (action === 'none') return `${label}仅展示或承载内容，不触发交互`;
  if (action === 'input') return `向${label}输入文本或数值`;
  if (action === 'delete') return `删除${label}对应的内容`;
  if (action === 'scroll_vertical') return `纵向滚动${label}中的内容`;
  if (action === 'scroll_horizontal') return `横向滚动${label}中的内容`;
  if (action === 'swipe') return `滑动${label}以切换内容或状态`;
  if (action === 'drag') return `拖拽${label}或其中的目标对象`;
  if (action === 'zoom') return `缩放${label}中的内容`;
  if (action === 'multi_touch') return `在${label}上执行多点触控`;
  if (action === 'double_tap') return `双击${label}触发对应交互`;
  if (action === 'long_press') return `长按${label}打开扩展操作或状态`;
  if (group === '导航') return `点击${label}切换导航位置或进入对应内容`;
  if (group === '选择') return `点击${label}更新当前选择`;
  if (group === '弹层') return `点击${label}触发弹层中的对应操作`;
  return `点击${label}触发对应操作`;
}

export function actionEffectsFor(value: string, actions: string[], current: DraftElement['actionEffects'] = []) {
  return actions.map((action) => ({ action, effect: current.find((item) => item.action === action)?.effect || defaultActionEffect(value, action) }));
}

export function interactionBoundaryForActions(actions: string[], current = 'candidate_bbox') {
  if (!actions.some((action) => action !== 'none')) return 'none';
  return current === 'none' ? 'candidate_bbox' : current;
}

export function createHumanElement(bbox: BBox, pageId: string): DraftElement {
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
  return {
    id: `element-manual-${suffix}`,
    candidateKey: `manual.element.${suffix}`,
    label: '新元素',
    visualDescription: defaultDescriptionForElementType('other'),
    controlType: 'other',
    role: 'unknown',
    capabilities: ['none'],
    actionEffects: actionEffectsFor('other', ['none']),
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
    interactionBoundary: 'none',
    reviewStatus: 'edited',
    source: 'human',
    workerModel: null,
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
    const b = element.bbox;
    if (b.x < 0 || b.y < 0 || b.width <= 0 || b.height <= 0 || b.x + b.width > 1 || b.y + b.height > 1) {
      issues.push({ level: 'error', code: 'bbox_invalid', elementId: element.id, message: '元素边框必须位于截图范围内' });
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
      issues.push({ level: 'warning', code: 'worker_bbox_clamped', elementId: element.id, message: 'AI 候选框超出截图边缘，已自动裁剪，请人工校准' });
    }
    if (element.riskSignals.includes('model-action-inconsistent')) {
      issues.push({ level: 'warning', code: 'worker_action_inconsistent', elementId: element.id, message: 'AI 对该元素的可操作性判断存在矛盾，请人工确认' });
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
