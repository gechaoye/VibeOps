import type { BBox, Draft, DraftElement, DraftPage, DraftTransition, ValidationIssue } from './types';

type Option = readonly [value: string, label: string];
type OptionGroup = { label: string; options: readonly Option[] };

export const elementTypeGroups: readonly OptionGroup[] = [
  { label: '导航 Navigation', options: [
    ['navigation-bar', '导航栏'], ['bottom-navigation', '底部导航'], ['tab', '标签页'], ['back', '返回'], ['close', '关闭'],
    ['menu', '菜单'], ['hamburger', '汉堡菜单'], ['breadcrumb', '面包屑'], ['pagination', '分页器'], ['stepper', '步骤导航'],
    ['sidebar', '侧边栏'], ['page-indicator', '页面指示器'],
  ] },
  { label: '操作 Action', options: [
    ['button', '按钮'], ['primary-button', '主按钮'], ['secondary-button', '次按钮'], ['text-button', '文字按钮'],
    ['icon-button', '图标按钮'], ['floating-button', '悬浮按钮'], ['menu-button', '菜单按钮'], ['menu-item', '菜单项'],
    ['danger-button', '危险操作按钮'], ['link-button', '链接按钮'], ['icon', '图标'], ['checkbox', '复选框'],
    ['radio', '单选项'], ['switch', '开关'], ['toggle-button', '切换按钮'],
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
    ['thumbnail', '缩略图'], ['preview', '预览图'], ['product-image', '商品图片'],
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
    ['scroll-view', '纵向滚动区'], ['horizontal-scroll', '横向滚动区'], ['recycler-view', '回收列表'], ['carousel', '轮播'], ['pager', '翻页容器'],
  ] },
  { label: '反馈 Feedback', options: [
    ['error', '错误反馈'], ['warning', '警告反馈'], ['success', '成功反馈'], ['info', '信息反馈'], ['status', '状态信息'],
  ] },
  { label: '进度 Progress', options: [
    ['progress-bar', '进度条'], ['circular-progress', '环形进度'], ['loading', '加载状态'], ['skeleton', '骨架屏'], ['download-progress', '下载进度'],
  ] },
  { label: '媒体 Media', options: [
    ['video', '视频'], ['audio', '音频'], ['image-viewer', '图片查看器'], ['camera', '相机'], ['file-preview', '文件预览'],
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

export const roleOptions = [
  ['container', '结构容器'], ['label', '说明文字'], ['current_value', '当前值'],
  ['action_trigger', '操作入口'], ['setting_control', '设置控件'], ['help_trigger', '帮助入口'],
  ['help_content', '帮助内容'], ['navigation', '导航元素'], ['status_indicator', '状态指示'],
  ['content_anchor', '内容锚点'], ['unknown', '待确认'],
] as const;

export const capabilityGroups: readonly OptionGroup[] = [
  { label: '基础交互', options: [
    ['tap', '点击'], ['double_tap', '双击'], ['long_press', '长按'],
  ] },
  { label: '输入与选择', options: [
    ['input', '输入'], ['clear', '清空'], ['submit', '提交'], ['toggle', '切换'], ['select', '选择'],
  ] },
  { label: '导航与层级', options: [
    ['open', '打开'], ['close', '关闭'], ['back', '返回'], ['expand', '展开'], ['collapse', '收起'], ['previous', '上一项'], ['next', '下一项'],
  ] },
  { label: '滚动与手势', options: [
    ['scroll_vertical', '纵向滚动'], ['scroll_horizontal', '横向滚动'], ['swipe', '滑动'], ['drag', '拖拽'], ['fling', '快速滑动'],
    ['pinch', '双指缩放'], ['zoom', '缩放'], ['rotate', '旋转'], ['multi_touch', '多点触控'],
  ] },
  { label: '媒体与相机', options: [
    ['play', '播放'], ['pause', '暂停'], ['seek', '定位进度'], ['fullscreen', '全屏'], ['volume', '调节音量'],
    ['capture', '拍照'], ['record', '录像'], ['switch_camera', '切换摄像头'], ['flash', '闪光灯'],
  ] },
  { label: '文件与业务', options: [
    ['upload', '上传'], ['download', '下载'], ['rename', '重命名'], ['move', '移动'], ['share', '分享'], ['other', '其他'],
  ] },
];

export const capabilityOptions = capabilityGroups.flatMap((group) => group.options);

export const reviewStatusLabels = {
  pending: '待审核',
  accepted: '已确认',
  edited: '人工修订',
  rejected: '已忽略',
} as const;

export const elementTypeLabel = (value: string) =>
  elementTypeOptions.find(([key]) => key === value)?.[1] || value;

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
