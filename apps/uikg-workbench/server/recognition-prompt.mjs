import { ELEMENT_TYPES, RECOGNITION_ACTIONS, stringUnion } from './element-taxonomy.mjs';

const ELEMENT_TYPE_UNION = stringUnion(ELEMENT_TYPES);
const RECOGNITION_ACTION_UNION = stringUnion(RECOGNITION_ACTIONS);
const INTERACTION_BOUNDARY_UNION = '"none"|"candidate_bbox"|"whole_element"|"trailing_control"|"point_only"|"unresolved"';
const INTERACTION_BOUNDARY_RULE = 'interactionBoundary 枚举规则：none 表示无独立交互；candidate_bbox 表示字段自身 bbox；whole_element 表示整个所属元素；trailing_control 表示尾部独立控件；point_only 表示点状目标；unresolved 表示无法确认。abstraction.fields[*].interactionBoundary 必须严格使用这六个值，不得返回 tap-target、自然语言或 geometryKind 的值。';
const FIELD_AND_DYNAMIC_GEOMETRY_RULE = '字段与动态载荷规则：序号、必填标记和字段标签是职责不同的独立可见字段，各自 bbox 只覆盖自身实际可见区域，不得把相邻字段合入，也不预设固定排列方向。同一语义容器内，稳定视觉槽位只要由可见结构、运行时证据或明确的业务语义确认属于同一运行时载荷、会共同变化且共享一个稳定边界，就归为 instanceCount=1 的 dynamic-template；业务语义不是标题专属：只要语义明确某个槽位承载当前用户、接收人或接收群、成员、负责人、报告主体、实时业务值或其他会被业务数据替换的对象，即使只有一个可见字段、没有头像或其他结构化兄弟字段，也应保留为单实例动态共相。标题呈现“某主体的日报/周报/报告/汇报”以及业务填写、编辑或提交流程中的“日报标题”是其中的强示例；列表列头、分组/区域标题和设置标题不属于该槽位，不得因标签相同而提升。时间、日期、状态和进度等业务字段，只有可见文本同时呈现实际值（如“提交时间：当日09:00-18:00”“报告状态：已提交”）或 meaning 明确运行时来源时才提升，裸字段标签保持静态。多个独立可见实体不得强行压成单实例。独立操作控件和状态控件保持普通子元素；业务语义可以判定动态性，但不能伪造不可见字段、改变 bbox、实例坐标、父子关系或实例数量。';
const DYNAMIC_PAYLOAD_EVIDENCE_RULE = '共同载荷边界规则：除上述业务报告标题例外，不得仅根据业务文案、candidateKey 或邻近关系推断共同载荷；必须有可见稳定边界、运行时结构或明确业务语义对应的动态槽位。业务页面名称（例如“工作台”）单独不能证明任意字段是动态值；普通说明、列表列头和裸字段标签保持静态。';
const BUSINESS_RULE_SCOPE = '业务规则评估边界：业务规则可以补充元素含义、数据来源、状态和动态性线索，并可作为 uncertainties 或审核依据；不能覆盖截图或 UI Tree 的可见事实，不能指定或改写 bbox、实例坐标、父子关系、实例数量、交互边界或元素删除。业务文案和 candidateKey 只能作为语义线索，不能作为几何修正依据。规则与运行时证据冲突时保留可见候选并标记风险，不得为了满足业务规则伪造不可见元素或动态共相。';
const BUSINESS_TITLE_RULE = '业务语义规则：业务语义是动态性判定的一等依据，不限于标题。若可见稳定槽位的语义明确指向当前用户、接收人或接收群、成员、负责人、报告主体、实时状态、业务对象或业务数据，并且页面上下文或字段描述说明其内容会被运行时替换，应设置 dynamicContent=true 并创建 instanceCount=1 的 dynamic-template 共相；“某主体的日报/周报/报告/汇报”以及业务填写、编辑或提交流程中的“日报标题”等泛化标题只是强示例。列表列头、分组/区域标题和设置标题即使标签相同也保持静态。时间、日期、状态和进度字段应在可见文本含实际值或 meaning 明确运行时来源时提升，裸字段标签保持静态。只有语义槽位本身对应运行时载荷时才提升，普通分组标题、结构容器和独立操作控件不得提升。业务规则只决定语义和动态性，不补造不可见字段，不改变截图测得的 bbox、实例区域、实例数量、父子关系或交互边界。';
export const SYSTEM_CHROME_EXCLUSION_RULE = '系统栏排除规则：系统状态栏和系统导航栏只作为完整截图坐标基准，不属于业务页面元素。不得在 elements 中输出 elementType=status-bar 或 elementType=system-navigation-bar 的元素，也不得输出其子元素、relationships 或 actionCandidates；页面自身的 navigation-bar、返回、标题和操作按钮仍须正常识别。';
const HIERARCHY_DECISION_RULE = '页面层级规则：优先依据运行时节点树、DOM/UI Tree 的包含关系和可见边界建立父子关系。结构容器承载其可见子元素；重复或动态载荷应作为容器内的共相元素；独立操作控件保持为直接子元素。输入框的描边属于输入框自身边界，空白结构节点或编辑器外层不要另建业务元素。外层 form 或 WebView 祖先不得与内层 section 同时作为同一子元素的直接父级；若两者都覆盖子元素，只保留最近、最具体的语义容器。已确认的 contains 关系优先于同一对元素的 adjacent-to 关系。';
const ABSTRACTION_DECISION_RULE = '共相判定规则：业务字段含义与结构共相是两个维度。只要多个对象共享稳定的视觉结构和交互职责，就可以归纳为同一个 repeated-template；业务标签不同不是排除理由。若多个表单字段都由块级容器、可见标题、必填标记和多行输入框组成，应作为同一字段模板的多个实例，并分别保留每个实例的可见标签、必填状态和位置。只有结构或交互职责不一致时才不要归纳。表单字段块的每个实例必须对应截图中一个视觉上独立的可填写块；块之间透出的背景或其他分隔带只用于确定相邻实例边界，不能把整个 form 或多个块合并成一个实例，也不能用输入框边界代替块级实例边界。若重复字段标题由序号、必填标记、字段标签组成，序号、必填标记、字段标签必须作为职责不同的独立 fields；输入框内可见的占位提示语也必须作为独立 placeholder field，不得合并进字段标签或输入框描述。每个 field 的 parentId 只能为 null 或本次 elements 中真实存在的 candidateKey；字段直属当前共相时使用所属元素的 candidateKey，禁止使用 templateKey、字段路径、内部 ID 或自行拼接的字符串。每个 field 的 instanceRegions 按实例索引记录截图中实际可见的区域；某个中间实例未观测时保留 null 以维持索引，不可见的占位语、标记或标题不补造 bbox。跨实例共享且连续的视觉分隔边界是多个独立块级容器的强证据，不预设颜色、明暗或方向；应根据边界的连续性、厚度、与相邻区域的对比以及横向或纵向跨度识别，并沿实际分隔方向确定实例边界。实例边界必须覆盖对应块内可见标题和输入控件。整体数据录入集合使用 form；其中重复的表单字段块共相使用 section，不得误用 list-item，也不得把整个 form 本身当成单个字段块。若控件朝截图边缘延伸且未看到结束边框，必须直接判定为部分可见，bbox 截止到截图可见边界；不再讨论、估计或补全屏幕外高度。纯结构重复但载荷不随运行时变化的 repeated-template 必须设置 dynamicContent=false；form、input、text-area、rich-text-input 及包含这些字段的模板，不得仅因用户将来会填写不同内容就标记为 dynamic-template。dynamic-template 仅用于会作为同一运行时载荷共同变化的展示字段。位于重复块之外、与所有实例共同关联的独立按钮、导航入口或操作控件必须作为普通顶层元素输出，不得放进任何共相 fields。abstraction.fields 描述模板内每个稳定结构槽位，包括可编辑的 input、text-area 或 rich-text-input 槽位。位于模板实例内且已由这些 fields 表达的输入控件，只在对应 field 中记录 capabilities、actionEffects 和 instanceRegions，不得在 elements 中重复输出，也不创建 actionCandidate。仅有位于模板之外，或结构与模板字段不一致的独立交互控件才作为顶层元素。actionCandidates.triggerCandidateKey 只能引用顶层独立元素的 key，禁止使用 form_section.text_input 或 page_header.action_button 这类字段路径。';
const RECOGNITION_ELEMENT_SHAPE = `{candidateKey: string, label: string|null, visualDescription: string, displayCondition: string, elementType: ${ELEMENT_TYPE_UNION}, interactive: boolean, enabled: boolean|null, state: string|null, approximateRegion: {x:number,y:number,width:number,height:number}, geometryKind:"boundary"|"tap-target"|"approximate", geometryConfidence:number, meaning:{status:"known"|"candidate"|"unknown",description:string|null,evidence:{visibleTexts:string[],visibleIcons:string[],visibleStates:string[],visualCues:string[],userContext:string|null,unclassified:{type:string,detail:string|null}[]}}, dynamicContent:boolean, abstraction:null|{kind:"repeated-template"|"dynamic-template",templateKey:string,instanceCount:number,fields:{key:string,label:string,elementType:string,description:string,displayCondition:string,capabilities:string[],interactionBoundary:${INTERACTION_BOUNDARY_UNION},actionEffects:{action:string,effect:string}[],parentId:string|null,required:boolean,instanceRegions:(null|{x:number,y:number,width:number,height:number})[]}[],instanceRegions:{x:number,y:number,width:number,height:number}[],bboxStyle:"abstract"}, riskSignals:string[], confidence:number}`;

function baseRuntimeStructureContext(runtimeStructure) {
  if (!runtimeStructure) return '本次识别请求未附带 UI Tree，请仅依据截图识别。';
  const serialized = JSON.stringify(runtimeStructure);
  // DOM nodes are filtered to the selected WebView document before reaching
  // this prompt. Never cut by byte count: a tail node can be the only anchor
  // for a control near the bottom of a long screenshot.
  const bounded = serialized;
  return `以下结构与截图来自同一次冻结。hierarchy.root 是 Android 运行时节点树，bounds 的坐标空间由 coordinateSpace、origin 和 viewport 明确声明。只有候选自身存在对应运行时节点时，才优先按该节点 bounds/viewport 计算 approximateRegion；不得把 WebView 或其他祖先容器的 bounds 当作其内部子元素边界，不得再次按 DPR 缩放。WebView 内部若没有对应节点，必须逐项按完整截图的实际边界测量，禁止根据首项位置或假定等间距推算后续项。截图仍是可见事实的最终依据。递归识别列表项、卡片和设置行中的稳定字段结构及独立操作控件，并用 relationships 表达关系。不要输出截图中不可见的节点。\\n${bounded}`;
}

function runtimeStructureContext(runtimeStructure) {
  return baseRuntimeStructureContext(runtimeStructure);
}

function managedRulesContext(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return '';
  const sections = [
    ['element-universal', '元素共相规则（优先于通用识别规则）'],
    ['custom', '自定义规则（优先于通用识别规则）'],
  ].map(([category, title]) => {
    const categoryRules = rules.filter((rule) => rule.category === category);
    if (categoryRules.length === 0) return '';
    return `${title}：\n${categoryRules.map((rule, index) => `${index + 1}. ${rule.title}：${rule.description}`).join('\n')}`;
  }).filter(Boolean);
  return sections.length > 0 ? `\n${sections.join('\n')}` : '';
}

export function buildRecognitionPrompt(frameId, pageContext = '', runtimeStructure = null, managedRules = []) {
  pageContext = `${pageContext}\n所有视觉 bbox 必须相对完整截图（含系统状态栏）归一化，不得改用 WebView 内容区域或裁剪后的局部高度。\n运行时界面结构：\n${runtimeStructureContext(runtimeStructure)}${managedRulesContext(managedRules)}`;
  return `输出要求（最高优先级）：最终仅输出一个 JSON 对象，禁止输出分析过程、方案比较、Markdown 或 JSON 之外的文字；自然语言字段使用简体中文，JSON 键名与枚举值保持 Schema 约定。
${INTERACTION_BOUNDARY_RULE}
${FIELD_AND_DYNAMIC_GEOMETRY_RULE}
${DYNAMIC_PAYLOAD_EVIDENCE_RULE}
${BUSINESS_RULE_SCOPE}
${BUSINESS_TITLE_RULE}
${SYSTEM_CHROME_EXCLUSION_RULE}
${ABSTRACTION_DECISION_RULE}
${HIERARCHY_DECISION_RULE}
请查看完整、稳定的 Android 截图，并严格返回以下结构的一个 JSON 对象。所有自然语言字段必须使用简体中文，不要输出 Markdown：
{
  frameId: string,
  page: {name: string|null, surfaceType: "page"|"dialog"|"drawer"|"bottom-sheet"|"menu"|"shared-component"|"unknown", stateSummary: string, scrollableRegions: string[]},
  elements: [${RECOGNITION_ELEMENT_SHAPE}],
  relationships: [{fromCandidateKey:string,type:"contains"|"labels"|"controls"|"belongs-to"|"adjacent-to",toCandidateKey:string}],
  actionCandidates: [{triggerCandidateKey:string,action:${RECOGNITION_ACTION_UNION},expectedOutcome:string|null,basis:"visible-affordance"|"user-context"|"requirement-document"|"existing-graph"|"authority-contract"|"unknown",riskSignals:string[],confidence:number}],
  comparison: {basisFrameId:null,status:"not-requested",changes:[]},
  uncertainties: string[]
}.
按照 Navigation、Button & Switch、Input、Selector、Display、Container、Overlay & Feedback、Progress、Map、System、Gesture 分类选择最具体的 elementType。不得按消息、商品、审批、文件、广告等业务用途创建元素类型，业务语义只写入 label、visualDescription 和 meaning.description。Container 是分类名称而非元素类型，只允许使用 list、list-item、grouped-list、swipe-list、expandable-list、card、panel、section、form、table、chart、audio、video、image-viewer 或 file-preview 等可观察的具体结构或承载形态；form 是围绕数据录入或提交组织的字段集合，table 是按稳定行列对齐展示或编辑数据的结构。普通复合行使用 list-item，导航组合使用 navigation-bar，无法判断具体形态时 elementType 留空等待审核。不满足共相条件的重复列表中，每个可见行必须创建 list-item，行内所有子元素通过 contains 归属该行，labels 不得替代父子层级。若某个稳定视觉槽位的承载边界、字段结构或交互职责保持不变，而其内容会随账号、时间、状态、数据、配置、网络、实验分流、播放进度或自动轮换替换，必须设置 dynamicContent=true 并按元素实际形态创建一个 abstraction.kind=dynamic-template、instanceCount=1 的动态元素共相；适用于当前用户资料、轮播/横幅、推荐或广告位、实时指标/状态、媒体封面、通知提示、倒计时、进度和结果区域。共相只记录会作为同一载荷共同变化的可见稳定字段、显示条件和交互职责，当前文字、图片、数值、数量、顺序和业务对象只作为观测；相邻的独立按钮和操作入口必须另建普通元素。仅短暂动画或颜色变化、没有稳定槽位证据时不要创建动态元素共相。音频、视频、图片查看和文件预览分别使用 audio、video、image-viewer、file-preview；图片无论展示商品、头像之外的业务对象还是其他内容都使用 image、thumbnail、preview、banner 或 carousel 等视觉类型。Overlay & Feedback 仅使用 dialog、confirm-dialog、bottom-sheet、popover、floating-card、toast 六种形态：dialog 是覆盖页面并承载内容或操作的弹窗；confirm-dialog 要求用户明确确认或取消；bottom-sheet 从屏幕底部出现；popover 依附具体元素出现；floating-card 是悬浮于页面上方、可交互且可能自动消失的卡片；toast 是无需交互、短暂显示的结果或状态反馈。错误、警告、成功、信息等反馈级别只写入描述。广告不设独立类型：页面上方的交互式或自动消失广告使用 floating-card，阻断式广告使用 dialog，页面内横幅广告使用 banner，底部半屏广告使用 bottom-sheet，并在描述中注明广告用途。按钮/开关类包含文字按钮、图标按钮、悬浮按钮、开关和滑块。选择器按实际交互形态判断：候选项默认隐藏并在点击后展开使用 dropdown-selector；候选项全部展示且单选使用 radio；候选项全部展示且多选使用 checkbox；滚动转轮使用 wheel-picker；日期、时间、日期时间和纯数字分别使用 date-picker、time-picker、date-time-picker、number-picker；前一级决定后一级候选使用 cascader；以标签添加、移除、筛选或多选使用 tag-selector，只读的文字或胶囊标签统一使用 static-label，不创建 label、static-chip、selectable-chip、filter-chip、action-chip 或 input-chip；在同一内容内切换状态、筛选条件或模式使用 segmented-selector。segmented-selector 不用于切换独立页面或主要内容区域，这种情况使用 tab。城市、地址、年份、数量等只是业务用途，按实际交互形态选择上述类型并写入 visualDescription 和 meaning.description。自动补全不是独立类型：根据控件本体选择 input、dropdown-selector、tag-selector 等，并只在描述中说明候选建议行为。输入框只允许使用 input（单行）、text-area（多行）或 rich-text-input（富文本）；搜索、密码、数字、金额、邮箱、手机号、验证码、PIN、聊天等具体用途写入 visualDescription 和 meaning.description，不得创造用途型输入框类型。Progress 仅使用 progress-bar 或 loading；环形、线形、骨架屏、下载进度等具体功能和视觉样式写入 visualDescription 与 meaning.description。滚动是元素动作而不是元素类型：对实际容器选择 list、carousel、section 等具体类型，并通过 actionCandidates.action 记录 scroll_vertical、scroll_horizontal 或 swipe。盘点每个可见元素、标签、图标、状态指示器、结构容器、稳定内容锚点和关系。复合行、说明标签、当前值和实际触发器需要分开记录。actionCandidates.action 只描述用户实际执行的物理交互，不描述删除、提交、跳转等业务结果；例如点击删除按钮应使用 action="tap"，并在 expectedOutcome 中描述“删除对应对象”。没有动作的元素不要返回 actionCandidate；expectedOutcome 必须描述该动作在当前元素上的具体效果。手势区域与交互能力必须分离。在 meaning.evidence 中记录可见事实，不要编造不存在的证据。visibleTexts 放可见文字，visibleIcons 放可识别图标，visibleStates 放选中、禁用或开关状态，visualCues 放其他形状、颜色和布局证据，userContext 放用户提供的知识，其余证据放入 unclassified。JSON 必须紧凑且完整，所有 required 顶层字段都要返回。approximateRegion 使用 0 到 1 的归一化比例且不得越界；运行时节点存在时必须使用其 display_px bounds 除以截图 viewport，禁止乘除 DPR 或重复加减状态栏偏移。没有运行时 bounds 的 WebView 内元素必须逐项按截图实际位置测量，禁止用首项位置和等间距推算后续项。candidateKey 必须是稳定、唯一的 ASCII 语义 key。无法证实的含义保持 unknown。不要规划或执行操作。frameId 必须严格等于 ${JSON.stringify(frameId)}。用户页面上下文：${pageContext || '未提供'}。`;
}

export function buildRecognitionContinuationPrompt(frameId, pageContext, checkpoint, attempt, runtimeStructure = null, managedRules = []) {
  pageContext = `${pageContext}\n所有视觉 bbox 必须相对完整截图（含系统状态栏）归一化，不得改用 WebView 内容区域或裁剪后的局部高度。\n运行时界面结构：\n${runtimeStructureContext(runtimeStructure)}${managedRulesContext(managedRules)}`;
  return `输出要求（最高优先级）：最终仅输出一个 JSON 对象，禁止输出分析过程、方案比较、Markdown 或 JSON 之外的文字；自然语言字段使用简体中文，JSON 键名与枚举值保持 Schema 约定。
${INTERACTION_BOUNDARY_RULE}
${FIELD_AND_DYNAMIC_GEOMETRY_RULE}
${DYNAMIC_PAYLOAD_EVIDENCE_RULE}
${BUSINESS_RULE_SCOPE}
${BUSINESS_TITLE_RULE}
${SYSTEM_CHROME_EXCLUSION_RULE}
${ABSTRACTION_DECISION_RULE}
${HIERARCHY_DECISION_RULE}
第 ${attempt} 次请求错误后，请从同一冻结画面的断点继续。这是增量续写，不是重新识别；不要从截图顶部重新开始，也不要重复已完成候选。所有自然语言字段必须使用简体中文。
已完成候选和覆盖范围：
${JSON.stringify(checkpoint)}

从归一化纵向位置 ${checkpoint.coveredBottom || 0} 之后开始。如果可见元素已覆盖完毕，则返回 elements:[]，只补齐缺失的顶层字段。禁止返回 completedCandidates 中已有的 candidateKey。只返回剩余工作：
{
  frameId: string,
  page: {name: string|null, surfaceType: "page"|"dialog"|"drawer"|"bottom-sheet"|"menu"|"shared-component"|"unknown", stateSummary: string, scrollableRegions: string[]},
  elements: [${RECOGNITION_ELEMENT_SHAPE}],
  relationships: [{fromCandidateKey:string,type:"contains"|"labels"|"controls"|"belongs-to"|"adjacent-to",toCandidateKey:string}],
  actionCandidates: [{triggerCandidateKey:string,action:${RECOGNITION_ACTION_UNION},expectedOutcome:string|null,basis:"visible-affordance"|"user-context"|"requirement-document"|"existing-graph"|"authority-contract"|"unknown",riskSignals:string[],confidence:number}],
  comparison: {basisFrameId:null,status:"not-requested",changes:[]},
  uncertainties: string[],
  done: boolean
}.
仅返回断点中不存在的元素，并使用新的稳定 ASCII candidateKey。必要时可返回涉及已有和新增候选的关系与动作。元素类型和元素动作必须使用上述枚举，元素类型与交互能力需要分开判断。不得创建业务用途型元素；具体业务含义只写入描述。Container 只使用 list、list-item、grouped-list、swipe-list、expandable-list、card、panel、section、form、table、chart、audio、video、image-viewer、file-preview 等具体形态；form 组织录入或提交字段，table 按行列对齐数据；复合行使用 list-item，导航组合使用 navigation-bar。Overlay & Feedback 仅使用 dialog、confirm-dialog、bottom-sheet、popover、floating-card、toast：弹窗使用 dialog，确认框使用 confirm-dialog，底部浮层使用 bottom-sheet，依附元素的泡泡框使用 popover，可交互且可能自动消失的浮层卡片使用 floating-card，无需交互的短暂反馈使用 toast。反馈级别和广告用途只写入描述；广告按实际形态使用 floating-card、dialog、banner 或 bottom-sheet。交互标签统一使用 tag-selector，只读文字或胶囊标签统一使用 static-label。选择器按候选项呈现方式和交互机制选择 dropdown-selector、radio、checkbox、wheel-picker、date-picker、time-picker、date-time-picker、number-picker、cascader、tag-selector 或 segmented-selector；具体业务用途和自动补全行为只写入描述。segmented-selector 选择状态、筛选或模式，tab 切换独立页面或主要内容区域。输入框只区分 input（单行）、text-area（多行）和 rich-text-input（富文本），具体业务用途写入描述。进度只使用 progress-bar 或 loading，具体功能与样式写入描述。滚动不作为元素类型，应选择实际容器，并使用 scroll_vertical、scroll_horizontal 或 swipe 动作。action 只描述物理交互；删除、提交、跳转等业务结果写入 expectedOutcome。只有断点后的所有可见区域及缺失顶层字段都完成后，才能设置 done=true。证据保持简洁。frameId 仍为 ${JSON.stringify(frameId)}。用户页面上下文：${pageContext || '未提供'}。`;
}
