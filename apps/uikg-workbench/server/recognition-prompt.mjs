import { ELEMENT_TYPES, RECOGNITION_ACTIONS, stringUnion } from './element-taxonomy.mjs';

const ELEMENT_TYPE_UNION = stringUnion(ELEMENT_TYPES);
const RECOGNITION_ACTION_UNION = stringUnion(RECOGNITION_ACTIONS);
const RECOGNITION_ELEMENT_SHAPE = `{candidateKey: string, label: string|null, visualDescription: string, elementType: ${ELEMENT_TYPE_UNION}, interactive: boolean, enabled: boolean|null, state: string|null, approximateRegion: {x:number,y:number,width:number,height:number}, geometryKind:"boundary"|"tap-target"|"approximate", geometryConfidence:number, meaning:{status:"known"|"candidate"|"unknown",description:string|null,evidence:{visibleTexts:string[],visibleIcons:string[],visibleStates:string[],visualCues:string[],userContext:string|null,unclassified:{type:string,detail:string|null}[]}}, dynamicContent:boolean, riskSignals:string[], confidence:number}`;

function runtimeStructureContext(runtimeStructure) {
  if (!runtimeStructure) return '本次识别请求未附带 UI Tree，请仅依据截图识别。';
  const serialized = JSON.stringify(runtimeStructure);
  const bounded = serialized.length > 160_000 ? `${serialized.slice(0, 160_000)}…` : serialized;
  return `以下结构与截图来自同一次冻结。hierarchy.root 是 Android 运行时节点树，bounds 的坐标空间由 coordinateSpace、origin 和 viewport 明确声明。运行时节点具有 bounds 时，必须优先按 bounds/viewport 计算 approximateRegion，不得再次按 DPR 缩放或自行目测替代；只有找不到对应运行时节点时才使用视觉估算。截图仍是可见事实的最终依据。递归识别列表项、卡片和设置行中的稳定标题、描述、图标、角标、当前值及独立操作控件，并用 relationships 表达关系。对于重复列表，必须为每个可见行创建独立的 list-item；checkbox、标题、描述、时间、角标等必须通过 contains 挂到对应 list-item，再由 list contains list-item。禁止把行内子元素直接平铺到 list；labels 只表达语义标注，不能代替 contains。结构与截图冲突时写入 uncertainties，不要输出截图中不可见的节点。\\n${bounded}`;
}

export function buildRecognitionPrompt(frameId, pageContext = '', runtimeStructure = null) {
  pageContext = `${pageContext}\n运行时界面结构：\n${runtimeStructureContext(runtimeStructure)}`;
  return `语言要求（最高优先级）：思考过程、推理内容和最终输出必须全部使用简体中文；JSON 键名与枚举值保持 Schema 约定。
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
按照 Navigation、Button & Switch、Input、Selector、Display、Container、Overlay & Feedback、Progress、Map、System、Gesture 分类选择最具体的 elementType。不得按消息、商品、审批、文件、广告等业务用途创建元素类型，业务语义只写入 label、visualDescription 和 meaning.description。Container 是分类名称而非元素类型，只允许使用 list、list-item、grouped-list、swipe-list、expandable-list、card、panel、section、form、table、chart、audio、video、image-viewer 或 file-preview 等可观察的具体结构或承载形态；form 是围绕数据录入或提交组织的字段集合，table 是按稳定行列对齐展示或编辑数据的结构。普通复合行使用 list-item，导航组合使用 navigation-bar，无法判断具体形态时 elementType 留空等待审核。重复列表中的每个可见行必须创建 list-item，行内所有子元素通过 contains 归属该行，labels 不得替代父子层级。音频、视频、图片查看和文件预览分别使用 audio、video、image-viewer、file-preview；图片无论展示商品、头像之外的业务对象还是其他内容都使用 image、thumbnail、preview、banner 或 carousel 等视觉类型。Overlay & Feedback 仅使用 dialog、confirm-dialog、bottom-sheet、popover、floating-card、toast 六种形态：dialog 是覆盖页面并承载内容或操作的弹窗；confirm-dialog 要求用户明确确认或取消；bottom-sheet 从屏幕底部出现；popover 依附具体元素出现；floating-card 是悬浮于页面上方、可交互且可能自动消失的卡片；toast 是无需交互、短暂显示的结果或状态反馈。错误、警告、成功、信息等反馈级别只写入描述。广告不设独立类型：页面上方的交互式或自动消失广告使用 floating-card，阻断式广告使用 dialog，页面内横幅广告使用 banner，底部半屏广告使用 bottom-sheet，并在描述中注明广告用途。按钮/开关类包含文字按钮、图标按钮、悬浮按钮、开关和滑块。选择器按实际交互形态判断：候选项默认隐藏并在点击后展开使用 dropdown-selector；候选项全部展示且单选使用 radio；候选项全部展示且多选使用 checkbox；滚动转轮使用 wheel-picker；日期、时间、日期时间和纯数字分别使用 date-picker、time-picker、date-time-picker、number-picker；前一级决定后一级候选使用 cascader；以标签添加、移除、筛选或多选使用 tag-selector，只读的文字或胶囊标签统一使用 static-label，不创建 label、static-chip、selectable-chip、filter-chip、action-chip 或 input-chip；在同一内容内切换状态、筛选条件或模式使用 segmented-selector。segmented-selector 不用于切换独立页面或主要内容区域，这种情况使用 tab。城市、地址、年份、数量等只是业务用途，按实际交互形态选择上述类型并写入 visualDescription 和 meaning.description。自动补全不是独立类型：根据控件本体选择 input、dropdown-selector、tag-selector 等，并只在描述中说明候选建议行为。输入框只允许使用 input（单行）、text-area（多行）或 rich-text-input（富文本）；搜索、密码、数字、金额、邮箱、手机号、验证码、PIN、聊天等具体用途写入 visualDescription 和 meaning.description，不得创造用途型输入框类型。Progress 仅使用 progress-bar 或 loading；环形、线形、骨架屏、下载进度等具体功能和视觉样式写入 visualDescription 与 meaning.description。滚动是元素动作而不是元素类型：对实际容器选择 list、carousel、section 等具体类型，并通过 actionCandidates.action 记录 scroll_vertical、scroll_horizontal 或 swipe。盘点每个可见元素、标签、图标、状态指示器、结构容器、稳定内容锚点和关系。复合行、说明标签、当前值和实际触发器需要分开记录。actionCandidates.action 只描述用户实际执行的物理交互，不描述删除、提交、跳转等业务结果；例如点击删除按钮应使用 action="tap"，并在 expectedOutcome 中描述“删除对应对象”。没有动作的元素不要返回 actionCandidate；expectedOutcome 必须描述该动作在当前元素上的具体效果。手势区域与交互能力必须分离。在 meaning.evidence 中记录可见事实，不要编造不存在的证据。visibleTexts 放可见文字，visibleIcons 放可识别图标，visibleStates 放选中、禁用或开关状态，visualCues 放其他形状、颜色和布局证据，userContext 放用户提供的知识，其余证据放入 unclassified。JSON 必须紧凑且完整，所有 required 顶层字段都要返回。approximateRegion 使用 0 到 1 的归一化比例且不得越界；运行时节点存在时必须使用其 display_px bounds 除以截图 viewport，禁止乘除 DPR 或重复加减状态栏偏移。candidateKey 必须是稳定、唯一的 ASCII 语义 key。无法证实的含义保持 unknown。不要规划或执行操作。frameId 必须严格等于 ${JSON.stringify(frameId)}。用户页面上下文：${pageContext || '未提供'}。`;
}

export function buildRecognitionContinuationPrompt(frameId, pageContext, checkpoint, attempt, runtimeStructure = null) {
  pageContext = `${pageContext}\n运行时界面结构：\n${runtimeStructureContext(runtimeStructure)}`;
  return `语言要求（最高优先级）：思考过程、推理内容和最终输出必须全部使用简体中文；JSON 键名与枚举值保持 Schema 约定。
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
