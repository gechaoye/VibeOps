import { ELEMENT_TYPES, WORKER_ACTIONS, stringUnion } from './element-taxonomy.mjs';

const ELEMENT_TYPE_UNION = stringUnion(ELEMENT_TYPES);
const WORKER_ACTION_UNION = stringUnion(WORKER_ACTIONS);
const WORKER_ELEMENT_SHAPE = `{candidateKey: string, label: string|null, visualDescription: string, controlType: ${ELEMENT_TYPE_UNION}, interactive: boolean, enabled: boolean|null, state: string|null, approximateRegion: {x:number,y:number,width:number,height:number}, geometryKind:"boundary"|"tap-target"|"approximate", geometryConfidence:number, meaning:{status:"known"|"candidate"|"unknown",description:string|null,evidence:{visibleTexts:string[],visibleIcons:string[],visibleStates:string[],visualCues:string[],userContext:string|null,unclassified:{type:string,detail:string|null}[]}}, dynamicContent:boolean, riskSignals:string[], confidence:number}`;

export function buildWorkerPrompt(frameId, pageContext = '') {
  return `语言要求（最高优先级）：思考过程、推理内容和最终输出必须全部使用简体中文；JSON 键名与枚举值保持 Schema 约定。
请查看完整、稳定的 Android 截图，并严格返回以下结构的一个 JSON 对象。所有自然语言字段必须使用简体中文，不要输出 Markdown：
{
  frameId: string,
  page: {name: string|null, surfaceType: "page"|"dialog"|"drawer"|"bottom-sheet"|"menu"|"shared-component"|"unknown", stateSummary: string, scrollableRegions: string[]},
  elements: [${WORKER_ELEMENT_SHAPE}],
  relationships: [{fromCandidateKey:string,type:"contains"|"labels"|"controls"|"belongs-to"|"adjacent-to",toCandidateKey:string}],
  actionCandidates: [{triggerCandidateKey:string,action:${WORKER_ACTION_UNION},expectedOutcome:string|null,basis:"visible-affordance"|"user-context"|"requirement-document"|"existing-graph"|"authority-contract"|"unknown",riskSignals:string[],confidence:number}],
  comparison: {basisFrameId:null,status:"not-requested",changes:[]},
  uncertainties: string[]
}.
按照 Navigation、Action、Input、Selection、Display、List、Container、Overlay、Scroll、Feedback、Progress、Media、Map、System、Gesture、Business 分类选择最具体的 controlType。盘点每个可见元素、标签、图标、状态指示器、结构容器、稳定内容锚点和关系。复合行容器、说明标签、当前值和实际触发器需要分开记录。actionCandidates 只使用元素实际支持的操作；没有动作的元素不要返回 actionCandidate；expectedOutcome 必须描述该动作在当前元素上的具体效果。手势区域与交互能力必须分离。在 meaning.evidence 中记录可见事实，不要编造不存在的证据。visibleTexts 放可见文字，visibleIcons 放可识别图标，visibleStates 放选中、禁用或开关状态，visualCues 放其他形状、颜色和布局证据，userContext 放用户提供的知识，其余证据放入 unclassified。JSON 必须紧凑且完整，所有 required 顶层字段都要返回。approximateRegion 使用 0 到 1 的归一化比例且不得越界。candidateKey 必须是稳定、唯一的 ASCII 语义 key。几何信息只是候选范围，不是精确定位器。无法证实的含义保持 unknown。不要规划或执行操作。frameId 必须严格等于 ${JSON.stringify(frameId)}。用户页面上下文：${pageContext || '未提供'}。`;
}

export function buildWorkerContinuationPrompt(frameId, pageContext, checkpoint, attempt) {
  return `语言要求（最高优先级）：思考过程、推理内容和最终输出必须全部使用简体中文；JSON 键名与枚举值保持 Schema 约定。
第 ${attempt} 次请求错误后，请从同一冻结画面的断点继续。这是增量续写，不是重新识别；不要从截图顶部重新开始，也不要重复已完成候选。所有自然语言字段必须使用简体中文。
已完成候选和覆盖范围：
${JSON.stringify(checkpoint)}

从归一化纵向位置 ${checkpoint.coveredBottom || 0} 之后开始。如果可见元素已覆盖完毕，则返回 elements:[]，只补齐缺失的顶层字段。禁止返回 completedCandidates 中已有的 candidateKey。只返回剩余工作：
{
  frameId: string,
  page: {name: string|null, surfaceType: "page"|"dialog"|"drawer"|"bottom-sheet"|"menu"|"shared-component"|"unknown", stateSummary: string, scrollableRegions: string[]},
  elements: [${WORKER_ELEMENT_SHAPE}],
  relationships: [{fromCandidateKey:string,type:"contains"|"labels"|"controls"|"belongs-to"|"adjacent-to",toCandidateKey:string}],
  actionCandidates: [{triggerCandidateKey:string,action:${WORKER_ACTION_UNION},expectedOutcome:string|null,basis:"visible-affordance"|"user-context"|"requirement-document"|"existing-graph"|"authority-contract"|"unknown",riskSignals:string[],confidence:number}],
  comparison: {basisFrameId:null,status:"not-requested",changes:[]},
  uncertainties: string[],
  done: boolean
}.
仅返回断点中不存在的元素，并使用新的稳定 ASCII candidateKey。必要时可返回涉及已有和新增候选的关系与动作。元素类型和元素动作必须使用上述枚举，元素类型与交互能力需要分开判断。只有断点后的所有可见区域及缺失顶层字段都完成后，才能设置 done=true。证据保持简洁。frameId 仍为 ${JSON.stringify(frameId)}。用户页面上下文：${pageContext || '未提供'}。`;
}
