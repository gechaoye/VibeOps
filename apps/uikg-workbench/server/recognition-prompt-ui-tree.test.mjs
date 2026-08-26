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
  assert.match(prompt, /不补造头像、图标或占位元素/);
  assert.match(prompt, /abstraction\.kind=repeated-template/);
});

test('识别 prompt 将动态槽位定义为单实例动态元素共相', () => {
  const prompt = buildRecognitionPrompt(frameId, '测试页面', null, DEFAULT_RECOGNITION_PROMPT_RULES);
  const continuationPrompt = buildRecognitionContinuationPrompt(frameId, '', { completedCandidates: [], coveredBottom: 0.5 }, 1, null, DEFAULT_RECOGNITION_PROMPT_RULES);

  for (const value of [prompt, continuationPrompt]) {
    assert.match(value, /abstraction\.kind=dynamic-template/);
    assert.match(value, /instanceCount 固定为 1/);
    assert.match(value, /当前用户头像、姓名、组织、部门或职位/);
    assert.match(value, /动态元素共相/);
    assert.match(value, /随账号、时间、状态或数据变化的可见内容必须设置 dynamicContent=true/);
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
