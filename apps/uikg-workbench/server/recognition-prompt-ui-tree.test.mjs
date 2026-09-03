import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_RECOGNITION_PROMPT_RULES } from './model-settings-store.mjs';
import { buildRecognitionContinuationPrompt, buildRecognitionPrompt } from './recognition-prompt.mjs';

const frameId = 'sha256:ui-tree-prompt-test';
const runtimeStructure = {
  hierarchy: {
    hierarchySource: 'uiautomator',
    marker: 'UI_TREE_MARKER_72A6',
  },
};

test('识别 prompt 只在请求附带 UI Tree 时包含结构数据', () => {
  const withoutUiTree = buildRecognitionPrompt(frameId, '测试页面', null);
  const withUiTree = buildRecognitionPrompt(frameId, '测试页面', runtimeStructure);

  assert.doesNotMatch(withoutUiTree, /UI_TREE_MARKER_72A6/);
  assert.match(withoutUiTree, /本次识别请求未附带 UI Tree/);
  assert.match(withUiTree, /UI_TREE_MARKER_72A6/);
});

test('识别 prompt 明确限制 interactionBoundary 的 Schema 枚举', () => {
  const prompts = [
    buildRecognitionPrompt(frameId),
    buildRecognitionContinuationPrompt(frameId, '', { completedCandidates: [], coveredBottom: 0 }, 1),
  ];
  for (const prompt of prompts) {
    assert.match(prompt, /interactionBoundary:"none"\|"candidate_bbox"\|"whole_element"\|"trailing_control"\|"point_only"\|"unresolved"/);
    assert.match(prompt, /不得返回 tap-target、自然语言或 geometryKind 的值/);
  }
});

test('初次识别与断点续写都排除系统状态栏和系统导航栏', () => {
  const prompts = [
    buildRecognitionPrompt(frameId),
    buildRecognitionContinuationPrompt(frameId, '', { completedCandidates: [], coveredBottom: 0 }, 1),
  ];
  for (const prompt of prompts) {
    assert.match(prompt, /系统状态栏和系统导航栏只作为完整截图坐标基准/);
    assert.match(prompt, /不得在 elements 中输出 elementType=status-bar 或 elementType=system-navigation-bar/);
    assert.match(prompt, /页面自身的 navigation-bar、返回、标题和操作按钮仍须正常识别/);
  }
});

test('续写 prompt 沿用相同的 UI Tree 附带策略', () => {
  const checkpoint = { completedCandidates: [], coveredBottom: 0.5 };
  const withoutUiTree = buildRecognitionContinuationPrompt(frameId, '', checkpoint, 1, null);
  const withUiTree = buildRecognitionContinuationPrompt(frameId, '', checkpoint, 1, runtimeStructure);

  assert.doesNotMatch(withoutUiTree, /UI_TREE_MARKER_72A6/);
  assert.match(withUiTree, /UI_TREE_MARKER_72A6/);
});

test('列表项元素共相 prompt 只描述截图可见字段并禁止补造头像', () => {
  const prompt = buildRecognitionPrompt(frameId, '测试页面', null, DEFAULT_RECOGNITION_PROMPT_RULES);

  assert.match(prompt, /只记录截图实际可见/);
  assert.match(prompt, /不补造字段/);
  assert.match(prompt, /abstraction\.kind=repeated-template/);
});

test('识别 prompt 按视觉结构归纳表单字段块并识别分隔带边界', () => {
  const prompts = [
    buildRecognitionPrompt(frameId, '测试页面', null, DEFAULT_RECOGNITION_PROMPT_RULES),
    buildRecognitionContinuationPrompt(frameId, '', { completedCandidates: [], coveredBottom: 0.5 }, 1, null, DEFAULT_RECOGNITION_PROMPT_RULES),
  ];
  for (const prompt of prompts) {
    assert.match(prompt, /业务字段含义与结构共相是两个维度/);
    assert.match(prompt, /业务标签不同不是排除理由/);
    assert.match(prompt, /跨实例共享且连续的视觉分隔边界/);
    assert.doesNotMatch(prompt, /横向浅灰分隔带/);
    assert.match(prompt, /序号、必填标记、字段标签必须作为职责不同的独立 fields/);
    assert.match(prompt, /各自 bbox 只覆盖自身实际可见区域/);
    assert.match(prompt, /不预设固定排列方向/);
    assert.match(prompt, /占位提示语也必须作为独立 placeholder field/);
    assert.match(prompt, /不可见的占位语、标记或标题不补造 bbox/);
    assert.match(prompt, /中间实例未观测时保留 null 以维持索引/);
    assert.match(prompt, /表单字段块共相使用 section/);
    assert.match(prompt, /整体数据录入集合使用 form/);
    assert.match(prompt, /每个实例必须对应截图中一个视觉上独立的可填写块/);
    assert.match(prompt, /背景或其他分隔带/);
    assert.match(prompt, /包括可编辑的 input、text-area 或 rich-text-input 槽位/);
    assert.match(prompt, /不得在 elements 中重复输出/);
    assert.match(prompt, /只在对应 field 中记录 capabilities、actionEffects 和 instanceRegions/);
    assert.doesNotMatch(prompt, /每个可点击或可输入控件仍必须拥有独立的顶层 candidateKey/);
    assert.match(prompt, /未看到结束边框，必须直接判定为部分可见/);
    assert.match(prompt, /不再讨论、估计或补全屏幕外高度/);
    assert.match(prompt, /不得仅因用户将来会填写不同内容就标记为 dynamic-template/);
    assert.doesNotMatch(prompt, /不要将“导入上篇”归入任何共相/);
  }
});

test('识别 prompt 将动态槽位定义为单实例动态元素共相', () => {
  const prompt = buildRecognitionPrompt(frameId, '测试页面', null, DEFAULT_RECOGNITION_PROMPT_RULES);
  const continuationPrompt = buildRecognitionContinuationPrompt(frameId, '', { completedCandidates: [], coveredBottom: 0.5 }, 1, null, DEFAULT_RECOGNITION_PROMPT_RULES);

  for (const value of [prompt, continuationPrompt]) {
    assert.match(value, /abstraction\.kind=dynamic-template/);
    assert.match(value, /instanceCount 固定为 1/);
    assert.match(value, /当前用户头像、姓名、组织、部门或职位/);
    assert.match(value, /业务语义不是标题专属/);
    assert.match(value, /接收人或接收群、成员、负责人/);
    assert.match(value, /动态元素共相/);
    assert.match(value, /随账号、时间、状态或数据变化的可见内容必须设置 dynamicContent=true/);
    assert.match(value, /属于同一运行时载荷、会共同变化且共享一个稳定边界/);
    assert.match(value, /不得仅根据业务文案、candidateKey 或邻近关系推断共同载荷/);
    assert.match(value, /业务规则可以补充元素含义、数据来源、状态和动态性线索/);
    assert.match(value, /不能覆盖截图或 UI Tree 的可见事实/);
    assert.doesNotMatch(value, /接收人、接收群 section/);
  }
});

test('识别 prompt 将轮播作为动态元素共相的一种', () => {
  const prompt = buildRecognitionPrompt(frameId, '测试页面', null, DEFAULT_RECOGNITION_PROMPT_RULES);
  assert.match(prompt, /轮播\/横幅/);
  assert.match(prompt, /动态元素共相/);
  assert.match(prompt, /elementType=carousel/);
  assert.doesNotMatch(prompt, /轮播元素共相/);
  assert.doesNotMatch(prompt, /头像组边界|avatar-group 表示承载多个头像的容器/);
});

test('识别 prompt 拼接设置中维护的元素共相规则', () => {
  const prompt = buildRecognitionPrompt(frameId, '', null, [{ key: 'universal-rule', category: 'element-universal', title: '同构结构', description: '归纳共有交互' }]);
  assert.match(prompt, /元素共相规则（优先于通用识别规则）/);
  assert.match(prompt, /同构结构：归纳共有交互/);
  assert.doesNotMatch(prompt, /自定义规则（优先于通用识别规则）/);
});

test('识别 prompt 将自定义规则与元素共相规则分区拼接', () => {
  const prompt = buildRecognitionPrompt(frameId, '', null, [
    { key: 'universal-rule', category: 'element-universal', title: '同构结构', description: '归纳共有交互' },
    { key: 'custom-rule', category: 'custom', title: '自定义约束', description: '不要输出不可见控件' },
  ]);
  assert.match(prompt, /元素共相规则（优先于通用识别规则）：\n1\. 同构结构：归纳共有交互/);
  assert.match(prompt, /自定义规则（优先于通用识别规则）：\n1\. 自定义约束：不要输出不可见控件/);
});

test('删除元素共相规则后不会继续执行对应归纳要求', () => {
  const prompt = buildRecognitionPrompt(frameId, '测试页面', null, []);
  assert.doesNotMatch(prompt, /abstraction\.kind=repeated-template/);
  assert.doesNotMatch(prompt, /不论轮播图数量/);
  assert.doesNotMatch(prompt, /当前用户资料共相/);
  assert.doesNotMatch(prompt, /轮播元素共相/);
});
