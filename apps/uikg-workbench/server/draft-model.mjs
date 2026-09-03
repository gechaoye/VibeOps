import { createHash, randomUUID } from 'node:crypto';
import { ELEMENT_ACTIONS, ELEMENT_TYPES, RECOGNITION_ACTIONS } from './element-taxonomy.mjs';

const ELEMENT_TYPE_REPLACEMENTS = {
  'bottom-navigation': 'navigation-bar',
  back: 'icon-button',
  close: 'icon-button',
  menu: 'icon-button',
  stepper: 'pagination',
  button: 'text-button',
  'primary-button': 'text-button',
  'secondary-button': 'text-button',
  'menu-button': 'icon-button',
  'menu-item': 'text-button',
  'danger-button': 'text-button',
  'link-button': 'text-button',
  icon: 'image',
  'toggle-button': 'switch',
};
const EXCLUDED_SYSTEM_CHROME_TYPES = new Set(['status-bar', 'system-navigation-bar']);
const DATA_ENTRY_TYPES = new Set(['form', 'input', 'text-area', 'rich-text-input']);
const TITLE_TEXT_TYPES = new Set(['text', 'static-label', 'title', 'subtitle', 'caption']);
const BUSINESS_DYNAMIC_SEMANTIC_MARKER = 'business-dynamic-semantic-inferred';
const BUSINESS_DYNAMIC_TITLE_MARKER = 'business-dynamic-title-inferred';
const BUSINESS_REPORT_TERMS = /(?:日报|周报|月报|季报|年报|报告|汇报|工作日志)/u;
// "工作台" identifies a product surface, but does not by itself establish
// that an arbitrary label is a runtime value. Keep it out of the positive
// workflow gate used for generic business-value inference.
const BUSINESS_WORKFLOW_CONTEXT_TERMS = /(?:填写|编辑|提交|日志|日报|周报|月报|季报|年报|汇报|报告|表单)/u;
const BUSINESS_STRONG_ENTITY_TERMS = /(?:当前(?:登录)?(?:用户|账号|人员|填写人|提交人)|我的|本次(?:填写|提交)?|负责人|成员|员工|联系人|接收人|接收群|收件人|发送人|作者|创建人|所有者|群组|群聊|报告主体)/u;
const BUSINESS_GENERIC_ENTITY_TERMS = /(?:用户|账号|人员|填写人|提交人|组织|部门|团队|公司|单位|项目|任务|客户|供应商|对象)/u;
const BUSINESS_RUNTIME_ENTITY_TERMS = new RegExp(`(?:${BUSINESS_STRONG_ENTITY_TERMS.source}|${BUSINESS_GENERIC_ENTITY_TERMS.source})`, 'u');
const BUSINESS_IDENTITY_TERMS = BUSINESS_RUNTIME_ENTITY_TERMS;
const DYNAMIC_SUBJECT_TERMS = BUSINESS_RUNTIME_ENTITY_TERMS;
const DYNAMIC_TITLE_TERMS = /(?:姓名|名称|标题|日报|周报|月报|季报|年报|报告|汇报)/u;
const POSSESSIVE_BUSINESS_TITLE = /[^\s，。！？、:：;；“”‘’"'<>]{1,40}的(?:日报|周报|月报|季报|年报|报告|汇报)/u;
const GENERIC_BUSINESS_REPORT_TITLE = /(?:(?:日报|周报|月报|季报|年报|工作日志|报告|汇报)\s*(?:标题|名称|题目)|(?:标题|名称|题目)\s*(?:是|为|：|:)?\s*(?:日报|周报|月报|季报|年报|工作日志|报告|汇报))/u;
const GENERIC_BUSINESS_REPORT_TITLE_LABEL = /^(?:(?:日报|周报|月报|季报|年报|工作日志|报告|汇报)\s*(?:标题|名称|题目)|(?:标题|名称|题目)\s*(?:是|为|：|:)?\s*(?:日报|周报|月报|季报|年报|工作日志|报告|汇报))$/u;
const BUSINESS_RUNTIME_VALUE_TERMS = /(?:头像|图标|名称|姓名|昵称|标题|内容|封面|图片|组织|部门|团队|公司|单位|指标|数值|数量|时间|日期|状态|进度|结果|详情|卡片|列表|数据|记录|规则|信息|资料|文本|值)/u;
const BUSINESS_TEMPORAL_FIELD_TERMS = /(?:时间|日期|状态|进度)/u;
const BUSINESS_TEMPORAL_ROLE_TERMS = /(?:提交|填写|创建|更新|修改|截止|开始|结束|审核|审批|发布|处理|完成|交付|报告)/u;
// A visible value is stronger evidence than a generic field noun. Keep the
// pattern broad enough for times, dates, status words and percentages while
// avoiding a bare label such as "提交时间" or "任务状态".
const BUSINESS_OBSERVED_VALUE_PATTERN = /(?:[:：]\s*\S|(?:是|为)\s*\S|\d{1,4}\s*(?:年|月|日|时|分|秒|[-/:：])|\d+(?:\.\d+)?\s*%|(?:今天|昨天|明天|当日|本周|本月|已提交|已完成|进行中|成功|失败|草稿|待处理|开启|关闭))/u;
const BUSINESS_DYNAMIC_PAYLOAD_TYPES = new Set([
  'avatar', 'avatar-group', 'image', 'thumbnail', 'preview', 'banner', 'carousel',
  'badge', 'status', 'progress-bar', 'loading',
]);
const BUSINESS_DYNAMIC_CONTAINER_TYPES = new Set([
  'navigation-bar', 'sidebar', 'drawer', 'list', 'grouped-list', 'swipe-list',
  'expandable-list', 'list-item', 'card', 'panel', 'section', 'form', 'table',
  'chart', 'image-viewer', 'file-preview', 'dialog', 'confirm-dialog', 'bottom-sheet',
  'popover', 'floating-card', 'toast',
]);

function isDataEntryTemplate(elementType, abstraction) {
  return DATA_ENTRY_TYPES.has(elementType)
    || (abstraction?.fields || []).some((field) => DATA_ENTRY_TYPES.has(field.elementType));
}

function normalizeElementType(value) {
  const candidate = ELEMENT_TYPE_REPLACEMENTS[value] || value;
  return ELEMENT_TYPES.includes(candidate) ? candidate : '';
}

export const DRAFT_SCHEMA_VERSION = 'uikg-workbench-draft/1.1';

const MEANING_EVIDENCE_FIELDS = ['visibleTexts', 'visibleIcons', 'visibleStates', 'visualCues'];

export function normalizeGridCount(value) {
  return Math.min(12, Math.max(1, Math.round(Number(value) || 1)));
}

export function inferGridForBox(bbox) {
  const grid = gridForBox(bbox);
  return { columns: grid.columns, rows: grid.rows };
}

function gridAxisForBox(offset, size, maximumCount) {
  const maximum = normalizeGridCount(maximumCount);
  const candidateFor = (count) => {
    const start = Math.floor(offset * count);
    const end = Math.ceil((offset + size) * count - 1e-9) - 1;
    if (start !== end || start < 0 || end >= count) return null;
    const leftMargin = offset * count - start;
    const rightMargin = start + 1 - (offset + size) * count;
    // Keep at least 10% of the element size clear on both sides when possible.
    const minimumMargin = Math.max(0.025, size * count * 0.1);
    return { count, index: start, hasTolerance: Math.min(leftMargin, rightMargin) >= minimumMargin };
  };

  let fallback = null;
  for (let count = maximum; count >= 1; count -= 1) {
    const candidate = candidateFor(count);
    if (!candidate) continue;
    fallback ||= candidate;
    if (candidate.hasTolerance) return candidate;
  }
  return fallback || { count: 1, index: 0, hasTolerance: false };
}

export function gridForBox(bbox, maximumColumns = 12, maximumRows = 12) {
  const column = gridAxisForBox(bbox.x, bbox.width, maximumColumns);
  const row = gridAxisForBox(bbox.y, bbox.height, maximumRows);
  return {
    columns: column.count,
    rows: row.count,
    region: row.index * column.count + column.index + 1,
  };
}

function normalizeCapabilities(capabilities) {
  const normalized = [...new Set((Array.isArray(capabilities) ? capabilities : [])
    .filter((capability) => typeof capability === 'string' && capability.trim())
    .map((capability) => capability.trim())
    .filter((capability) => ELEMENT_ACTIONS.includes(capability)))];
  const actions = normalized.filter((capability) => capability !== 'none');
  return actions.length > 0 ? actions : ['none'];
}

function defaultActionEffect(elementType, action) {
  if (action === 'none') return `${elementType} 仅展示或承载内容，不触发交互`;
  if (action === 'input') return `向 ${elementType} 输入文本或数值`;
  if (action === 'scroll_vertical') return `纵向滚动 ${elementType} 中的内容`;
  if (action === 'scroll_horizontal') return `横向滚动 ${elementType} 中的内容`;
  if (action === 'swipe') return `滑动 ${elementType} 以切换内容或状态`;
  if (action === 'drag') return `拖拽 ${elementType} 或其中的目标对象`;
  if (action === 'zoom') return `缩放 ${elementType} 中的内容`;
  if (action === 'multi_touch') return `在 ${elementType} 上执行多点触控`;
  if (action === 'double_tap') return `双击 ${elementType} 触发对应交互`;
  if (action === 'long_press') return `长按 ${elementType} 打开扩展操作或状态`;
  return `点击 ${elementType} 触发对应操作`;
}

function normalizeActionEffects(actionEffects, elementType, capabilities) {
  const current = Array.isArray(actionEffects) ? actionEffects : [];
  return capabilities.map((action) => ({
    action,
    effect: current.find((item) => item?.action === action && typeof item?.effect === 'string')?.effect || defaultActionEffect(elementType, action),
  }));
}

function normalizeInteractionBoundary(interactionBoundary, capabilities) {
  if (!capabilities.some((capability) => capability !== 'none')) return 'none';
  return interactionBoundary === 'none' || !interactionBoundary ? 'candidate_bbox' : interactionBoundary;
}

const LIST_CONTAINER_TYPES = new Set(['list', 'grouped-list', 'swipe-list', 'expandable-list']);

function isInheritedAbstractListItem(element, parent) {
  return element?.abstraction?.kind === 'repeated-template' && LIST_CONTAINER_TYPES.has(parent?.elementType);
}

function normalizeAbstraction(rawAbstraction, fallbackKey = '') {
  if (!rawAbstraction || typeof rawAbstraction !== 'object' || !['repeated-template', 'dynamic-template'].includes(rawAbstraction.kind)) return null;
  const kind = rawAbstraction.kind;
  // A field can be absent in the middle of a repeated capture (for example a
  // title hidden by virtualization). Preserve that slot as null so the next
  // observed region keeps its template instance index. The outer template
  // regions remain concrete boxes and are normalized separately below.
  const normalizeFieldRegions = (regions) => (Array.isArray(regions)
    ? regions.map((region) => region && typeof region === 'object' ? clampUnitBox(region) : null)
    : []);
  const fields = Array.isArray(rawAbstraction.fields)
    ? rawAbstraction.fields.map((field, index) => ({
      key: typeof field?.key === 'string' && field.key.trim() ? field.key.trim() : `field-${index + 1}`,
      label: typeof field?.label === 'string' && field.label.trim() ? field.label.trim() : '重复字段',
      elementType: typeof field?.elementType === 'string' ? field.elementType : 'static-label',
      description: typeof field?.description === 'string' && field.description.trim() ? field.description.trim() : '同类列表项中的稳定字段',
      displayCondition: typeof field?.displayCondition === 'string' ? field.displayCondition : '',
      capabilities: normalizeCapabilities(field?.capabilities),
      interactionBoundary: normalizeInteractionBoundary(field?.interactionBoundary, normalizeCapabilities(field?.capabilities)),
      actionEffects: normalizeActionEffects(field?.actionEffects, typeof field?.elementType === 'string' && field.elementType ? field.elementType : 'static-label', normalizeCapabilities(field?.capabilities)),
      parentId: typeof field?.parentId === 'string' && field.parentId.trim() ? field.parentId.trim() : null,
      required: Boolean(field?.required),
      instanceRegions: normalizeFieldRegions(field?.instanceRegions),
    })).filter((field) => {
      // Legacy recognition sometimes hallucinated an avatar role without any visual evidence.
      // Keep real avatars when the model supplied at least one field-level bbox.
      const key = field.key.toLowerCase();
      return !(field.instanceRegions.every((region) => !region)
        && (key === 'avatar' || key === 'avatar-placeholder' || key === 'avatar-placeholder-icon'));
    })
    : [];
  const instanceRegions = Array.isArray(rawAbstraction.instanceRegions)
    ? rawAbstraction.instanceRegions.filter((region) => region && typeof region === 'object').map(clampUnitBox)
    : [];
  const instanceCount = kind === 'dynamic-template'
    ? 1
    : Math.max(2, Math.round(Number(rawAbstraction.instanceCount) || instanceRegions.length || 2));
  return {
    kind,
    templateKey: typeof rawAbstraction.templateKey === 'string' && rawAbstraction.templateKey.trim() ? rawAbstraction.templateKey.trim() : fallbackKey,
    instanceCount,
    fields,
    instanceRegions,
    bboxStyle: 'abstract',
  };
}

function evidenceDetail(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function uniqueUnclassified(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.type}\u0000${item.detail || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeMeaning(rawMeaning, onIssue = () => {}, captureUnexpectedBasis = true) {
  const meaning = rawMeaning && typeof rawMeaning === 'object' ? rawMeaning : {};
  const rawEvidence = meaning.evidence && typeof meaning.evidence === 'object' && !Array.isArray(meaning.evidence)
    ? meaning.evidence
    : {};
  const unclassified = [];
  const evidence = {};

  for (const field of MEANING_EVIDENCE_FIELDS) {
    const value = rawEvidence[field];
    if (Array.isArray(value)) {
      evidence[field] = [...new Set(value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
      for (const invalid of value.filter((item) => typeof item !== 'string')) {
        unclassified.push({ type: `${field}-invalid`, detail: evidenceDetail(invalid) });
        onIssue(`${field} 包含非文字证据`);
      }
    } else if (typeof value === 'string' && value.trim()) {
      evidence[field] = [value.trim()];
      onIssue(`${field} 应为数组，已保留单个文字值`);
    } else {
      evidence[field] = [];
      if (value !== null && value !== undefined) {
        unclassified.push({ type: `${field}-invalid`, detail: evidenceDetail(value) });
        onIssue(`${field} 的结构无法识别`);
      }
    }
  }

  evidence.userContext = typeof rawEvidence.userContext === 'string' && rawEvidence.userContext.trim()
    ? rawEvidence.userContext.trim()
    : null;
  if (rawEvidence.userContext !== null && rawEvidence.userContext !== undefined && typeof rawEvidence.userContext !== 'string') {
    unclassified.push({ type: 'userContext-invalid', detail: evidenceDetail(rawEvidence.userContext) });
    onIssue('userContext 的结构无法识别');
  }

  if (Array.isArray(rawEvidence.unclassified)) {
    for (const item of rawEvidence.unclassified) {
      if (item && typeof item === 'object' && typeof item.type === 'string' && item.type.trim()) {
        unclassified.push({ type: item.type.trim(), detail: evidenceDetail(item.detail) });
      } else {
        unclassified.push({ type: 'unclassified-invalid', detail: evidenceDetail(item) });
        onIssue('unclassified 包含无法识别的证据');
      }
    }
  } else if (rawEvidence.unclassified !== null && rawEvidence.unclassified !== undefined) {
    unclassified.push({ type: 'unclassified-invalid', detail: evidenceDetail(rawEvidence.unclassified) });
    onIssue('unclassified 应为数组');
  }

  const knownEvidenceKeys = new Set([...MEANING_EVIDENCE_FIELDS, 'userContext', 'unclassified']);
  for (const [key, value] of Object.entries(rawEvidence)) {
    if (knownEvidenceKeys.has(key)) continue;
    unclassified.push({ type: key, detail: evidenceDetail(value) });
    onIssue(`发现未定义的证据字段 ${key}`);
  }
  if (captureUnexpectedBasis && meaning.basis !== null && meaning.basis !== undefined) {
    const detail = evidenceDetail(meaning.basis);
    unclassified.push({ type: 'model-basis', detail });
    onIssue(`模型返回了未定义的 basis${detail ? `：${detail}` : ''}`);
  }
  if (captureUnexpectedBasis) {
    const knownMeaningKeys = new Set(['status', 'description', 'evidence', 'basis']);
    for (const [key, value] of Object.entries(meaning)) {
      if (knownMeaningKeys.has(key)) continue;
      unclassified.push({ type: `meaning.${key}`, detail: evidenceDetail(value) });
      onIssue(`发现未定义的 meaning 字段 ${key}`);
    }
  }
  evidence.unclassified = uniqueUnclassified(unclassified);

  const status = ['known', 'candidate', 'unknown'].includes(meaning.status) ? meaning.status : 'unknown';
  if (status !== meaning.status) onIssue('meaning.status 无法识别，已降级为 unknown');
  const description = typeof meaning.description === 'string' || meaning.description === null
    ? meaning.description
    : null;
  if (description !== meaning.description) onIssue('meaning.description 无法识别，已清空');
  return { status, description, evidence };
}

function normalizeDraftMeaning(rawMeaning) {
  const hasEvidence = Boolean(rawMeaning?.evidence && typeof rawMeaning.evidence === 'object');
  const meaning = normalizeMeaning(rawMeaning, () => {}, false);
  if (!hasEvidence) meaning.status = 'unknown';
  return meaning;
}

function hasClassifiedMeaningEvidence(evidence) {
  return MEANING_EVIDENCE_FIELDS.some((field) => evidence[field].length > 0) || Boolean(evidence.userContext);
}

function businessVisibleText(element) {
  const evidence = element?.meaning?.evidence || {};
  return [
    element?.label,
    ...(Array.isArray(evidence.visibleTexts) ? evidence.visibleTexts : []),
  ].filter((value) => typeof value === 'string' && value.trim()).join(' ');
}

function businessDescriptionText(element) {
  const evidence = element?.meaning?.evidence || {};
  return [
    element?.visualDescription,
    element?.meaning?.description,
    ...(Array.isArray(evidence.visualCues) ? evidence.visualCues : []),
    evidence.userContext,
  ].filter((value) => typeof value === 'string' && value.trim()).join(' ');
}

function businessSemanticText(element, pageContext = '') {
  return [businessVisibleText(element), businessDescriptionText(element), pageContext]
    .filter((value) => typeof value === 'string' && value.trim()).join(' ');
}

function businessDynamicTitleCue(element, pageContext = '') {
  if (!element || !TITLE_TEXT_TYPES.has(element.elementType) || element.interactive) return null;
  const elementText = businessSemanticText(element);
  const visibleText = businessVisibleText(element);
  const contextText = businessSemanticText(null, pageContext);
  const labelText = typeof element.label === 'string' ? element.label.trim() : '';
  // Strong report-title patterns must be visible text, not explanatory prose
  // from visualDescription/meaning.description. Descriptions can explain a
  // static rule or example that happens to mention another report.
  const reportTitle = POSSESSIVE_BUSINESS_TITLE.test(visibleText);
  const genericReportSlot = GENERIC_BUSINESS_REPORT_TITLE_LABEL.test(labelText)
    || GENERIC_BUSINESS_REPORT_TITLE_LABEL.test(visibleText);
  // A subject-plus-title phrase is title semantics only for a real heading.
  // Names and labels such as “接收人名称” are handled by the generic business
  // value path below so they can share the recipient identity template.
  const subjectTitle = element.elementType === 'title'
    && DYNAMIC_SUBJECT_TERMS.test(elementText) && DYNAMIC_TITLE_TERMS.test(elementText);
  const explicitRuntimeTitle = /(?:随(?:用户|账号|人员|日期|时间|状态|数据)|运行时(?:数据|内容)|动态(?:标题|内容)|当前用户对应|当前填写人)/u.test(elementText);
  const reportContext = BUSINESS_REPORT_TERMS.test(contextText);
  const workflowContext = BUSINESS_WORKFLOW_CONTEXT_TERMS.test(contextText);
  const workflowActionContext = /(?:填写|编辑|提交|日志|表单)/u.test(contextText);
  const contextualSubject = DYNAMIC_SUBJECT_TERMS.test(contextText);
  const structuralHeading = isBusinessStructuralHeading(element, elementText);
  const staticReportHeading = isStaticBusinessReportHeading(element);
  const structuralRoleLabel = isBusinessStructuralRoleLabel(labelText);
  const reportListContext = /(?:列表|列头|表头|列表页|清单|目录|搜索结果)/u.test(contextText);
  // A page-level heading may still be the business report title during a
  // fill/edit/submit flow. List/column/section headings remain static even
  // when their label happens to be the generic "日报标题" slot name.
  const reportTitleSlotAllowed = !structuralHeading
    || (workflowActionContext && !staticReportHeading && !structuralRoleLabel);
  const reportTitleContextAllowed = reportTitleSlotAllowed
    // A list/column/region heading is a structural label even when the model
    // happened to render a concrete subject (for example "张三的日报").
    // Do not let the possessive title shortcut bypass that boundary.
    && (!reportListContext || workflowActionContext)
    && !(reportListContext && structuralHeading);

  // A possessive business title such as "某人的日报" is a strong semantic
  // signal on its own. It identifies a runtime subject without relying on a
  // concrete name, candidate key, avatar or a particular screen geometry.
  if (reportTitle && reportTitleContextAllowed) {
    return { role: 'report-title', reason: '标题包含运行时主体和业务报告类型' };
  }
  if (subjectTitle && (reportContext || workflowContext || explicitRuntimeTitle)
    && reportTitleContextAllowed) {
    return { role: 'dynamic-title', reason: '标题含运行时主体语义并处于业务工作流上下文' };
  }
  // A model may call the visible slot simply "日报标题" while the page
  // context identifies it as the current user's report. In that case the
  // context supplies the missing business role; it still cannot create a
  // missing visual element or change its geometry.
  if (BUSINESS_REPORT_TERMS.test(visibleText) && (reportContext || workflowContext) && contextualSubject
    && reportTitleContextAllowed) {
    return { role: 'report-title', reason: '页面上下文确认报告标题属于运行时主体' };
  }
  // Recognition models often emit the slot label rather than the currently
  // rendered subject (for example, "日报标题"). In a report editing workflow
  // that label is still the runtime subject title; requiring workflow context
  // keeps ordinary static headings on unrelated pages unchanged.
  if ((genericReportSlot || GENERIC_BUSINESS_REPORT_TITLE.test(visibleText)) && reportContext
    && (workflowActionContext || contextualSubject)
    && reportTitleContextAllowed) {
    return { role: 'report-title', reason: '业务填写流程中的报告标题槽位' };
  }
  return null;
}

function businessRelationshipText(element) {
  const evidence = element?.meaning?.evidence || {};
  return [
    element?.label,
    ...(Array.isArray(evidence.visibleTexts) ? evidence.visibleTexts : []),
  ].filter((value) => typeof value === 'string' && value.trim()).join(' ');
}

function isBusinessStructuralHeading(element, elementText = businessSemanticText(element)) {
  if (!element || !TITLE_TEXT_TYPES.has(element.elementType)) return false;
  const label = typeof element.label === 'string' ? element.label.trim() : '';
  if (isBusinessStructuralRoleLabel(label)) return true;
  const description = [element.visualDescription, element.meaning?.description]
    .filter((value) => typeof value === 'string' && value.trim()).join(' ');
  const headingDescription = /(?:导航栏|页面(?:顶部|中央)?(?:显示)?(?:的)?(?:页面)?标题|区域(?:的)?(?:字段)?标题|区块(?:顶部|的)?(?:大号)?标题|列表(?:区域|标题)|设置(?:区域|区块)|说明文字|辅助文字|文件大小限制|选项文字|复选框.*文字|承载当前页面标题)/u.test(description);
  return headingDescription && !/(?:可见名称|显示名称|姓名|昵称|当前值|状态值|业务数据|动态|实时)/u.test(elementText);
}

function isBusinessStructuralRoleLabel(label) {
  return /^(?:接收人|接收群|收件人|发送人|群组|群聊|成员|负责人|当前用户|用户|更多|关联汇报|附件|附件和图片|图片和附件|文件和附件|工作日志|日志|日志日报|日报|周报|报告)$/u.test(String(label || '').trim());
}

function isStaticBusinessReportHeading(element) {
  if (!element || !TITLE_TEXT_TYPES.has(element.elementType)) return false;
  const description = [element.visualDescription, element.meaning?.description]
    .filter((value) => typeof value === 'string' && value.trim()).join(' ');
  return /(?:列表|列(?:表)?|表头|列头|区域|区块|分组|设置|说明|辅助|附件|选项|复选框|导航|菜单)/u.test(description);
}

function businessRelationshipContext(recognitionResult, element) {
  const elements = Array.isArray(recognitionResult?.elements) ? recognitionResult.elements : [];
  const byKey = new Map(elements.map((candidate) => [candidate?.candidateKey, candidate]));
  const relationships = Array.isArray(recognitionResult?.relationships) ? recognitionResult.relationships : [];
  const structuralParentTypes = new Set(['form', 'list', 'grouped-list', 'swipe-list', 'expandable-list', 'navigation-bar', 'sidebar', 'drawer']);
  const context = [];
  const visited = new Set([element?.candidateKey]);
  let childKey = element?.candidateKey;
  for (let depth = 0; depth < 4; depth += 1) {
    const parentCandidates = [...new Set(relationships
      .filter((relationship) => (
        ['contains', 'belongs-to'].includes(relationship?.type)
          && relationship.toCandidateKey === childKey
      ))
      .map((relationship) => relationship.fromCandidateKey)
      .map((parentKey) => byKey.get(parentKey))
      .filter((parent) => parent && !visited.has(parent.candidateKey)))];
    if (parentCandidates.length === 0) break;
    // Prefer the nearest semantic owner over a broad form/list ancestor, then
    // use geometry and candidateKey as deterministic tie-breakers. Relation
    // array order is an incidental model detail and must not change semantics.
    const semanticParents = parentCandidates.filter((parent) => !structuralParentTypes.has(parent.elementType));
    const parent = [...(semanticParents.length > 0 ? semanticParents : parentCandidates)].sort((left, right) => {
      const leftText = businessRelationshipText(left);
      const rightText = businessRelationshipText(right);
      const leftScore = (BUSINESS_STRONG_ENTITY_TERMS.test(leftText) ? 2 : 0)
        + (BUSINESS_GENERIC_ENTITY_TERMS.test(leftText) ? 1 : 0);
      const rightScore = (BUSINESS_STRONG_ENTITY_TERMS.test(rightText) ? 2 : 0)
        + (BUSINESS_GENERIC_ENTITY_TERMS.test(rightText) ? 1 : 0);
      if (rightScore !== leftScore) return rightScore - leftScore;
      const leftRegion = left.approximateRegion || {};
      const rightRegion = right.approximateRegion || {};
      const leftArea = (Number(leftRegion.width) || 1) * (Number(leftRegion.height) || 1);
      const rightArea = (Number(rightRegion.width) || 1) * (Number(rightRegion.height) || 1);
      return leftArea - rightArea || String(left.candidateKey).localeCompare(String(right.candidateKey));
    })[0] || null;
    if (!parent || visited.has(parent.candidateKey)) break;
    if (structuralParentTypes.has(parent.elementType)) break;
    visited.add(parent.candidateKey);
    // Only carry the parent's own label/visible text upward. Structural
    // descriptions frequently enumerate unrelated siblings (for example an
    // outer form mentioning both recipients and attachments), which would
    // otherwise make every child look like a recipient payload.
    context.push(businessRelationshipText(parent));
    childKey = parent.candidateKey;
    // The nearest semantic owner (for example a recipient section) is useful
    // evidence. Broad form/list ancestors usually enumerate unrelated
    // siblings and must not leak their business vocabulary into this field.
  }
  return context.filter(Boolean).join(' ');
}

function businessDynamicSemanticCue(element, pageContext = '', relationshipContext = '') {
  const interactivePayload = element?.interactive
    && ['avatar', 'avatar-group', 'image', 'thumbnail', 'preview'].includes(element.elementType);
  if (!element || (element.interactive && !interactivePayload) || DATA_ENTRY_TYPES.has(element.elementType)
    || BUSINESS_DYNAMIC_CONTAINER_TYPES.has(element.elementType)) return null;

  const titleCue = businessDynamicTitleCue(element, pageContext);
  if (titleCue) {
    return {
      ...titleCue,
      marker: BUSINESS_DYNAMIC_TITLE_MARKER,
      templateKey: titleCue.role === 'report-title' ? 'business.report-title' : 'business.dynamic-title',
    };
  }

  const elementText = businessSemanticText(element);
  const visibleText = businessVisibleText(element);
  const descriptionText = businessDescriptionText(element);
  const semanticText = `${visibleText} ${descriptionText} ${relationshipContext}`.trim();
  const contextText = businessSemanticText(null, pageContext);
  const strongIdentityEntity = BUSINESS_STRONG_ENTITY_TERMS.test(semanticText);
  const genericIdentityEntity = BUSINESS_GENERIC_ENTITY_TERMS.test(semanticText);
  const identityEntity = strongIdentityEntity || genericIdentityEntity;
  const relationIdentity = BUSINESS_STRONG_ENTITY_TERMS.test(relationshipContext);
  const genericRelationIdentity = BUSINESS_GENERIC_ENTITY_TERMS.test(relationshipContext);
  const directBusinessRole = /(?:接收人|接收群|收件人|发送人|联系人|成员|负责人|群组|群聊)/u.test(elementText);
  const valueTerm = BUSINESS_RUNTIME_VALUE_TERMS.test(visibleText)
    || BUSINESS_RUNTIME_VALUE_TERMS.test(descriptionText);
  const payloadType = BUSINESS_DYNAMIC_PAYLOAD_TYPES.has(element.elementType);
  // Status/progress are value-bearing fields, not intrinsically dynamic just
  // because the model chose a status/progress element type. Media and other
  // payload types may still use their type as supporting evidence.
  const temporalPayloadType = ['status', 'progress-bar'].includes(element.elementType);
  const intrinsicPayloadType = payloadType && !temporalPayloadType;
  const localStrongRuntimeTerm = /(?:运行时|动态|实时|最新|随(?:用户|账号|人员|日期|时间|状态|数据|配置|网络)|会(?:随|因).{0,12}(?:变化|替换|更新)|当前值|当前对象|数据源)/u.test(semanticText);
  const contextualStrongRuntimeTerm = /(?:运行时|动态|实时|最新|随(?:用户|账号|人员|日期|时间|状态|数据|配置|网络)|会(?:随|因).{0,12}(?:变化|替换|更新)|当前值|当前对象|数据源)/u.test(contextText);
  const explicitRuntimeValue = localStrongRuntimeTerm;
  // Only visible text can prove that a value is rendered. Descriptions may
  // discuss examples or rules and must not turn a structural label dynamic.
  const observedRuntimeValue = BUSINESS_OBSERVED_VALUE_PATTERN.test(visibleText);
  const temporalStatusField = temporalPayloadType || BUSINESS_TEMPORAL_FIELD_TERMS.test(semanticText);
  const workflowContext = BUSINESS_WORKFLOW_CONTEXT_TERMS.test(contextText);
  const reportContext = BUSINESS_REPORT_TERMS.test(contextText)
    || BUSINESS_REPORT_TERMS.test(relationshipContext);
  // A time/status/progress field is a runtime payload only when it exposes an
  // observed value (or explicitly says it is runtime data). A bare label such
  // as "提交时间" remains a structural field label. A business role or
  // workflow context strengthens a value match but cannot manufacture one.
  const temporalRuntimeEvidence = temporalStatusField
    && (observedRuntimeValue || explicitRuntimeValue)
    && (BUSINESS_TEMPORAL_ROLE_TERMS.test(semanticText)
      || observedRuntimeValue
      || explicitRuntimeValue);
  const structuralHeading = isBusinessStructuralHeading(element, elementText);
  const label = typeof element.label === 'string' ? element.label.trim() : '';
  const labelLooksLikePayload = Boolean(label)
    && !/(?:通过|允许|选择|添加|移除|发送|转发|切换|选项|说明|提示|限制|标题|区域|区块|设置|操作|入口|按钮)/u.test(label);
  const identityTextPayload = TITLE_TEXT_TYPES.has(element.elementType)
    && (relationIdentity || (genericRelationIdentity && workflowContext))
    && !structuralHeading
    && (valueTerm || labelLooksLikePayload);
  const textualRuntimePayload = TITLE_TEXT_TYPES.has(element.elementType)
    && (valueTerm || explicitRuntimeValue)
    && !structuralHeading;
  // Explicit runtime subjects are sufficient semantic evidence even when the
  // model emitted a single field with no section/relationship or sibling
  // avatar. This is intentionally based on the subject and value terms in the
  // field itself, not on its candidate key or location.
  const directSemanticPayload = !structuralHeading
    && strongIdentityEntity
    && (valueTerm || intrinsicPayloadType || temporalRuntimeEvidence);
  // Generic nouns such as "用户/项目/任务" need a strict workflow and a
  // visible/explicit value. The workbench surface or an element type alone is
  // not enough to make a generic field dynamic.
  const genericBusinessPayload = genericIdentityEntity
    && workflowContext
    && (observedRuntimeValue || explicitRuntimeValue || intrinsicPayloadType);
  const semanticRuntimeEvidence = explicitRuntimeValue || contextualStrongRuntimeTerm
    || strongIdentityEntity || directBusinessRole || relationIdentity || genericBusinessPayload
    || temporalRuntimeEvidence;

  // Business semantics may establish a runtime payload even when the model
  // emits only one visible field, but a structural heading is not a payload.
  // Media/status controls are payload candidates by type; text candidates
  // need a value term or a recipient/member owner. Explicit runtime wording
  // can establish the same fact without a relationship owner.
  if (structuralHeading) return null;
  if (!payloadType && !identityTextPayload && !textualRuntimePayload) return null;
  if (!semanticRuntimeEvidence && !directSemanticPayload) return null;
  if (!identityEntity && !explicitRuntimeValue && !contextualStrongRuntimeTerm && !temporalRuntimeEvidence) return null;

  const role = /(?:接收群|群组|群聊)/u.test(semanticText)
    ? 'recipient-group'
    : /(?:接收人|收件人|发送人|联系人)/u.test(semanticText)
      ? 'recipient-person'
      : 'business-value';
  const templateKey = role === 'recipient-group'
    ? 'business.recipient-group'
    : role === 'recipient-person' ? 'business.recipient-person' : 'business.dynamic-content';
  return {
    role,
    reason: explicitRuntimeValue || contextualStrongRuntimeTerm ? '业务语义确认可见槽位承载运行时数据' : '业务工作流确认可见槽位承载业务对象或数据',
    marker: BUSINESS_DYNAMIC_SEMANTIC_MARKER,
    templateKey,
  };
}

function dynamicFieldLabel(element, cue) {
  if (cue.role === 'report-title') return '日报标题';
  if (cue.role === 'recipient-group') {
    if (element.elementType === 'avatar' || element.elementType === 'avatar-group') return '接收群头像';
    return '接收群名称';
  }
  if (cue.role === 'recipient-person') {
    if (element.elementType === 'avatar' || element.elementType === 'avatar-group') return '接收人头像';
    return '接收人名称';
  }
  const labels = {
    avatar: '动态头像', 'avatar-group': '动态头像集合', image: '动态图片', thumbnail: '动态缩略图',
    preview: '动态预览', banner: '动态横幅', carousel: '动态轮播内容', badge: '动态状态角标',
    status: '动态状态', 'progress-bar': '动态进度', loading: '动态加载状态', title: '动态标题文本',
    subtitle: '动态辅助标题', caption: '动态说明文本', 'static-label': '动态业务文本',
  };
  return labels[element.elementType] || '动态业务字段';
}

function dynamicSemanticAbstraction(element, cue, actionCandidates = []) {
  const region = element?.approximateRegion && typeof element.approximateRegion === 'object'
    ? clampUnitBox(element.approximateRegion)
    : null;
  if (!region) return null;
  const current = element.abstraction?.kind === 'dynamic-template' ? element.abstraction : null;
  const fields = Array.isArray(current?.fields) && current.fields.length > 0
    ? current.fields.map((field) => ({ ...field }))
    : [{
      key: cue.role === 'report-title' ? 'report-title-text' : `business-${element.elementType || 'value'}-value`,
      label: dynamicFieldLabel(element, cue),
      elementType: element.elementType || 'static-label',
      description: cue.role === 'report-title'
        ? '标题主体来自运行时业务数据，当前文字仅作为本次观测。'
        : '字段主体来自运行时业务对象或业务数据，当前内容仅作为本次观测。',
      displayCondition: typeof element.displayCondition === 'string' ? element.displayCondition : '',
      capabilities: (() => {
        const actions = [...new Set(actionCandidates
          .filter((action) => action?.triggerCandidateKey === element.candidateKey)
          .map((action) => action.action)
          .filter((action) => RECOGNITION_ACTIONS.includes(action)))];
        return actions.length > 0 ? actions : (element.interactive ? ['tap'] : ['none']);
      })(),
      interactionBoundary: element.interactive ? 'candidate_bbox' : 'none',
      actionEffects: (() => {
        const actions = [...new Set(actionCandidates
          .filter((action) => action?.triggerCandidateKey === element.candidateKey)
          .map((action) => action.action)
          .filter((action) => RECOGNITION_ACTIONS.includes(action)))];
        const capabilities = actions.length > 0 ? actions : (element.interactive ? ['tap'] : ['none']);
        return normalizeActionEffects(element.actionEffects, element.elementType || 'static-label', capabilities);
      })(),
      parentId: element.candidateKey,
      required: false,
      instanceRegions: [region],
    }];
  const instanceRegions = Array.isArray(current?.instanceRegions) && current.instanceRegions.length > 0
    ? current.instanceRegions.filter((item) => item && typeof item === 'object').map(clampUnitBox)
    : [region];
  return {
    kind: 'dynamic-template',
    templateKey: cue.templateKey || (cue.role === 'report-title' ? 'business.report-title' : 'business.dynamic-title'),
    instanceCount: 1,
    fields: fields.map((field) => ({
      ...field,
      parentId: element.candidateKey,
      instanceRegions: Array.isArray(field.instanceRegions)
        ? field.instanceRegions.map((item) => item && typeof item === 'object' ? clampUnitBox(item) : null)
        : [],
    })),
    instanceRegions: [instanceRegions[0] || region],
    bboxStyle: 'abstract',
  };
}

// Kept as a small compatibility wrapper for callers/tests that used the old
// title-specific helper while the semantic inference itself is now generic.
function dynamicTitleAbstraction(element, cue) {
  return dynamicSemanticAbstraction(element, cue);
}

/**
 * Apply business-semantic dynamic inference without inventing visual facts.
 * The caller may pass user/page context; the recognition page metadata is
 * always included so the result remains deterministic when no extra context
 * is available (for example, when an older result is re-applied).
 */
export function applyBusinessDynamicSemantics(recognitionResult, pageContext = '') {
  if (!recognitionResult || typeof recognitionResult !== 'object') return 0;
  const page = recognitionResult.page || {};
  const context = [
    pageContext,
    page.name,
    page.stateSummary,
    ...(Array.isArray(page.scrollableRegions) ? page.scrollableRegions : []),
  ].filter((value) => typeof value === 'string' && value.trim()).join('；');
  let inferredCount = 0;
  for (const element of recognitionResult.elements || []) {
    const cue = businessDynamicSemanticCue(element, context, businessRelationshipContext(recognitionResult, element));
    const hasBusinessMarker = (element.riskSignals || []).some((signal) => (
      signal === BUSINESS_DYNAMIC_SEMANTIC_MARKER || signal === BUSINESS_DYNAMIC_TITLE_MARKER
    ));
    if (!cue) {
      // Remove stale inference markers produced by an earlier pass or an
      // older, overly broad rule set. Explicit model dynamic state remains
      // untouched unless the candidate is visibly a structural heading.
      if (hasBusinessMarker || (element.dynamicContent === true && isBusinessStructuralHeading(element))) {
        element.dynamicContent = false;
        element.abstraction = null;
        element.riskSignals = [...new Set([
          ...(element.riskSignals || []).filter((signal) => (
            signal !== BUSINESS_DYNAMIC_SEMANTIC_MARKER && signal !== BUSINESS_DYNAMIC_TITLE_MARKER
          )),
          'business-dynamic-semantic-cleared',
        ])];
      }
      continue;
    }
    if (!element.approximateRegion) continue;
    const abstraction = dynamicSemanticAbstraction(element, cue, recognitionResult.actionCandidates || []);
    if (!abstraction) continue;
    const wasDynamic = element.dynamicContent === true;
    element.dynamicContent = true;
    element.abstraction = abstraction;
    element.riskSignals = [...new Set([
      ...(element.riskSignals || []),
      BUSINESS_DYNAMIC_SEMANTIC_MARKER,
      ...(cue.marker === BUSINESS_DYNAMIC_TITLE_MARKER ? [BUSINESS_DYNAMIC_TITLE_MARKER] : []),
    ])];
    if (element.meaning && typeof element.meaning === 'object') {
      element.meaning = {
        ...element.meaning,
        status: element.meaning.status === 'unknown' ? 'candidate' : element.meaning.status,
        description: element.meaning.description || (cue.role === 'report-title'
          ? '显示业务上下文中的动态标题，当前主体文字仅作为本次观测。'
          : '显示业务上下文中的动态对象或数据，当前内容仅作为本次观测。'),
      };
    }
    if (!wasDynamic || !hasBusinessMarker) inferredCount += 1;
  }
  return inferredCount;
}

export function hasBusinessDynamicSemantics(element) {
  return (element?.riskSignals || []).some((signal) => (
    signal === BUSINESS_DYNAMIC_SEMANTIC_MARKER || signal === BUSINESS_DYNAMIC_TITLE_MARKER
  ));
}

export function normalizeRecognitionOutput(rawRecognitionResult, pageContext = '') {
  const recognitionResult = structuredClone(rawRecognitionResult);
  const normalizationIssues = [];
  if (!Array.isArray(recognitionResult?.elements)) return { recognitionResult, normalizationIssues };
  recognitionResult.elements = recognitionResult.elements.map((element, index) => {
    const repairIssues = [];
    const meaningIssues = [];
    const normalizedElement = { ...element };
    const rawMeaning = element?.meaning && typeof element.meaning === 'object' && !Array.isArray(element.meaning)
      ? element.meaning
      : {};
    const meaningInput = { ...rawMeaning };

    if (!normalizedElement.abstraction && rawMeaning.abstraction && typeof rawMeaning.abstraction === 'object' && !Array.isArray(rawMeaning.abstraction)) {
      normalizedElement.abstraction = rawMeaning.abstraction;
      delete meaningInput.abstraction;
      repairIssues.push('meaning.abstraction 已上提到元素顶层');
    }

    if (Object.hasOwn(normalizedElement, 'candidate_key')) {
      if ((!normalizedElement.candidateKey || typeof normalizedElement.candidateKey !== 'string')
        && typeof normalizedElement.candidate_key === 'string'
        && normalizedElement.candidate_key.trim()) {
        normalizedElement.candidateKey = normalizedElement.candidate_key.trim();
        repairIssues.push('candidate_key 已归一化为 candidateKey');
      } else {
        repairIssues.push('已移除 candidate_key 别名并保留 candidateKey');
      }
      delete normalizedElement.candidate_key;
    }

    if (normalizedElement.geometryKind === 'container') {
      normalizedElement.geometryKind = 'boundary';
      repairIssues.push('geometryKind 已从 container 归一化为 boundary');
    }

    if (typeof normalizedElement.elementType === 'string') {
      const rawElementType = normalizedElement.elementType.trim();
      const repairedElementType = ELEMENT_TYPE_REPLACEMENTS[rawElementType] || rawElementType;
      if (ELEMENT_TYPES.includes(repairedElementType)) {
        normalizedElement.elementType = repairedElementType;
        if (repairedElementType !== rawElementType) {
          repairIssues.push(`elementType 已从 ${rawElementType} 归一化为 ${repairedElementType}`);
        }
      } else {
        normalizedElement.elementType = '';
        normalizedElement.riskSignals = [...new Set([
          ...(Array.isArray(normalizedElement.riskSignals) ? normalizedElement.riskSignals : []),
          'element-type-needs-review',
        ])];
        repairIssues.push(`elementType ${rawElementType || '(empty)'} 未在当前分类中，已留空等待审核`);
      }
    }

    if (typeof rawMeaning.dynamicContent === 'boolean') {
      if (typeof normalizedElement.dynamicContent !== 'boolean') {
        normalizedElement.dynamicContent = rawMeaning.dynamicContent;
        repairIssues.push('meaning.dynamicContent 已上提到元素顶层');
      }
      delete meaningInput.dynamicContent;
    }
    if (typeof rawMeaning.confidence === 'number') {
      if (typeof normalizedElement.confidence !== 'number') {
        normalizedElement.confidence = rawMeaning.confidence;
        repairIssues.push('meaning.confidence 已上提到元素顶层');
      }
      delete meaningInput.confidence;
    }
    if (Array.isArray(rawMeaning.riskSignals)) {
      const topLevelRiskSignals = Array.isArray(normalizedElement.riskSignals) ? normalizedElement.riskSignals : [];
      normalizedElement.riskSignals = [...new Set([...topLevelRiskSignals, ...rawMeaning.riskSignals])];
      repairIssues.push('meaning.riskSignals 已上提到元素顶层');
      delete meaningInput.riskSignals;
    }

    const meaning = normalizeMeaning(meaningInput, (message) => meaningIssues.push(message));
    if (!hasClassifiedMeaningEvidence(meaning.evidence) && meaning.evidence.unclassified.length > 0 && meaning.status === 'known') {
      meaning.status = 'candidate';
      meaningIssues.push('只有待归类证据，语义状态已降级为 candidate');
    }
    const candidateKey = typeof normalizedElement.candidateKey === 'string' ? normalizedElement.candidateKey : `element-${index}`;
    normalizedElement.abstraction = normalizeAbstraction(normalizedElement.abstraction, candidateKey);
    if (normalizedElement.abstraction?.kind === 'dynamic-template'
      && isDataEntryTemplate(normalizedElement.elementType, normalizedElement.abstraction)) {
      normalizedElement.abstraction = null;
      normalizedElement.dynamicContent = false;
      normalizedElement.riskSignals = [...new Set([
        ...(Array.isArray(normalizedElement.riskSignals) ? normalizedElement.riskSignals : []),
        'data-entry-cannot-be-dynamic-template',
      ])];
      repairIssues.push('录入表单或输入字段不能作为 dynamic-template，已保留为普通录入结构');
    }
    const elementIssues = [...repairIssues, ...meaningIssues];
    if (elementIssues.length > 0) normalizationIssues.push({ elementIndex: index, candidateKey, messages: elementIssues });
    if (meaningIssues.length > 0) {
      normalizedElement.riskSignals = [...new Set([
        ...(Array.isArray(normalizedElement.riskSignals) ? normalizedElement.riskSignals : []),
        'meaning-evidence-needs-review',
      ])];
    }
    return { ...normalizedElement, meaning };
  });
  const excludedKeys = new Set(recognitionResult.elements
    .filter((element) => EXCLUDED_SYSTEM_CHROME_TYPES.has(element.elementType))
    .map((element) => element.candidateKey));
  const childKeysByParent = new Map();
  for (const relationship of Array.isArray(recognitionResult.relationships) ? recognitionResult.relationships : []) {
    if (relationship?.type !== 'contains') continue;
    const children = childKeysByParent.get(relationship.fromCandidateKey) || [];
    children.push(relationship.toCandidateKey);
    childKeysByParent.set(relationship.fromCandidateKey, children);
  }
  const pending = [...excludedKeys];
  while (pending.length > 0) {
    for (const childKey of childKeysByParent.get(pending.pop()) || []) {
      if (excludedKeys.has(childKey)) continue;
      excludedKeys.add(childKey);
      pending.push(childKey);
    }
  }
  if (excludedKeys.size > 0) {
    recognitionResult.elements = recognitionResult.elements.filter((element) => !excludedKeys.has(element.candidateKey));
    recognitionResult.relationships = (recognitionResult.relationships || []).filter((relationship) => (
      !excludedKeys.has(relationship.fromCandidateKey) && !excludedKeys.has(relationship.toCandidateKey)
    ));
    recognitionResult.actionCandidates = (recognitionResult.actionCandidates || []).filter((action) => !excludedKeys.has(action.triggerCandidateKey));
    normalizationIssues.push({
      section: 'system-chrome',
      messages: [`已排除 ${excludedKeys.size} 个系统状态栏、系统导航栏或其子元素`],
    });
  }
  const recognizedCandidateKeys = new Set(recognitionResult.elements.map((element) => element.candidateKey));
  recognitionResult.elements.forEach((element, elementIndex) => {
    for (const field of element.abstraction?.fields || []) {
      if (!field.parentId || recognizedCandidateKeys.has(field.parentId)) continue;
      const invalidParentId = field.parentId;
      field.parentId = element.candidateKey;
      const summarizedParentId = `${invalidParentId.slice(0, 120)}${invalidParentId.length > 120 ? '...' : ''}`;
      const message = `共相字段 ${field.key} 的父级 ${summarizedParentId} 不在当前识别候选中，已回退到 ${element.candidateKey}`;
      const existingIssue = normalizationIssues.find((issue) => issue.elementIndex === elementIndex && issue.candidateKey === element.candidateKey);
      if (existingIssue) existingIssue.messages.push(message);
      else normalizationIssues.push({ elementIndex, candidateKey: element.candidateKey, messages: [message] });
    }
  });
  if (Array.isArray(recognitionResult.actionCandidates)) {
    recognitionResult.actionCandidates = recognitionResult.actionCandidates.map((actionCandidate, index) => {
      const messages = [];
      const normalized = { ...actionCandidate };
      if (actionCandidate?.basis === 'visible-icon') {
        normalized.basis = 'visible-affordance';
        messages.push('actionCandidates.basis 已从 visible-icon 归一化为 visible-affordance');
      }
      if (messages.length > 0) {
        normalizationIssues.push({
          actionCandidateIndex: index,
          candidateKey: typeof actionCandidate.triggerCandidateKey === 'string' ? actionCandidate.triggerCandidateKey : `action-${index}`,
          messages,
        });
      }
      return normalized;
    });
  }
  if (recognitionResult.comparison && typeof recognitionResult.comparison === 'object' && Array.isArray(recognitionResult.comparison.changes)) {
    const rawChanges = recognitionResult.comparison.changes;
    if (recognitionResult.comparison.status === 'not-requested' && rawChanges.length > 0) {
      recognitionResult.comparison.changes = [];
      normalizationIssues.push({
        section: 'comparison',
        messages: [`comparison.status 为 not-requested，已移除 ${rawChanges.length} 条模型说明`],
      });
    } else if (rawChanges.some((change) => typeof change === 'string')) {
      recognitionResult.comparison.changes = rawChanges.map((change) => (
        typeof change === 'string' ? { summary: change } : change
      ));
      normalizationIssues.push({
        section: 'comparison',
        messages: ['comparison.changes 中的文字说明已归一化为对象'],
      });
    }
  }
  applyBusinessDynamicSemantics(recognitionResult, pageContext);
  return { recognitionResult, normalizationIssues };
}

function pageKeyFromName(name) {
  const ascii = String(name || 'page')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  const fallback = createHash('sha256').update(String(name || 'current')).digest('hex').slice(0, 12);
  return `page.${ascii || fallback}`;
}

function draftPageId() {
  return `draft-page-${randomUUID()}`;
}

function makeDraftPage(page, frameId = null, featurePath = []) {
  return {
    id: page.id || draftPageId(),
    key: page.key || pageKeyFromName(page.name),
    name: page.name || '当前页面',
    functionRef: page.functionRef || '',
    implementationType: page.implementationType || 'unknown',
    surfaceType: page.surfaceType || 'unknown',
    stateSummary: page.stateSummary || '',
    scrollableRegions: [...(page.scrollableRegions || [])],
    featurePath: featurePath.length ? [...featurePath] : [page.name || '待归类'],
    frameIds: frameId ? [frameId] : [],
    primaryFrameId: frameId,
    elementIds: [],
    publishedAt: null,
  };
}

export function beginFrameCapture(currentDraft, frameId, { forceNewPage = false, replacePageId = null } = {}) {
  const previous = normalizeDraftShape(currentDraft || createEmptyDraft());
  const existingPage = previous.pages.find((page) => page.id === (replacePageId || previous.currentPageId));
  const existingPageHasElements = Boolean(existingPage && previous.elements.some((element) => element.pageId === existingPage.id));
  const page = existingPage && !existingPageHasElements && !forceNewPage
    ? { ...existingPage, frameIds: [frameId], primaryFrameId: frameId, elementIds: [], publishedAt: null }
    : makeDraftPage({
        id: draftPageId(),
        key: `page.capture.${randomUUID().slice(0, 8)}`,
        name: '待识别页面',
        functionRef: '',
        implementationType: 'unknown',
        surfaceType: 'unknown',
        stateSummary: '',
        scrollableRegions: [],
      }, frameId, ['待归类']);
  const pages = previous.pages.filter((item) => item.id !== page.id);
  pages.push(page);
  return normalizeDraftShape({
    ...previous,
    revision: previous.revision + 1,
    currentFrameId: frameId,
    rawModelResultRef: null,
    currentPageId: page.id,
    page: {
      id: page.id,
      key: page.key,
      name: page.name,
      functionRef: page.functionRef,
      implementationType: page.implementationType,
      surfaceType: page.surfaceType,
      stateSummary: page.stateSummary,
      scrollableRegions: page.scrollableRegions,
    },
    pages,
    updatedAt: new Date().toISOString(),
  });
}

function pageSummaryFields(page) {
  return {
    id: page.id,
    key: page.key,
    name: page.name,
    functionRef: page.functionRef,
    implementationType: page.implementationType,
    surfaceType: page.surfaceType,
    stateSummary: page.stateSummary,
    scrollableRegions: page.scrollableRegions,
  };
}

// Append a newly captured/uploaded frame to an existing page while KEEPING its
// annotated elements. Unlike beginFrameCapture this never discards elementIds.
export function appendFrameToPage(currentDraft, frameId, { pageId = null } = {}) {
  const previous = normalizeDraftShape(currentDraft || createEmptyDraft());
  const targetPage = previous.pages.find((page) => page.id === (pageId || previous.currentPageId));
  if (!targetPage) {
    // No such page to append to — fall back to creating a fresh capture page.
    return beginFrameCapture(previous, frameId, { forceNewPage: true });
  }
  const frameIds = targetPage.frameIds.includes(frameId)
    ? [...targetPage.frameIds]
    : [...targetPage.frameIds, frameId];
  const nextPage = {
    ...targetPage,
    frameIds,
    primaryFrameId: targetPage.primaryFrameId && frameIds.includes(targetPage.primaryFrameId)
      ? targetPage.primaryFrameId
      : frameIds[0] || null,
    publishedAt: null,
  };
  const pages = previous.pages.map((page) => (page.id === nextPage.id ? nextPage : page));
  return normalizeDraftShape({
    ...previous,
    revision: previous.revision + 1,
    currentPageId: nextPage.id,
    currentFrameId: frameId,
    rawModelResultRef: null,
    page: pageSummaryFields(nextPage),
    pages,
    updatedAt: new Date().toISOString(),
  });
}

// Remove a single observation frame from a page. Refuses to remove the last
// remaining frame (a page must always keep at least one frame). Returns a flag
// so the route layer can surface a 4xx when the removal is rejected.
export function removeFrameFromPage(currentDraft, frameId, { pageId = null } = {}) {
  const previous = normalizeDraftShape(currentDraft || createEmptyDraft());
  const targetPage = previous.pages.find((page) => (pageId ? page.id === pageId : page.frameIds.includes(frameId)));
  if (!targetPage || !targetPage.frameIds.includes(frameId)) {
    return { draft: previous, removed: false, reason: 'not-found' };
  }
  if (targetPage.frameIds.length <= 1) {
    return { draft: previous, removed: false, reason: 'last-frame' };
  }
  const frameIds = targetPage.frameIds.filter((id) => id !== frameId);
  const nextPage = {
    ...targetPage,
    frameIds,
    primaryFrameId: targetPage.primaryFrameId === frameId
      ? frameIds[0] || null
      : targetPage.primaryFrameId,
    publishedAt: null,
  };
  const pages = previous.pages.map((page) => (page.id === nextPage.id ? nextPage : page));
  const removedElementIds = new Set(previous.elements
    .filter((element) => element.pageId === nextPage.id && element.sourceFrameId === frameId)
    .map((element) => element.id));
  const elements = previous.elements
    .filter((element) => !removedElementIds.has(element.id))
    .map((element) => removedElementIds.has(element.parentId || '')
      ? { ...element, parentId: null, ownerKind: 'page', ownerRef: element.pageId || nextPage.id }
      : element);
  const transitions = previous.transitions.filter((transition) => !removedElementIds.has(transition.triggerElementId)
    && transition.evidence.beforeFrameId !== frameId
    && transition.evidence.locatorFrameId !== frameId
    && transition.evidence.afterFrameId !== frameId);
  const wasCurrent = previous.currentPageId === nextPage.id;
  const currentFrameId = wasCurrent && previous.currentFrameId === frameId
    ? nextPage.primaryFrameId
    : previous.currentFrameId;
  return {
    draft: normalizeDraftShape({
      ...previous,
      revision: previous.revision + 1,
      currentFrameId,
      page: wasCurrent ? pageSummaryFields(nextPage) : previous.page,
      pages,
      elements,
      transitions,
      updatedAt: new Date().toISOString(),
    }),
    removed: true,
  };
}

export function removePagesFromDraft(currentDraft, pageIds) {
  const previous = normalizeDraftShape(currentDraft || createEmptyDraft());
  const removedPageIds = new Set(pageIds || []);
  if (!previous.pages.some((page) => removedPageIds.has(page.id))) return previous;
  const removedElementIds = new Set(previous.elements
    .filter((element) => element.pageId && removedPageIds.has(element.pageId))
    .map((element) => element.id));
  const elements = previous.elements
    .filter((element) => !removedElementIds.has(element.id))
    .map((element) => element.ownerKind === 'application'
      ? { ...element, availableOnPageIds: element.availableOnPageIds.filter((id) => !removedPageIds.has(id)) }
      : element);
  const pages = previous.pages.filter((page) => !removedPageIds.has(page.id));
  const nextPage = pages.find((page) => page.id === previous.currentPageId) || pages[0];
  const emptyPage = {
    id: 'draft-page-empty',
    key: 'page.empty',
    name: '',
    functionRef: '',
    implementationType: 'unknown',
    surfaceType: 'unknown',
    stateSummary: '',
    scrollableRegions: [],
  };
  return normalizeDraftShape({
    ...previous,
    revision: previous.revision + 1,
    currentPageId: nextPage?.id || emptyPage.id,
    currentFrameId: nextPage?.primaryFrameId || nextPage?.frameIds[0] || null,
    page: nextPage
      ? { id: nextPage.id, key: nextPage.key, name: nextPage.name, functionRef: nextPage.functionRef, implementationType: nextPage.implementationType, surfaceType: nextPage.surfaceType, stateSummary: nextPage.stateSummary, scrollableRegions: nextPage.scrollableRegions }
      : emptyPage,
    pages,
    elements,
    elementEditRecords: previous.elementEditRecords.filter((record) => !removedElementIds.has(record.elementId)),
    transitions: previous.transitions.filter((transition) => !removedPageIds.has(transition.sourcePageId) && !removedPageIds.has(transition.targetPageId) && !removedElementIds.has(transition.triggerElementId)),
    updatedAt: new Date().toISOString(),
  });
}

export function createEmptyDraft() {
  const now = new Date().toISOString();
  return {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    revision: 0,
    appKey: 'zto.connect',
    buildRef: '',
    featurePath: [],
    currentFrameId: null,
    rawModelResultRef: null,
    currentPageId: 'draft-page-current',
    page: {
      id: 'draft-page-current',
      key: 'page.current',
      name: '当前页面',
      functionRef: '',
      implementationType: 'unknown',
      surfaceType: 'unknown',
      stateSummary: '',
      scrollableRegions: [],
    },
    pages: [],
    elements: [],
    elementEditRecords: [],
    transitions: [],
    lastAiModel: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeDraftShape(value) {
  const draft = structuredClone(value || createEmptyDraft());
  draft.schemaVersion = DRAFT_SCHEMA_VERSION;
  draft.currentPageId ||= draft.page?.id || 'draft-page-current';
  draft.page ||= {
    id: draft.currentPageId,
    key: 'page.current',
    name: '当前页面',
    functionRef: '',
    implementationType: 'unknown',
    surfaceType: 'unknown',
    stateSummary: '',
    scrollableRegions: [],
  };
  draft.page.id = draft.currentPageId;
  draft.page.key ||= pageKeyFromName(draft.page.name);
  draft.pages = Array.isArray(draft.pages) ? draft.pages : [];
  if (draft.currentFrameId && !draft.pages.some((page) => page.id === draft.currentPageId)) {
    draft.pages.push(makeDraftPage(draft.page, draft.currentFrameId, draft.featurePath));
  }
  for (const page of draft.pages) {
    page.frameIds = [...new Set(page.frameIds || [])];
    page.primaryFrameId = page.primaryFrameId && page.frameIds.includes(page.primaryFrameId)
      ? page.primaryFrameId
      : page.frameIds[0] || null;
  }
  draft.elements = (draft.elements || []).map((element) => {
    const { actionable: _removedActionable, ...elementFields } = element;
    const elementType = normalizeElementType(element.elementType);
    const capabilities = normalizeCapabilities(element.capabilities);
    const grid = gridForBox(element.bbox, element.gridColumns ?? 12, element.gridRows ?? 12);
    return {
      ...elementFields,
      displayCondition: typeof element.displayCondition === 'string' ? element.displayCondition : '',
      abstraction: normalizeAbstraction(element.abstraction, element.candidateKey),
      elementType,
      capabilities,
      actionEffects: normalizeActionEffects(element.actionEffects, elementType, capabilities),
      interactionBoundary: normalizeInteractionBoundary(element.interactionBoundary, capabilities),
      gridColumns: grid.columns,
      gridRows: grid.rows,
      gridRegion: grid.region,
      meaning: normalizeDraftMeaning(element.meaning),
      pageId: element.pageId ?? (['application', 'shared_component'].includes(element.ownerKind) ? null : draft.currentPageId),
      sourceFrameId: element.sourceFrameId || null,
      availableOnPageIds: [...(element.availableOnPageIds || (element.ownerKind === 'application' ? [draft.currentPageId] : []))],
      aiModel: element.aiModel || draft.lastAiModel || null,
    };
  });
  const excludedSystemElementIds = new Set(draft.elements
    .filter((element) => EXCLUDED_SYSTEM_CHROME_TYPES.has(element.elementType))
    .map((element) => element.id));
  const pendingSystemElementIds = [...excludedSystemElementIds];
  while (pendingSystemElementIds.length > 0) {
    const parentId = pendingSystemElementIds.pop();
    for (const element of draft.elements) {
      if (element.parentId !== parentId || excludedSystemElementIds.has(element.id)) continue;
      excludedSystemElementIds.add(element.id);
      pendingSystemElementIds.push(element.id);
    }
  }
  if (excludedSystemElementIds.size > 0) {
    draft.elements = draft.elements.filter((element) => !excludedSystemElementIds.has(element.id));
    draft.elementEditRecords = (draft.elementEditRecords || []).filter((record) => !excludedSystemElementIds.has(record.elementId));
    draft.transitions = (draft.transitions || []).filter((transition) => !excludedSystemElementIds.has(transition.triggerElementId));
  }
  const validAbstractFieldParentRefs = new Set(draft.elements.flatMap((element) => [element.id, element.candidateKey]));
  draft.elements = draft.elements.map((element) => {
    if (!element.abstraction) return element;
    return {
      ...element,
      abstraction: {
        ...element.abstraction,
        fields: element.abstraction.fields.map((field) => (
          field.parentId && !validAbstractFieldParentRefs.has(field.parentId)
            ? { ...field, parentId: element.candidateKey }
            : field
        )),
      },
    };
  });
  // Older drafts did not persist frame provenance. Pin those page-local
  // elements to the first frame so selecting a later frame cannot overlay
  // their boxes on top of it.
  const firstFrameByPage = new Map(draft.pages.map((page) => [page.id, page.frameIds?.[0] || null]));
  draft.elements = draft.elements.map((element) => element.sourceFrameId || element.ownerKind === 'application' || element.ownerKind === 'shared_component'
    ? element
    : { ...element, sourceFrameId: firstFrameByPage.get(element.pageId) || draft.currentFrameId || null });
  // A repeated list-item template represents many rows, so its editable region is
  // the containing list's region rather than any one concrete instance.
  const elementsById = new Map(draft.elements.map((element) => [element.id, element]));
  draft.elements = draft.elements.map((element) => {
    const parent = element.parentId ? elementsById.get(element.parentId) : null;
    if (!isInheritedAbstractListItem(element, parent)) return element;
    return {
      ...element,
      bbox: { ...parent.bbox },
      gridColumns: parent.gridColumns,
      gridRows: parent.gridRows,
      gridRegion: parent.gridRegion,
    };
  });
  draft.elementEditRecords = Array.isArray(draft.elementEditRecords)
    ? draft.elementEditRecords.filter((record) => record && typeof record.elementId === 'string')
    : [];
  const editedElementIds = new Set(draft.elementEditRecords.map((record) => record.elementId));
  draft.elements = draft.elements.map((element) => {
    if (element.source === 'human' || editedElementIds.has(element.id)) return element;
    return {
      ...element,
      reviewStatus: element.reviewStatus === 'edited' ? 'pending' : element.reviewStatus,
      source: 'ai',
    };
  });
  draft.transitions = Array.isArray(draft.transitions) ? draft.transitions : [];
  draft.lastAiModel ||= null;
  const pageById = new Map(draft.pages.map((page) => [page.id, page]));
  for (const page of draft.pages) {
    page.key ||= pageKeyFromName(page.name);
    page.functionRef ||= '';
    page.implementationType ||= 'unknown';
    page.featurePath = page.featurePath?.length ? page.featurePath.slice(0, 3) : [page.name || '待归类'];
    page.frameIds = [...new Set(page.frameIds || [])];
    page.primaryFrameId = page.primaryFrameId && page.frameIds.includes(page.primaryFrameId)
      ? page.primaryFrameId
      : page.frameIds[0] || null;
    page.elementIds = [];
    page.publishedAt ||= null;
  }
  for (const element of draft.elements) {
    if (element.pageId && pageById.has(element.pageId)) pageById.get(element.pageId).elementIds.push(element.id);
    if (element.ownerKind === 'application') {
      for (const pageId of element.availableOnPageIds) {
        if (pageById.has(pageId)) pageById.get(pageId).elementIds.push(element.id);
      }
    }
  }
  for (const page of draft.pages) page.elementIds = [...new Set(page.elementIds)];
  return draft;
}

function draftElementId(candidateKey) {
  return `element-${candidateKey.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 72)}-${randomUUID().slice(0, 8)}`;
}

function normalizedMatchText(value) {
  return String(value || '').trim().toLocaleLowerCase('zh-CN').replace(/[\s'"“”‘’`.,，。:：;；!?！？()（）[\]{}<>《》]/g, '');
}

function boxIoU(a, b) {
  if (!a || !b) return 0;
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function boxCenterDistance(a, b) {
  if (!a || !b) return 1;
  return Math.hypot((a.x + a.width / 2) - (b.x + b.width / 2), (a.y + a.height / 2) - (b.y + b.height / 2));
}

function elementMatchScore(candidate, existing) {
  if (!candidate || !existing) return -Infinity;
  const sameKey = candidate.candidateKey && candidate.candidateKey === existing.candidateKey;
  const sameTemplate = candidate.abstraction?.templateKey && candidate.abstraction.templateKey === existing.abstraction?.templateKey;
  if (sameKey) return 1000;
  if (sameTemplate) return 900 + boxIoU(candidate.approximateRegion, existing.bbox) * 10;
  if (candidate.elementType && existing.elementType && candidate.elementType !== existing.elementType) return -Infinity;
  const candidateText = normalizedMatchText(candidate.label || candidate.visualDescription);
  const existingText = normalizedMatchText(existing.label || existing.visualDescription);
  const textMatch = candidateText && existingText && (candidateText === existingText || candidateText.includes(existingText) || existingText.includes(candidateText));
  const iou = boxIoU(candidate.approximateRegion, existing.bbox);
  const distance = boxCenterDistance(candidate.approximateRegion, existing.bbox);
  if (!textMatch || iou < 0.35 || distance > 0.12) return -Infinity;
  return 500 + iou * 100 + (candidateText === existingText ? 80 : 0) - distance * 100;
}

export function matchIncrementalCandidates(candidates, existingElements) {
  const assignments = new Map();
  const possibleMatches = [];
  for (const [candidateIndex, candidate] of (candidates || []).entries()) {
    for (const [existingIndex, existing] of (existingElements || []).entries()) {
      const score = elementMatchScore(candidate, existing);
      if (Number.isFinite(score)) possibleMatches.push({ candidateIndex, existingIndex, existing, score });
    }
  }
  possibleMatches.sort((left, right) => right.score - left.score || left.candidateIndex - right.candidateIndex || left.existingIndex - right.existingIndex);
  const matchedCandidates = new Set();
  const matchedExisting = new Set();
  for (const match of possibleMatches) {
    if (matchedCandidates.has(match.candidateIndex) || matchedExisting.has(match.existing.id)) continue;
    assignments.set(match.candidateIndex, match.existing);
    matchedCandidates.add(match.candidateIndex);
    matchedExisting.add(match.existing.id);
  }
  return assignments;
}

export function classifyIncrementalRecognition(currentDraft, recognitionResult, pageContext = '') {
  const previous = normalizeDraftShape(currentDraft || createEmptyDraft());
  const proposal = projectAbstractRecognition(prepareRecognitionForDraft(recognitionResult, pageContext));
  const pageId = previous.currentPageId;
  const existingElements = previous.elements.filter((element) => element.pageId === pageId || element.availableOnPageIds?.includes(pageId));
  const matches = matchIncrementalCandidates(proposal.elements, existingElements);
  return {
    previous,
    proposal,
    pageId,
    candidates: proposal.elements.map((candidate, index) => {
      const existing = matches.get(index) || null;
      const sameTemplate = Boolean(candidate.abstraction?.templateKey
        && candidate.abstraction.templateKey === existing?.abstraction?.templateKey);
      return {
        candidate,
        existing,
        disposition: existing ? (sameTemplate ? 'common' : 'duplicate') : 'new',
      };
    }),
  };
}

function inferRole(element) {
  if (element.elementType === 'container') return 'container';
  if (element.elementType === 'label') return 'label';
  if (element.elementType === 'status' || element.elementType === 'badge') {
    return 'status_indicator';
  }
  if (element.interactive) return 'action_trigger';
  return 'content_anchor';
}

function capabilitiesFor(candidateKey, actions) {
  const capabilities = [...new Set(
    actions
      .filter((action) => action.triggerCandidateKey === candidateKey)
      .map((action) => RECOGNITION_ACTIONS.includes(action.action) ? action.action : null)
      .filter(Boolean),
  )];
  return capabilities.length > 0 ? capabilities : ['none'];
}

function actionEffectsFor(candidateKey, actions, elementType, capabilities) {
  return capabilities.map((action) => ({
    action,
    effect: actions.find((candidate) => candidate.triggerCandidateKey === candidateKey && candidate.action === action)?.expectedOutcome || defaultActionEffect(elementType, action),
  }));
}

export function nextElementFromRecognition(element, actions, pageId, model, sourceFrameId = null) {
  const capabilities = capabilitiesFor(element.candidateKey, actions);
  const grid = gridForBox(element.approximateRegion);
  return {
    id: draftElementId(element.candidateKey),
    candidateKey: element.candidateKey,
    label: element.label || element.visualDescription,
    visualDescription: element.visualDescription,
    displayCondition: typeof element.displayCondition === 'string' ? element.displayCondition : '',
    elementType: element.elementType,
    role: inferRole(element),
    capabilities,
    actionEffects: actionEffectsFor(element.candidateKey, actions, element.elementType, capabilities),
    enabled: element.enabled ?? null,
    state: element.state || '',
    dynamicContent: element.dynamicContent,
    abstraction: normalizeAbstraction(element.abstraction, element.candidateKey),
    bbox: { ...element.approximateRegion },
    gridColumns: grid.columns,
    gridRows: grid.rows,
    gridRegion: grid.region,
    geometryKind: element.geometryKind,
    geometryConfidence: element.geometryConfidence,
    confidence: element.confidence,
    meaning: { ...element.meaning },
    riskSignals: [...(element.riskSignals || [])],
    ownerKind: 'page',
    ownerRef: pageId,
    parentId: null,
    childrenIds: [],
    pageId,
    sourceFrameId,
    availableOnPageIds: [],
    interactionBoundary: normalizeInteractionBoundary(null, capabilities),
    reviewStatus: 'pending',
    source: 'ai',
    aiModel: model || null,
    lastModelProposal: null,
  };
}

// Incremental recognition keeps the existing page graph intact. Candidates
// with an existing key are intentionally skipped; callers can present them
// as duplicates/shared templates for review without writing them again.
export function appendRecognitionIntoDraft(currentDraft, recognitionResult, modelResultRef, model = null, pageContext = '') {
  const { previous, proposal, pageId, candidates } = classifyIncrementalRecognition(currentDraft, recognitionResult, pageContext);
  const additions = candidates
    .filter((item) => !item.existing)
    .map((item) => nextElementFromRecognition(item.candidate, proposal.actionCandidates || [], pageId, model, proposal.frameId));
  if (additions.length === 0) return previous;
  const byKey = new Map(candidates
    .filter((item) => item.existing)
    .map((item) => [item.candidate.candidateKey, item.existing]));
  for (const addition of additions) byKey.set(addition.candidateKey, addition);
  const elements = [...previous.elements, ...additions];
  applyContainmentParents(elements.filter((element) => byKey.has(element.candidateKey)), proposal.relationships, new Set(), pageId);
  const page = previous.pages.find((item) => item.id === pageId);
  const pages = previous.pages.map((item) => item.id === pageId
    ? { ...item, elementIds: elements.filter((element) => element.pageId === pageId || element.availableOnPageIds?.includes(pageId)).map((element) => element.id), publishedAt: null }
    : item);
  return normalizeDraftShape({
    ...previous,
    revision: previous.revision + 1,
    rawModelResultRef: modelResultRef,
    lastAiModel: model || previous.lastAiModel,
    pages,
    page: page ? pageSummaryFields(page) : previous.page,
    elements,
    elementEditRecords: [...previous.elementEditRecords, ...additions.map((element) => ({ elementId: element.id, kind: 'created', fields: ['recognition'], editedAt: new Date().toISOString() }))],
    updatedAt: new Date().toISOString(),
  });
}

function isHumanProtected(element, editedElementIds) {
  return element.reviewStatus === 'accepted' || editedElementIds.has(element.id) || element.source === 'human';
}

function chooseSpecificParent(parentCandidates, relationPairs) {
  if (parentCandidates.length <= 1) return parentCandidates[0] || null;
  const candidateKeys = new Set(parentCandidates.map((parent) => parent.candidateKey));
  // If one candidate parent contains another candidate parent, the nested
  // container is the direct semantic owner. This prevents an outer form or
  // WebView-sized shell from winning by relation order.
  const direct = parentCandidates.filter((parent) => ![...candidateKeys].some((otherKey) => (
    otherKey !== parent.candidateKey && relationPairs.some((relation) => (
      relation.fromCandidateKey === parent.candidateKey
        && relation.toCandidateKey === otherKey
        && relation.type === 'contains'
    ))
  )));
  const pool = direct.length > 0 ? direct : parentCandidates;
  return [...pool].sort((left, right) => {
    const leftArea = (left.bbox?.width || 1) * (left.bbox?.height || 1);
    const rightArea = (right.bbox?.width || 1) * (right.bbox?.height || 1);
    return leftArea - rightArea || left.candidateKey.localeCompare(right.candidateKey);
  })[0] || null;
}

function applyContainmentParents(elements, relationships, editedElementIds, currentPageId) {
  const byKey = new Map(elements.map((item) => [item.candidateKey, item]));
  const parentsByChild = new Map();
  for (const relation of relationships || []) {
    if (relation.type !== 'contains') continue;
    const parent = byKey.get(relation.fromCandidateKey);
    const child = byKey.get(relation.toCandidateKey);
    if (!parent || !child || isHumanProtected(child, editedElementIds)) continue;
    const parents = parentsByChild.get(child.candidateKey) || [];
    parents.push(parent);
    parentsByChild.set(child.candidateKey, parents);
  }
  for (const [childKey, parents] of parentsByChild) {
    const child = byKey.get(childKey);
    const parent = chooseSpecificParent(parents, relationships || []);
    if (!child || !parent) continue;
    child.parentId = parent.id;
    child.ownerKind = parent.ownerKind === 'application' || parent.ownerKind === 'shared_component' ? 'shared_component' : 'component';
    child.ownerRef = parent.id;
    child.pageId = child.ownerKind === 'shared_component' ? null : currentPageId;
  }
}

function clampUnitBox(box) {
  const stable = (value) => Number(value.toFixed(6));
  const x = Math.min(Math.max(Number(box.x) || 0, 0), 0.999);
  const y = Math.min(Math.max(Number(box.y) || 0, 0), 0.999);
  return {
    x: stable(x),
    y: stable(y),
    width: stable(Math.min(Math.max(Number(box.width) || 0.001, 0.001), 1 - x)),
    height: stable(Math.min(Math.max(Number(box.height) || 0.001, 0.001), 1 - y)),
  };
}

function repeatItemParts(candidateKey) {
  const match = String(candidateKey || '').match(/^(.+?)[._-](\d+)[._-](.+)$/);
  return match ? { prefix: match[1], index: match[2], suffix: match[3] } : null;
}

function unionCandidateBoxes(elements) {
  const left = Math.min(...elements.map((element) => element.approximateRegion.x));
  const top = Math.min(...elements.map((element) => element.approximateRegion.y));
  const right = Math.max(...elements.map((element) => element.approximateRegion.x + element.approximateRegion.width));
  const bottom = Math.max(...elements.map((element) => element.approximateRegion.y + element.approximateRegion.height));
  return clampUnitBox({ x: left, y: top, width: right - left, height: bottom - top });
}

function dynamicFieldForElement(element, parentId, actionCandidates = []) {
  const elementType = element.elementType || 'section';
  const fieldLabels = {
    carousel: '轮播内容', banner: '横幅内容', image: '图片内容', thumbnail: '缩略图内容', preview: '预览内容',
    avatar: '头像内容', 'avatar-group': '头像集合', badge: '状态角标', 'progress-bar': '进度值', loading: '加载状态',
    card: '卡片内容', panel: '面板内容', section: '动态区域', 'floating-card': '浮层内容', toast: '提示内容',
  };
  const capabilities = [...new Set(actionCandidates
    .filter((action) => action.triggerCandidateKey === element.candidateKey)
    .map((action) => action.action)
    .filter((action) => RECOGNITION_ACTIONS.includes(action)))];
  const normalizedCapabilities = capabilities.length > 0 ? capabilities : ['none'];
  return {
    key: `dynamic-${elementType}`,
    label: fieldLabels[elementType] || '动态字段',
    elementType,
    description: '内容可随运行时数据变化',
    displayCondition: typeof element.displayCondition === 'string' ? element.displayCondition : '',
    capabilities: normalizedCapabilities,
    interactionBoundary: normalizedCapabilities.some((action) => action !== 'none') ? 'candidate_bbox' : 'none',
    actionEffects: normalizeActionEffects(element.actionEffects, elementType, normalizedCapabilities),
    parentId,
    required: false,
    instanceRegions: [element.approximateRegion],
};
}

function isUnstructuredDynamicTitle(element) {
  if (element?.elementType !== 'title' || element.dynamicContent !== true || element.interactive) return false;
  const abstraction = element.abstraction;
  if (!abstraction) return true;
  if (abstraction.kind !== 'dynamic-template') return false;
  const fields = abstraction.fields || [];
  return fields.length <= 1 && fields.every((field) => (
    TITLE_TEXT_TYPES.has(field.elementType)
      && (field.capabilities || []).every((capability) => capability === 'none')
  ));
}

function downgradeUnstructuredDynamicTitles(proposal) {
  for (const element of proposal.elements || []) {
    if (!isUnstructuredDynamicTitle(element)) continue;
    // Business-semantic inference may intentionally represent a single title
    // field as a dynamic slot (for example, a person's daily-report title).
    // Do not erase that decision merely because it has no avatar or sibling
    // fields; the geometry pass will still ground its bbox from runtime facts.
    if ((element.riskSignals || []).some((signal) => (
      signal === BUSINESS_DYNAMIC_SEMANTIC_MARKER || signal === BUSINESS_DYNAMIC_TITLE_MARKER
    ))) continue;
    element.dynamicContent = false;
    element.abstraction = null;
    element.riskSignals = [...new Set([
      ...(element.riskSignals || []),
      'unstructured-dynamic-title-downgraded',
    ])];
  }
}

function inferDynamicElements(proposal) {
  const listKeys = new Set((proposal.elements || [])
    .filter((element) => LIST_CONTAINER_TYPES.has(element.elementType))
    .map((element) => element.candidateKey));
  const listDescendants = new Set();
  const pending = [...listKeys];
  const contains = (proposal.relationships || []).filter((relation) => relation.type === 'contains');
  while (pending.length > 0) {
    const parent = pending.pop();
    for (const relation of contains) {
      if (relation.fromCandidateKey !== parent || listDescendants.has(relation.toCandidateKey)) continue;
      listDescendants.add(relation.toCandidateKey);
      pending.push(relation.toCandidateKey);
    }
  }
  const candidates = (proposal.elements || []).filter((element) => element.dynamicContent === true
    && !element.abstraction
    && !DATA_ENTRY_TYPES.has(element.elementType)
    && !listDescendants.has(element.candidateKey));
  if (candidates.length === 0) return;

  // A single stable dynamic slot is already a valid dynamic-element共相. Preserve its
  // concrete element type (carousel/banner/progress/etc.) and only abstract its payload.
  if (candidates.length === 1) {
    const element = candidates[0];
    const field = dynamicFieldForElement(element, element.candidateKey, proposal.actionCandidates || []);
    element.abstraction = {
      kind: 'dynamic-template',
      templateKey: `${element.candidateKey}.dynamic`,
      instanceCount: 1,
      fields: [field],
      instanceRegions: [element.approximateRegion],
      bboxStyle: 'abstract',
    };
    element.visualDescription = element.visualDescription || '结构稳定、内容随运行时数据变化的动态元素共相';
    return;
  }

  // Each explicitly dynamic candidate is an independent stable slot unless the
  // model already supplied a multi-field dynamic template. Runtime geometry
  // refinement may later combine separate avatar/name observations when their
  // concrete image and text nodes prove one visual payload.
  for (const element of candidates) {
    element.abstraction = {
      kind: 'dynamic-template',
      templateKey: `${element.candidateKey}.dynamic`,
      instanceCount: 1,
      fields: [dynamicFieldForElement(element, element.candidateKey, proposal.actionCandidates || [])],
      instanceRegions: [element.approximateRegion],
      bboxStyle: 'abstract',
    };
    element.visualDescription = element.visualDescription || '结构稳定、内容随运行时数据变化的动态元素共相';
  }
}

function abstractFieldForElement(element, suffix, actionCandidates = []) {
  const labels = {
    title: '主标题',
    description: '辅助描述',
    subtitle: '辅助描述',
    checkbox: '尾部复选框',
    switch: '尾部开关',
    time: '时间信息',
    badge: '状态角标',
    icon: '图标',
  };
  const key = String(suffix || element.elementType || 'field').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const actions = actionCandidates.filter((action) => action.triggerCandidateKey === element.candidateKey);
  const capabilities = [...new Set(actions.map((action) => action.action).filter((action) => RECOGNITION_ACTIONS.includes(action)))];
  const normalizedCapabilities = capabilities.length > 0 ? capabilities : ['none'];
  return {
    key,
    label: labels[key] || '重复字段',
    elementType: element.elementType || 'static-label',
    description: labels[key] ? `每个列表项中的${labels[key]}` : '每个列表项中重复出现的同类字段',
    displayCondition: typeof element.displayCondition === 'string' ? element.displayCondition : '',
    capabilities: normalizedCapabilities,
    interactionBoundary: normalizedCapabilities.some((action) => action !== 'none') ? 'candidate_bbox' : 'none',
    actionEffects: normalizedCapabilities.map((action) => ({
      action,
      effect: actions.find((candidate) => candidate.action === action)?.expectedOutcome || defaultActionEffect(element.elementType || 'static-label', action),
    })),
    parentId: null,
    required: key === 'title',
  };
}

function concreteListItemForGroup(elementsByKey, group) {
  const separators = ['_', '-', '.'];
  const candidateKeys = separators.flatMap((separator) => [
    `${group.prefix}${separator}${group.index}`,
    `${group.prefix}${separator}${group.index}${separator}item`,
  ]);
  return candidateKeys.map((key) => elementsByKey.get(key)).find((element) => element?.elementType === 'list-item') || null;
}

function inferRepeatedListItems(proposal) {
  const listKeys = new Set((proposal.elements || [])
    .filter((element) => ['list', 'grouped-list', 'swipe-list', 'expandable-list'].includes(element.elementType))
    .map((element) => element.candidateKey));
  if (!listKeys.size) return;
  const contains = (proposal.relationships || []).filter((relation) => relation.type === 'contains');
  const explicitListForChild = new Map(contains
    .filter((relation) => listKeys.has(relation.fromCandidateKey))
    .map((relation) => [relation.toCandidateKey, relation.fromCandidateKey]));
  const groups = new Map();
  for (const element of proposal.elements || []) {
    const parts = repeatItemParts(element.candidateKey);
    if (!parts || element.elementType === 'list-item') continue;
    const key = `${parts.prefix}:${parts.index}`;
    if (!groups.has(key)) groups.set(key, { ...parts, elements: [] });
    groups.get(key).elements.push(element);
  }
  const prefixGroups = new Map();
  for (const group of groups.values()) {
    if (group.elements.length < 2) continue;
    if (!prefixGroups.has(group.prefix)) prefixGroups.set(group.prefix, []);
    prefixGroups.get(group.prefix).push(group);
  }
  const existingKeys = new Set((proposal.elements || []).map((element) => element.candidateKey));
  const elementsByKey = new Map((proposal.elements || []).map((element) => [element.candidateKey, element]));
  const additions = [];
  const addedRelations = [];
  const groupedChildren = new Map();
  for (const [prefix, repeatedGroups] of prefixGroups) {
    if (repeatedGroups.length < 2) continue;
    const orderedGroups = [...repeatedGroups].sort((left, right) => Number(left.index) - Number(right.index));
    const allElements = orderedGroups.flatMap((group) => group.elements);
    const concreteItems = orderedGroups.map((group) => concreteListItemForGroup(elementsByKey, group)).filter(Boolean);
    const itemKey = `${prefix}-item-template`;
    if (existingKeys.has(itemKey)) continue;
    const relatedListKeys = [...new Set([...allElements, ...concreteItems].map((element) => explicitListForChild.get(element.candidateKey)).filter(Boolean))];
    const listKey = relatedListKeys.length === 1 ? relatedListKeys[0] : listKeys.size === 1 ? [...listKeys][0] : null;
    if (!listKey) continue;
    const fieldBuckets = new Map();
    orderedGroups.forEach((group) => {
      group.elements.forEach((element) => {
        const field = abstractFieldForElement(element, repeatItemParts(element.candidateKey)?.suffix || element.elementType, proposal.actionCandidates || []);
        const bucket = fieldBuckets.get(field.key) || { field, instanceRegions: [] };
        bucket.instanceRegions.push(element.approximateRegion);
        fieldBuckets.set(field.key, bucket);
      });
    });
    const fields = [...fieldBuckets.values()].map(({ field, instanceRegions }) => ({ ...field, parentId: itemKey, instanceRegions }));
    const instanceRegions = orderedGroups.map((group) => concreteListItemForGroup(elementsByKey, group)?.approximateRegion || unionCandidateBoxes(group.elements));
    additions.push({
      candidateKey: itemKey,
      label: '列表项元素共相',
      visualDescription: `由 ${orderedGroups.length} 个同构可见行归纳出的列表项元素共相`,
      elementType: 'list-item',
      interactive: false,
      enabled: true,
      state: null,
      approximateRegion: unionCandidateBoxes(instanceRegions.map((approximateRegion) => ({ approximateRegion }))),
      geometryKind: allElements.some((element) => (element.riskSignals || []).includes('geometry-grounded-by-runtime')) ? 'boundary' : 'approximate',
      geometryConfidence: Math.min(...allElements.map((element) => Number(element.geometryConfidence) || 0.5)),
      meaning: { status: 'known', description: '重复列表中同构条目的列表项元素共相', evidence: { visibleTexts: [], visibleIcons: [], visibleStates: [], visualCues: ['重复行布局'], userContext: null, unclassified: [] } },
      dynamicContent: false,
      abstraction: {
        kind: 'repeated-template',
        templateKey: `${prefix}.item`,
        instanceCount: orderedGroups.length,
        fields,
        instanceRegions,
        bboxStyle: 'abstract',
      },
      riskSignals: ['list-item-inferred-from-repeated-children'],
      confidence: Math.min(...allElements.map((element) => Number(element.confidence) || 0.5)),
    });
    existingKeys.add(itemKey);
    addedRelations.push({ fromCandidateKey: listKey, type: 'contains', toCandidateKey: itemKey });
    for (const child of [...concreteItems, ...allElements]) {
      groupedChildren.set(child.candidateKey, listKey);
      addedRelations.push({ fromCandidateKey: itemKey, type: 'contains', toCandidateKey: child.candidateKey });
    }
  }
  if (!additions.length) return;
  proposal.elements.push(...additions);
  proposal.relationships = [
    ...(proposal.relationships || []).filter((relation) => !(
      relation.type === 'contains'
      && groupedChildren.get(relation.toCandidateKey) === relation.fromCandidateKey
    )),
    ...addedRelations,
  ];
}

function boxContainsCenter(outer, inner, tolerance = 0.01) {
  if (!outer || !inner) return false;
  const x = inner.x + inner.width / 2;
  const y = inner.y + inner.height / 2;
  return x >= outer.x - tolerance
    && x <= outer.x + outer.width + tolerance
    && y >= outer.y - tolerance
    && y <= outer.y + outer.height + tolerance;
}

function absorbRepeatedTemplateInputElements(proposal) {
  const templates = (proposal.elements || []).filter((element) => (
    element?.abstraction?.kind === 'repeated-template'
    && (element.abstraction.fields || []).some((field) => DATA_ENTRY_TYPES.has(field.elementType) && field.elementType !== 'form')
  ));
  if (templates.length === 0) return;

  const relationships = proposal.relationships || [];
  const actions = proposal.actionCandidates || [];
  const absorbedKeys = new Set();
  for (const candidate of proposal.elements || []) {
    if (!['input', 'text-area', 'rich-text-input'].includes(candidate.elementType) || candidate.abstraction) continue;
    let best = null;
    for (const template of templates) {
      const explicitlyRelated = relationships.some((relation) => (
        ['contains', 'belongs-to'].includes(relation.type)
        && ((relation.fromCandidateKey === template.candidateKey && relation.toCandidateKey === candidate.candidateKey)
          || (relation.fromCandidateKey === candidate.candidateKey && relation.toCandidateKey === template.candidateKey))
      ));
      const insideInstance = (template.abstraction.instanceRegions || [])
        .some((region) => boxContainsCenter(region, candidate.approximateRegion));
      const matchingFields = (template.abstraction.fields || [])
        .filter((field) => field.elementType === candidate.elementType);
      for (const field of matchingFields) {
        const overlap = Math.max(0, ...(field.instanceRegions || []).map((region) => boxIoU(region, candidate.approximateRegion)));
        if (overlap < 0.65 && !(explicitlyRelated && insideInstance)) continue;
        const score = overlap + (explicitlyRelated ? 2 : 0);
        if (!best || score > best.score) best = { template, field, score };
      }
    }
    if (!best) continue;

    const candidateActions = actions.filter((action) => action.triggerCandidateKey === candidate.candidateKey);
    best.field.capabilities = [...new Set([
      ...(best.field.capabilities || []).filter((capability) => capability !== 'none'),
      'tap',
      'input',
      ...candidateActions.map((action) => action.action),
    ])];
    best.field.interactionBoundary = 'candidate_bbox';
    best.field.actionEffects = [...(best.field.actionEffects || [])];
    for (const action of candidateActions) {
      if (best.field.actionEffects.some((effect) => effect.action === action.action)) continue;
      best.field.actionEffects.push({
        action: action.action,
        effect: action.expectedOutcome || defaultActionEffect(candidate.elementType, action.action),
      });
    }
    best.template.riskSignals = [...new Set([
      ...(best.template.riskSignals || []),
      'concrete-inputs-absorbed-into-template',
    ])];
    absorbedKeys.add(candidate.candidateKey);
  }

  if (absorbedKeys.size === 0) return;
  proposal.elements = (proposal.elements || []).filter((element) => !absorbedKeys.has(element.candidateKey));
  proposal.relationships = relationships.filter((relation) => (
    !absorbedKeys.has(relation.fromCandidateKey) && !absorbedKeys.has(relation.toCandidateKey)
  ));
  proposal.actionCandidates = actions.filter((action) => !absorbedKeys.has(action.triggerCandidateKey));
}

export function prepareRecognitionForDraft(recognitionResult, pageContext = '') {
  const proposal = structuredClone(recognitionResult);
  // Business context can establish that a visible title is a runtime slot even
  // when the model omitted dynamicContent or emitted only one text field. This
  // pass is deliberately semantic; it never creates a missing bbox or visual
  // child. Geometry is resolved later from the frozen screenshot/runtime tree.
  applyBusinessDynamicSemantics(proposal, pageContext);
  // Keep explicitly dynamic titles that lack business evidence conservative.
  // A lone generic title is not promoted solely because it is text that could
  // change in some hypothetical future state.
  downgradeUnstructuredDynamicTitles(proposal);
  inferDynamicElements(proposal);
  inferRepeatedListItems(proposal);
  // A concrete input represented by a repeated template field is one visual
  // object, not an additional top-level element. Keep its interaction metadata
  // on the field and remove only candidates with explicit or geometric proof.
  absorbRepeatedTemplateInputElements(proposal);
  const byKey = new Map(proposal.elements.map((element) => [element.candidateKey, element]));
  for (const element of proposal.elements) {
    // Keep the proposal shape deterministic for consumers that distinguish an
    // absent property from an explicitly non-abstract element.
    element.abstraction ||= null;
    const original = element.approximateRegion;
    const normalized = clampUnitBox(original);
    if (Object.keys(normalized).some((key) => normalized[key] !== original[key])) {
      element.approximateRegion = normalized;
      element.riskSignals = [...new Set([...(element.riskSignals || []), 'geometry-clamped-to-frame'])];
    }
  }
  proposal.actionCandidates = (proposal.actionCandidates || []).filter((action) => {
    const trigger = byKey.get(action.triggerCandidateKey);
    if (!trigger || trigger.interactive) return Boolean(trigger);
    trigger.riskSignals = [...new Set([...(trigger.riskSignals || []), 'model-action-inconsistent'])];
    return false;
  });
  return proposal;
}

function projectAbstractRecognition(recognitionResult) {
  const proposal = structuredClone(recognitionResult);
  const abstractKeys = new Set((proposal.elements || [])
    .filter((element) => ['repeated-template', 'dynamic-template'].includes(element?.abstraction?.kind))
    .map((element) => element.candidateKey));
  if (!abstractKeys.size) return proposal;
  const childKeys = new Set((proposal.relationships || [])
    .filter((relation) => relation.type === 'contains' && abstractKeys.has(relation.fromCandidateKey))
    .map((relation) => relation.toCandidateKey));
  const abstractParentByChild = new Map((proposal.relationships || [])
    .filter((relation) => relation.type === 'contains' && abstractKeys.has(relation.fromCandidateKey))
    .map((relation) => [relation.toCandidateKey, relation.fromCandidateKey]));
  const keepKeys = new Set((proposal.elements || []).map((element) => element.candidateKey));
  for (const key of childKeys) {
    if (!abstractKeys.has(key)) keepKeys.delete(key);
  }
  proposal.elements = (proposal.elements || []).filter((element) => keepKeys.has(element.candidateKey));
  proposal.relationships = (proposal.relationships || []).filter((relation) => keepKeys.has(relation.fromCandidateKey) && keepKeys.has(relation.toCandidateKey));
  proposal.actionCandidates = (proposal.actionCandidates || []).map((action) => {
    const parentKey = abstractParentByChild.get(action.triggerCandidateKey);
    return parentKey ? { ...action, triggerCandidateKey: parentKey } : action;
  }).filter((action, index, actions) => keepKeys.has(action.triggerCandidateKey)
    && actions.findIndex((candidate) => candidate.triggerCandidateKey === action.triggerCandidateKey && candidate.action === action.action) === index);
  return proposal;
}

export function mergeRecognitionIntoDraft(currentDraft, recognitionResult, modelResultRef, model = null, options = {}) {
  recognitionResult = projectAbstractRecognition(recognitionResult);
  const previous = normalizeDraftShape(currentDraft || createEmptyDraft());
  const editedElementIds = new Set(previous.elementEditRecords.map((record) => record.elementId));
  const currentPageHasElements = previous.elements.some((item) => item.pageId === previous.currentPageId);
  const currentPageIsEmptyCapture = (
    previous.page.key?.startsWith('page.manual.')
    || previous.page.key?.startsWith('page.capture.')
  ) && !currentPageHasElements;
  const pageChanged = !options.preservePageIdentity && Boolean(
    previous.currentFrameId
    && !currentPageIsEmptyCapture
    && previous.page.name
    && previous.page.name !== '当前页面'
    && recognitionResult.page.name
    && recognitionResult.page.name !== previous.page.name,
  );
  const currentPageId = pageChanged ? draftPageId() : previous.currentPageId;
  const currentPageElements = previous.elements.filter((item) => item.pageId === previous.currentPageId || ['application', 'shared_component'].includes(item.ownerKind));
  const previousByKey = new Map(currentPageElements.map((item) => [item.candidateKey, item]));
  const nextElements = recognitionResult.elements.map((candidate) => {
    const generated = nextElementFromRecognition(candidate, recognitionResult.actionCandidates || [], currentPageId, model, recognitionResult.frameId);
    const existing = previousByKey.get(candidate.candidateKey);
    if (!existing) return generated;
    if (['application', 'shared_component'].includes(existing.ownerKind)) {
      return {
        ...existing,
        availableOnPageIds: existing.ownerKind === 'application'
          ? [...new Set([...(existing.availableOnPageIds || []), currentPageId])]
          : existing.availableOnPageIds,
        lastModelProposal: isHumanProtected(existing, editedElementIds) ? {
          label: generated.label,
          elementType: generated.elementType,
          bbox: generated.bbox,
          confidence: generated.confidence,
          modelResultRef,
        } : null,
      };
    }
    if (!isHumanProtected(existing, editedElementIds)) {
      return {
        ...generated,
        id: existing.id,
        reviewStatus: existing.reviewStatus,
      };
    }
    return {
      ...existing,
      lastModelProposal: {
        label: generated.label,
        elementType: generated.elementType,
        bbox: generated.bbox,
        confidence: generated.confidence,
        modelResultRef,
      },
    };
  });

  const replacedIds = new Set(nextElements.map((item) => item.id));
  const preservedElements = previous.elements.filter((item) => {
    if (replacedIds.has(item.id)) return false;
    if (['application', 'shared_component'].includes(item.ownerKind)) return true;
    if (pageChanged || item.pageId !== previous.currentPageId) return true;
    return item.sourceFrameId !== recognitionResult.frameId;
  });
  const mergedElements = [...preservedElements, ...nextElements];
  applyContainmentParents(nextElements, recognitionResult.relationships, editedElementIds, currentPageId);

  const byId = new Map(mergedElements.map((item) => [item.id, item]));
  for (const element of mergedElements) element.childrenIds = [];
  for (const element of mergedElements) {
    if (!element.parentId) continue;
    const parent = byId.get(element.parentId);
    if (parent && !parent.childrenIds.includes(element.id)) {
      parent.childrenIds.push(element.id);
    }
  }

  const now = new Date().toISOString();
  const currentPage = {
    id: currentPageId,
    key: pageChanged || currentPageIsEmptyCapture
      ? pageKeyFromName(recognitionResult.page.name)
      : (previous.page.key || pageKeyFromName(recognitionResult.page.name)),
    name: recognitionResult.page.name || previous.page.name,
    surfaceType: recognitionResult.page.surfaceType,
    stateSummary: recognitionResult.page.stateSummary,
    scrollableRegions: recognitionResult.page.scrollableRegions,
  };
  const pages = previous.pages.filter((page) => page.id !== currentPageId);
  const existingPage = previous.pages.find((page) => page.id === currentPageId);
  pages.push({
    ...(existingPage || makeDraftPage(currentPage, recognitionResult.frameId, [currentPage.name || '待归类'])),
    ...currentPage,
    frameIds: [...new Set([...(existingPage?.frameIds || []), recognitionResult.frameId])],
    primaryFrameId: existingPage?.primaryFrameId || recognitionResult.frameId,
    elementIds: mergedElements.filter((element) => element.pageId === currentPageId || (element.ownerKind === 'application' && element.availableOnPageIds.includes(currentPageId))).map((element) => element.id),
    publishedAt: null,
  });
  return normalizeDraftShape({
    ...previous,
    revision: previous.revision + 1,
    currentPageId,
    currentFrameId: recognitionResult.frameId,
    rawModelResultRef: modelResultRef,
    lastAiModel: model || previous.lastAiModel,
    page: currentPage,
    pages,
    elements: mergedElements,
    elementEditRecords: previous.elementEditRecords.filter((record) => byId.has(record.elementId)),
    updatedAt: now,
  });
}

export function validateRecognitionConsistency(recognitionResult) {
  const issues = [];
  const elements = Array.isArray(recognitionResult?.elements) ? recognitionResult.elements : [];
  const keys = new Set();
  for (const element of elements) {
    if (keys.has(element.candidateKey)) {
      issues.push(`候选键重复：${element.candidateKey}`);
    }
    keys.add(element.candidateKey);
    const box = element.approximateRegion;
    if (box && (box.x + box.width > 1 || box.y + box.height > 1)) {
      issues.push(`候选框超出截图边界：${element.candidateKey}`);
    }
  }
  for (const element of elements) {
    for (const field of element.abstraction?.fields || []) {
      if (field.parentId && !keys.has(field.parentId)) {
        issues.push(`共相字段父级引用了不可见候选：${element.candidateKey}.${field.key} -> ${field.parentId}`);
      }
    }
  }
  for (const relation of recognitionResult?.relationships || []) {
    if (!keys.has(relation.fromCandidateKey) || !keys.has(relation.toCandidateKey)) {
      issues.push(`关系引用了不可见候选：${relation.fromCandidateKey} -> ${relation.toCandidateKey}`);
    }
  }
  for (const action of recognitionResult?.actionCandidates || []) {
    const trigger = elements.find((item) => item.candidateKey === action.triggerCandidateKey);
    if (!trigger) issues.push(`动作引用了不可见候选：${action.triggerCandidateKey}`);
    else if (!trigger.interactive) issues.push(`动作触发元素不可操作：${action.triggerCandidateKey}`);
  }
  if (recognitionResult?.comparison?.basisFrameId !== null || recognitionResult?.comparison?.status !== 'not-requested') {
    issues.push('第一阶段单帧分析必须使用 not-requested 比较状态');
  }
  return issues;
}

export function validateDraft(draft) {
  const issues = [];
  const elements = Array.isArray(draft?.elements) ? draft.elements : [];
  const byId = new Map(elements.map((item) => [item.id, item]));

  for (const element of elements) {
    if (!element.label?.trim() && element.reviewStatus !== 'rejected') {
      issues.push({ level: 'error', code: 'label_required', elementId: element.id, message: '元素名称不能为空' });
    }
    if (!element.candidateKey?.trim()) {
      issues.push({ level: 'error', code: 'candidate_key_required', elementId: element.id, message: '候选键不能为空' });
    }

    if (!ELEMENT_TYPES.includes(element.elementType)) {
      issues.push({ level: 'error', code: 'element_type_required', elementId: element.id, message: '元素类型未识别，请由 AI 重新识别或人工补齐' });
    }

    const box = element.bbox;
    const validBox = box && [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 && box.x + box.width <= 1 && box.y + box.height <= 1;
    if (!validBox) {
      issues.push({ level: 'error', code: 'bbox_invalid', elementId: element.id, message: '元素边框必须位于截图范围内' });
    }
    const calculatedGrid = validBox ? gridForBox(element.bbox, element.gridColumns, element.gridRows) : null;
    const validGrid = Boolean(calculatedGrid)
      && Number.isInteger(element.gridColumns) && element.gridColumns >= 1 && element.gridColumns <= 12
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
    if (element.parentId === element.id) {
      issues.push({ level: 'error', code: 'parent_self', elementId: element.id, message: '元素不能将自己设为父级' });
    }
    if (element.parentId && !['component', 'shared_component'].includes(element.ownerKind)) {
      issues.push({ level: 'error', code: 'nested_owner_kind', elementId: element.id, message: '有父级的元素必须使用页面内容器或共享容器归属' });
    }
    if (!element.parentId && ['component', 'shared_component'].includes(element.ownerKind)) {
      issues.push({ level: 'error', code: 'root_owner_kind', elementId: element.id, message: '容器后代必须选择父级元素' });
    }
    if (!element.capabilities.length) issues.push({ level: 'warning', code: 'capability_missing', elementId: element.id, message: '元素尚未设置动作' });
    if (element.reviewStatus === 'pending') {
      issues.push({ level: 'warning', code: 'review_pending', elementId: element.id, message: 'AI 候选尚未完成人工审核' });
    }
    if (element.riskSignals?.includes('geometry-clamped-to-frame')) {
      issues.push({ level: 'warning', code: 'model_bbox_clamped', elementId: element.id, message: 'AI 候选框超出截图边缘，已自动裁剪，请人工校准' });
    }
    if (element.riskSignals?.includes('model-action-inconsistent')) {
      issues.push({ level: 'warning', code: 'model_action_inconsistent', elementId: element.id, message: 'AI 对该元素的可操作性判断存在矛盾，请人工确认' });
    }
  }

  const pageIds = Array.isArray(draft?.pages) ? draft.pages.map((page) => page.id) : [];
  const pageName = (pageId) => draft.pages?.find((page) => page.id === pageId)?.name || pageId;
  const availableOnPage = (element, pageId) => {
    if (element.pageId === pageId) return true;
    let cursor = element;
    const visited = new Set();
    while (cursor && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      if (cursor.ownerKind === 'application' && cursor.availableOnPageIds?.includes(pageId)) return true;
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return false;
  };
  const pageIdsByElement = new Map(elements.map((element) => [element.id, pageIds.filter((pageId) => availableOnPage(element, pageId))]));
  const candidateKeyGroups = new Map();
  for (const element of elements) {
    const candidateKey = element.candidateKey?.trim();
    if (!candidateKey) continue;
    const group = candidateKeyGroups.get(candidateKey) || [];
    group.push(element);
    candidateKeyGroups.set(candidateKey, group);
  }
  for (const [candidateKey, duplicateElements] of candidateKeyGroups) {
    if (duplicateElements.length < 2) continue;
    for (const element of duplicateElements) {
      const ownPageIds = pageIdsByElement.get(element.id) || [];
      const samePageElements = duplicateElements.filter((candidate) => candidate.id !== element.id && (pageIdsByElement.get(candidate.id) || []).some((pageId) => ownPageIds.includes(pageId)));
      if (samePageElements.length > 0) {
        const commonPageIds = [...new Set(samePageElements.flatMap((candidate) => (pageIdsByElement.get(candidate.id) || []).filter((pageId) => ownPageIds.includes(pageId))))];
        const pageLabel = commonPageIds.includes(draft.currentPageId)
          ? `本页面“${pageName(draft.currentPageId)}”`
          : `页面“${commonPageIds.map(pageName).join('、')}”`;
        issues.push({
          level: 'error', code: 'candidate_key_duplicate_current_page', elementId: element.id, candidateKey,
          relatedElementIds: [element.id, ...samePageElements.map((candidate) => candidate.id)], pageIds: commonPageIds,
          message: `${pageLabel}内有 ${samePageElements.length + 1} 个元素使用候选键：${candidateKey}`,
        });
      }
      const otherPageElements = duplicateElements.filter((candidate) => candidate.id !== element.id && !(pageIdsByElement.get(candidate.id) || []).some((pageId) => ownPageIds.includes(pageId)));
      if (otherPageElements.length > 0) {
        const otherPageIds = [...new Set(otherPageElements.flatMap((candidate) => pageIdsByElement.get(candidate.id) || []))];
        issues.push({
          level: 'error', code: 'candidate_key_duplicate_other_page', elementId: element.id, candidateKey,
          relatedElementIds: [element.id, ...otherPageElements.map((candidate) => candidate.id)], pageIds: [...new Set([...ownPageIds, ...otherPageIds])],
          message: `候选键 ${candidateKey} 与其他页面“${otherPageIds.map(pageName).join('、')}”的元素重复`,
        });
      }
    }
  }

  for (const element of elements) {
    const visited = new Set([element.id]);
    let cursor = element;
    while (cursor.parentId) {
      if (visited.has(cursor.parentId)) {
        issues.push({ level: 'error', code: 'owner_cycle', elementId: element.id, message: '元素父子关系存在循环' });
        break;
      }
      visited.add(cursor.parentId);
      cursor = byId.get(cursor.parentId);
      if (!cursor) break;
    }
  }
  return issues;
}

export function normalizeDraftForSave(draft) {
  const next = normalizeDraftShape(draft);
  const byId = new Map(next.elements.map((item) => [item.id, item]));
  for (const element of next.elements) element.childrenIds = [];
  for (const element of next.elements) {
    if (element.parentId && byId.has(element.parentId)) {
      element.ownerRef = element.parentId;
      const parent = byId.get(element.parentId);
      element.ownerKind = parent?.ownerKind === 'application' || parent?.ownerKind === 'shared_component' ? 'shared_component' : 'component';
      element.pageId = element.ownerKind === 'shared_component' ? null : parent?.pageId || next.currentPageId;
      byId.get(element.parentId).childrenIds.push(element.id);
    } else {
      element.parentId = null;
      element.ownerRef = element.ownerKind === 'application' ? next.appKey : element.pageId || next.currentPageId;
      if (element.ownerKind !== 'application') element.ownerKind = 'page';
    }
  }
  next.updatedAt = new Date().toISOString();
  return normalizeDraftShape(next);
}
