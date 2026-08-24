import assert from 'node:assert/strict';
import test from 'node:test';
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
