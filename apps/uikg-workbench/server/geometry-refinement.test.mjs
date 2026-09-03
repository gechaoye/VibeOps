import assert from 'node:assert/strict';
import test from 'node:test';
import { refineRecognitionGeometryWithSources } from './geometry-refinement.mjs';
import { validateRecognitionConsistency } from './draft-model.mjs';

function meaning(texts) {
  return { evidence: { visibleTexts: texts, visibleIcons: [], visibleStates: [], visualCues: [], userContext: null, unclassified: [] } };
}

function element(candidateKey, label, elementType, approximateRegion, extra = {}) {
  return {
    candidateKey, label, elementType, approximateRegion,
    geometryKind: 'approximate', geometryConfidence: 0.95,
    meaning: meaning(label ? [label] : []), riskSignals: [],
    ...extra,
  };
}

function roundedBox(box) {
  return Object.fromEntries(Object.entries(box).map(([key, value]) => [key, Number(value.toFixed(6))]));
}

test('OCR 多锚点会校准长截图的纵向比例并同步更新抽象实例框', () => {
  const recognition = {
    elements: [element('rows', null, 'list-item', { x: 0.08, y: 0.16, width: 0.84, height: 0.26 }, {
      meaning: meaning(['1. 今日完成工作', '2. 明日工作计划', '3. 备注']),
      abstraction: {
        instanceRegions: [
          { x: 0.08, y: 0.16, width: 0.84, height: 0.26 },
          { x: 0.08, y: 0.44, width: 0.84, height: 0.26 },
          { x: 0.08, y: 0.72, width: 0.84, height: 0.26 },
        ],
        fields: [{ key: 'label', elementType: 'static-label', instanceRegions: [
          { x: 0.09, y: 0.16, width: 0.25, height: 0.02 },
          { x: 0.09, y: 0.44, width: 0.25, height: 0.02 },
          { x: 0.09, y: 0.72, width: 0.18, height: 0.02 },
        ] }],
      },
    })],
  };
  const ocr = {
    status: 'complete', engine: 'paddleocr', width: 1000, height: 2000,
    observations: [
      { text: '* 1. 今日完成工作', confidence: 0.9, rect: { x: 90, y: 380, width: 250, height: 40 } },
      { text: '2. 明日工作计划', confidence: 0.9, rect: { x: 90, y: 1060, width: 250, height: 40 } },
      { text: '3. 备注', confidence: 0.9, rect: { x: 90, y: 1740, width: 180, height: 40 } },
    ],
  };
  const result = refineRecognitionGeometryWithSources(recognition, null, ocr, { width: 1000, height: 2000 });
  assert.equal(result.geometryRefinement.ocrEngine, 'paddleocr');
  assert.equal(result.geometryRefinement.anchorCount, 3);
  assert.equal(result.geometryRefinement.calibration.reliable, true);
  assert.ok(Math.abs(result.geometryRefinement.calibration.y.scale - 1.214285714) < 0.01);
  const labels = result.elements[0].abstraction.fields[0].instanceRegions;
  assert.ok(Math.abs(labels[0].y - 0.19) < 0.01);
  assert.ok(Math.abs(labels[1].y - 0.53) < 0.01);
  assert.ok(Math.abs(labels[2].y - 0.87) < 0.01);
  assert.ok(result.elements[0].riskSignals.includes('geometry-calibrated-by-text-anchors'));
});

test('UI Tree 不会把 checkbox 候选吸附到同文案 TextView', () => {
  const recognition = { elements: [
    element('checkbox', '通过单聊发送给对方', 'checkbox', { x: 0.1, y: 0.8, width: 0.04, height: 0.04 }),
    element('label', '通过单聊发送给对方', 'static-label', { x: 0.16, y: 0.8, width: 0.35, height: 0.04 }),
  ] };
  const runtime = { hierarchy: {
    coordinateSpace: 'display_px', viewport: { width: 1000, height: 2000 },
    root: { class: 'FrameLayout', bounds: { left: 0, top: 0, right: 1000, bottom: 2000 }, children: [
      { class: 'TextView', text: '通过单聊发送给对方', clickable: false, bounds: { left: 160, top: 1600, right: 510, bottom: 1680 }, children: [] },
    ] },
  } };
  const result = refineRecognitionGeometryWithSources(recognition, runtime);
  assert.deepEqual(result.elements[0].approximateRegion, recognition.elements[0].approximateRegion);
  assert.ok(result.elements[0].riskSignals.includes('geometry-remains-approximate'));
  assert.deepEqual(result.elements[1].approximateRegion, { x: 0.16, y: 0.8, width: 0.35, height: 0.04 });
  assert.ok(result.elements[1].riskSignals.includes('geometry-grounded-by-ui-tree'));
});

test('DOM 精确边界优先于模型估算框', () => {
  const recognition = { elements: [element('remark', '请填写', 'text-area', { x: 0.2, y: 0.2, width: 0.5, height: 0.2 })] };
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 2000 }, root: null },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1000, height: 2000 }, nodes: [{
      tag: 'textarea', role: '', type: '', text: '请填写', interactive: true,
      bounds: { left: 100, top: 600, right: 900, bottom: 1200 },
    }] }] },
  };
  const result = refineRecognitionGeometryWithSources(recognition, runtime);
  assert.deepEqual(result.elements[0].approximateRegion, { x: 0.1, y: 0.3, width: 0.8, height: 0.3 });
  assert.equal(result.elements[0].geometryConfidence, 0.99);
  assert.ok(result.elements[0].riskSignals.includes('geometry-grounded-by-dom'));
});

test('DOM 相邻文本节点合并后准确校准业务日报动态标题', () => {
  const recognition = { elements: [element('form_heading', '葛超烨的日报', 'title', { x: 0.6, y: 0.04, width: 0.2, height: 0.02 }, {
    dynamicContent: false,
    abstraction: null,
  })] };
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: null },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1000, height: 1000 }, nodes: [
      { tag: 'div', text: '葛超烨的', bounds: { left: 100, top: 50, right: 430, bottom: 70 } },
      { tag: 'span', text: '日报', bounds: { left: 320, top: 48, right: 430, bottom: 71 } },
      { tag: 'div', text: '导入上篇', interactive: true, bounds: { left: 700, top: 50, right: 950, bottom: 70 } },
    ] }] },
  };
  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 1000 });
  assert.deepEqual(roundedBox(result.elements[0].approximateRegion), { x: 0.1, y: 0.048, width: 0.33, height: 0.023 });
  assert.equal(result.elements[0].dynamicContent, true);
  assert.equal(result.elements[0].abstraction?.kind, 'dynamic-template');
  assert.ok(result.elements[0].riskSignals.includes('business-dynamic-title-inferred'));
  assert.ok(result.elements[0].riskSignals.includes('geometry-grounded-by-dom'));
});

test('几何精修沿用业务填写上下文识别泛化的日报标题', () => {
  const recognition = {
    page: {
      name: '工作日志日报填写页面',
      stateSummary: '当前页面用于填写并提交日报',
    },
    elements: [element('report_heading', '日报标题', 'title', { x: 0.6, y: 0.04, width: 0.2, height: 0.02 }, {
      dynamicContent: false,
      abstraction: null,
    })],
  };
  const result = refineRecognitionGeometryWithSources(
    recognition,
    null,
    null,
    { width: 1000, height: 1000 },
  );
  assert.equal(result.elements[0].dynamicContent, true);
  assert.equal(result.elements[0].abstraction?.kind, 'dynamic-template');
  assert.equal(result.elements[0].abstraction?.templateKey, 'business.report-title');
  assert.ok(result.elements[0].riskSignals.includes('business-dynamic-title-inferred'));
});

test('geometry refinement 会把无业务语义的无结构标题降级为普通标题', () => {
  const recognition = { elements: [element('welcome_heading', '欢迎页主标题', 'title', { x: 0.4, y: 0.1, width: 0.3, height: 0.04 }, {
    dynamicContent: true,
  })] };
  const result = refineRecognitionGeometryWithSources(recognition, null, null, { width: 1000, height: 1000 });
  const title = result.elements[0];
  assert.equal(title.dynamicContent, false);
  assert.equal(title.abstraction, null);
  assert.ok(title.riskSignals.includes('unstructured-dynamic-title-downgraded'));
  assert.equal(result.geometryRefinement.dynamicTitleDowngradeCount, 1);
});

test('geometry refinement 保留单字段当前用户业务语义', () => {
  const recognition = { elements: [element('current_user_name', '当前用户姓名', 'static-label', { x: 0.4, y: 0.1, width: 0.3, height: 0.04 }, {
    dynamicContent: false,
    visualDescription: '当前登录用户的显示名称',
  })] };
  const result = refineRecognitionGeometryWithSources(recognition, null, null, { width: 1000, height: 1000 });
  const name = result.elements[0];
  assert.equal(name.dynamicContent, true);
  assert.equal(name.abstraction?.kind, 'dynamic-template');
  assert.equal(name.abstraction?.instanceCount, 1);
  assert.ok(name.riskSignals.includes('business-dynamic-semantic-inferred'));
  assert.equal(result.geometryRefinement.dynamicTitleDowngradeCount, 0);
});

test('geometry refinement 保留带头像和姓名字段的结构化动态标题', () => {
  const region = { x: 0.2, y: 0.1, width: 0.5, height: 0.1 };
  const recognition = { elements: [element('profile_title', '当前用户资料', 'title', region, {
    dynamicContent: true,
    abstraction: {
      kind: 'dynamic-template', templateKey: 'profile-title', instanceCount: 1,
      instanceRegions: [region], bboxStyle: 'abstract',
      fields: [
        { key: 'avatar', label: '用户头像', elementType: 'avatar', capabilities: ['none'], instanceRegions: [{ x: 0.21, y: 0.11, width: 0.08, height: 0.08 }] },
        { key: 'display-name', label: '用户姓名', elementType: 'title', capabilities: ['none'], instanceRegions: [{ x: 0.32, y: 0.12, width: 0.25, height: 0.04 }] },
      ],
    },
  })] };
  const result = refineRecognitionGeometryWithSources(recognition, null, null, { width: 1000, height: 1000 });
  const title = result.elements[0];
  assert.equal(title.dynamicContent, true);
  assert.equal(title.abstraction?.kind, 'dynamic-template');
  assert.equal(result.geometryRefinement.dynamicTitleDowngradeCount, 0);
});

test('模型漏报可见文本时由运行时补齐普通候选，不推断业务动态语义', () => {
  const recognition = { elements: [
    element('import_previous', '导入上篇', 'text-button', { x: 0.65, y: 0.03, width: 0.25, height: 0.04 }),
  ], relationships: [], actionCandidates: [] };
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: {
      class: 'FrameLayout', children: [
        { class: 'TextView', text: '动态状态', bounds: { left: 80, top: 100, right: 360, bottom: 140 }, children: [] },
      ],
    } },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1000, height: 1000 }, nodes: [
      { tag: 'div', text: '动态', bounds: { left: 80, top: 100, right: 220, bottom: 140 } },
      { tag: 'span', text: '状态', bounds: { left: 220, top: 100, right: 360, bottom: 140 } },
      { tag: 'div', text: '导入上篇', interactive: true, bounds: { left: 650, top: 100, right: 900, bottom: 140 } },
    ] }] },
  };
  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 1000 });
  const titles = result.elements.filter((item) => item.label === '动态状态');
  assert.equal(titles.length, 1);
  assert.equal(titles[0].elementType, 'static-label');
  assert.equal(titles[0].dynamicContent, false);
  assert.equal(titles[0].abstraction, null);
  assert.deepEqual(roundedBox(titles[0].approximateRegion), { x: 0.08, y: 0.1, width: 0.28, height: 0.04 });
  assert.equal(result.elements.some((item) => item.label === '动态'), false);
});

test('仅有标题候选时运行时会恢复缺失的语义 section', () => {
  const recognition = {
    elements: [
      element('daily_form', '工作日志表单', 'form', { x: 0, y: 0.1, width: 1, height: 0.8 }),
      element('group_heading', '接收群', 'static-label', { x: 0.08, y: 0.4, width: 0.84, height: 0.04 }),
      element('group_avatar', 'Onl...', 'avatar', { x: 0.09, y: 0.44, width: 0.12, height: 0.06 }),
      element('group_action', '添加接收群', 'icon-button', { x: 0.22, y: 0.44, width: 0.12, height: 0.04 }, { interactive: true }),
    ],
    relationships: [
      { fromCandidateKey: 'daily_form', type: 'contains', toCandidateKey: 'group_heading' },
      { fromCandidateKey: 'daily_form', type: 'contains', toCandidateKey: 'group_avatar' },
      { fromCandidateKey: 'daily_form', type: 'contains', toCandidateKey: 'group_action' },
    ],
  };
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: null },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1000, height: 1000 }, nodes: [
      { tag: 'div', text: '接收群', interactive: false, bounds: { left: 80, top: 400, right: 920, bottom: 440 } },
      { tag: 'img', text: '', interactive: true, role: 'img', bounds: { left: 90, top: 440, right: 170, bottom: 500 } },
      { tag: 'button', text: '添加接收群', interactive: true, role: 'button', bounds: { left: 220, top: 440, right: 340, bottom: 480 } },
    ] }] },
  };
  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 1000 });
  const section = result.elements.find((item) => item.candidateKey.startsWith('runtime_section_') && item.label === '接收群');
  assert.ok(section);
  assert.ok(result.relationships.some((relation) => relation.fromCandidateKey === section.candidateKey
    && relation.toCandidateKey === 'group_avatar' && relation.type === 'contains'));
  assert.equal(result.relationships.some((relation) => relation.fromCandidateKey === 'daily_form'
    && relation.toCandidateKey === 'group_avatar' && relation.type === 'contains'), false);
});

test('UI Automation 的精确短文本优先于 DOM 的长文本近似匹配', () => {
  const recognition = { elements: [element('submit', '提交', 'text-button', { x: 0.8, y: 0.01, width: 0.1, height: 0.02 })] };
  const runtime = {
    hierarchy: {
      coordinateSpace: 'display_px', viewport: { width: 1000, height: 4000 },
      root: { class: 'FrameLayout', bounds: { left: 0, top: 0, right: 1000, bottom: 4000 }, children: [
        { class: 'TextView', text: '提交', clickable: false, bounds: { left: 850, top: 40, right: 950, bottom: 100 }, children: [] },
      ] },
    },
    dom: { status: 'complete', documents: [{ viewport: { width: 100, height: 400 }, nodes: [
      { tag: 'div', text: '提交时间：当日09:00-当日18:00', interactive: true, bounds: { left: 100, top: 2200, right: 900, bottom: 2260 } },
    ] }] },
  };
  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 4000 });
  assert.ok(result.elements[0].approximateRegion.y < 0.04);
  assert.ok(result.elements[0].riskSignals.includes('geometry-grounded-by-ui-tree'));
});

test('无文字图标按钮按 DOM 交互节点的实际边界定位', () => {
  const recognition = { elements: [element('add', '添加接收人', 'icon-button', { x: 0.21, y: 0.41, width: 0.11, height: 0.04 })] };
  const runtime = {
    hierarchy: {
      coordinateSpace: 'display_px', viewport: { width: 1000, height: 4000 },
      root: { class: 'FrameLayout', bounds: { left: 0, top: 0, right: 1000, bottom: 2000 }, children: [] },
    },
    dom: {
      status: 'complete',
      documents: [{
        viewport: { width: 100, height: 400 },
        nodes: [
          { tag: 'div', text: '接收人', interactive: false, bounds: { left: 96, top: 1500, right: 950, bottom: 1600 } },
          { tag: 'img', text: '', interactive: true, bounds: { left: 250, top: 1640, right: 372, bottom: 1760 } },
        ],
      }],
    },
  };
  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 4000 });
  const box = result.elements[0].approximateRegion;
  assert.ok(Math.abs(box.x - 0.25) < 1e-6);
  assert.ok(Math.abs(box.y - 0.41) < 1e-6);
  assert.ok(box.width < 0.15);
});

test('合并后的 full-page hierarchy 仍按整页截图处理', () => {
  const recognition = { elements: [element('title', '标题', 'title', { x: 0.1, y: 0.1, width: 0.2, height: 0.02 })] };
  const runtime = { hierarchy: {
    fullPage: true, origin: 'full_page', coordinateSpace: 'display_px', viewport: { width: 1000, height: 4000 },
    root: { class: 'FrameLayout', bounds: { left: 0, top: 0, right: 1000, bottom: 2000 }, children: [] },
  } };
  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 4000 });
  assert.equal(result.geometryRefinement.fullPageScreenshot, true);
});

test('UI Automation 输入框边界优先于视觉矩形', () => {
  const recognition = { elements: [element('input', '备注', 'text-area', { x: 0.1, y: 0.25, width: 0.8, height: 0.3 })] };
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 2000 }, root: {
      class: 'FrameLayout', bounds: { left: 0, top: 0, right: 1000, bottom: 2000 }, children: [
        { class: 'android.widget.EditText', text: '', bounds: { left: 120, top: 600, right: 880, bottom: 1100 }, children: [] },
      ],
    } },
  };
  const ocr = {
    status: 'complete', engine: 'apple-vision', width: 1000, height: 2000, observations: [],
    rectangles: [{ confidence: 1, rect: { x: 80, y: 500, width: 840, height: 600 } }],
  };
  const result = refineRecognitionGeometryWithSources(recognition, runtime, ocr, { width: 1000, height: 2000 });
  assert.deepEqual(roundedBox(result.elements[0].approximateRegion), { x: 0.12, y: 0.3, width: 0.76, height: 0.25 });
  assert.equal(result.geometryRefinement.rectangleMatchCount, 0);
  assert.ok(result.elements[0].riskSignals.includes('geometry-grounded-by-ui-tree'));
});

test('重复表单输入框去重后按实例空间匹配 UI Tree 和 DOM', () => {
  const recognition = { elements: [element('sections', '日报文本字段', 'section', { x: 0, y: 0.0453, width: 1, height: 0.2808 }, {
    abstraction: {
      kind: 'repeated-template', templateKey: 'daily-log', instanceCount: 3, bboxStyle: 'abstract',
      instanceRegions: [
        { x: 0, y: 0.0453, width: 1, height: 0.0941 },
        { x: 0, y: 0.139, width: 1, height: 0.0944 },
        { x: 0, y: 0.2329, width: 1, height: 0.0927 },
      ],
      fields: [{ key: 'input', label: '多行填写区域', elementType: 'text-area', instanceRegions: [
        { x: 0.112, y: 0.0657, width: 0.762, height: 0.0579 },
        { x: 0.112, y: 0.139, width: 0.762, height: 0.0619 },
        { x: 0.112, y: 0.2329, width: 0.762, height: 0.0615 },
      ] }],
    },
  })] };
  const inputBounds = [
    { left: 129, top: 603, right: 1008, bottom: 1149 },
    { left: 129, top: 1434, right: 1008, bottom: 1983 },
    { left: 129, top: 2268, right: 1008, bottom: 2814 },
  ];
  const runtime = {
    hierarchy: {
      coordinateSpace: 'display_px', viewport: { width: 1152, height: 8877 },
      root: { class: 'FrameLayout', children: inputBounds.map((bounds) => ({
        class: 'android.widget.EditText', text: '请填写', bounds, children: [],
      })) },
    },
    dom: {
      status: 'complete', documents: [{ displayViewport: { width: 1152, height: 8877 }, nodes: inputBounds.map((bounds) => ({
        tag: 'div', editable: true, interactive: true, text: '', bounds,
      })) }],
    },
  };
  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1152, height: 8877 });
  const input = result.elements[0].abstraction.fields[0];
  assert.deepEqual(input.instanceRegions.map(roundedBox), inputBounds.map((bounds) => ({
    x: Number((bounds.left / 1152).toFixed(6)),
    y: Number((bounds.top / 8877).toFixed(6)),
    width: Number(((bounds.right - bounds.left) / 1152).toFixed(6)),
    height: Number(((bounds.bottom - bounds.top) / 8877).toFixed(6)),
  })));
  assert.equal(result.geometryRefinement.runtimeInputMatchCount, 3);
  assert.equal(result.geometryRefinement.runtimeSupplementCount, 0);
});

test('运行时结构会补齐模型漏报的 DOM 文本节点，并优先使用当前文档', () => {
  const recognition = { elements: [] };
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 2000 }, root: null },
    dom: { status: 'complete', documents: [
      { url: 'https://current.test/#/page', displayViewport: { width: 1000, height: 2000 }, nodes: [
        { tag: 'button', role: 'button', text: '导入上篇', interactive: true, bounds: { left: 100, top: 300, right: 400, bottom: 380 } },
        { tag: 'div', role: '', text: '页面后半段仍可见', interactive: false, bounds: { left: 100, top: 1600, right: 500, bottom: 1680 } },
      ] },
      { url: 'https://host.test/#/', displayViewport: { width: 1000, height: 2000 }, nodes: [
        { tag: 'button', role: 'button', text: '无关页面按钮', interactive: true, bounds: { left: 100, top: 300, right: 400, bottom: 380 } },
      ] },
    ] },
  };
  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 2000 });
  assert.equal(result.geometryRefinement.runtimeSupplementCount, 2);
  assert.deepEqual(result.elements.map((item) => item.label), ['导入上篇', '页面后半段仍可见']);
  assert.equal(result.elements[0].approximateRegion.y, 0.15);
  assert.ok(result.elements[0].riskSignals.includes('runtime-element-supplemented'));
  assert.equal(result.actionCandidates[0].triggerCandidateKey, result.elements[0].candidateKey);
});

test('重复空交互包装含稳定子节点时恢复为通用列表项共相', () => {
  const tops = [100, 260, 420];
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 700 }, root: null },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1000, height: 700 }, nodes: tops.flatMap((top, index) => [
      { tag: 'div', text: '', interactive: true, bounds: { left: 100, top, right: 900, bottom: top + 120 } },
      { tag: 'div', text: `条目 ${index + 1}`, interactive: false, bounds: { left: 150, top: top + 15, right: 800, bottom: top + 35 } },
      { tag: 'div', text: `创建者：用户 ${index + 1}`, interactive: false, bounds: { left: 150, top: top + 50, right: 800, bottom: top + 70 } },
      { tag: 'div', text: `时间：${index + 9}:00`, interactive: false, bounds: { left: 150, top: top + 85, right: 800, bottom: top + 105 } },
      { tag: 'img', text: '', role: 'img', interactive: false, bounds: { left: 840, top: top + 12, right: 875, bottom: top + 47 } },
    ]) }] },
  };
  const result = refineRecognitionGeometryWithSources({ elements: [] }, runtime, null, { width: 1000, height: 700 });
  const item = result.elements.find((element) => element.abstraction?.kind === 'repeated-template');
  assert.ok(item);
  assert.equal(item.elementType, 'list-item');
  assert.equal(item.abstraction.instanceCount, 3);
  assert.equal(item.abstraction.instanceRegions.length, 3);
  assert.ok(item.abstraction.fields.some((field) => field.key === 'text_1'));
  assert.ok(item.abstraction.fields.every((field) => field.instanceRegions.length >= 2));
  assert.equal(result.elements.filter((element) => element.elementType === 'icon-button' && !element.label).length, 0);
  assert.equal(result.geometryRefinement.runtimeRepeatedGroupCount, 3);
  assert.ok(Math.abs(item.abstraction.instanceRegions[0].x - 0.1) < 1e-9);
  assert.ok(Math.abs(item.abstraction.instanceRegions[0].x + item.abstraction.instanceRegions[0].width - 0.9) < 1e-9);
});

test('没有稳定可见子节点的重复空控件仍按独立图标按钮补报', () => {
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: null },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1000, height: 1000 }, nodes: [
      { tag: 'button', text: '', role: 'button', interactive: true, bounds: { left: 100, top: 100, right: 150, bottom: 150 } },
      { tag: 'button', text: '', role: 'button', interactive: true, bounds: { left: 300, top: 100, right: 350, bottom: 150 } },
    ] }] },
  };
  const result = refineRecognitionGeometryWithSources({ elements: [] }, runtime, null, { width: 1000, height: 1000 });
  assert.equal(result.geometryRefinement.runtimeRepeatedGroupCount, 0);
  assert.equal(result.elements.filter((element) => element.elementType === 'icon-button').length, 2);
});

test('带可见标签的交互包装不会被拆成额外空图标按钮', () => {
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: null },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1000, height: 1000 }, nodes: [
      { tag: 'label', text: '', interactive: true, bounds: { left: 100, top: 300, right: 340, bottom: 330 } },
      { tag: 'span', text: '', interactive: true, bounds: { left: 100, top: 304, right: 140, bottom: 326 } },
      { tag: 'span', text: '显示通知', interactive: true, bounds: { left: 160, top: 304, right: 320, bottom: 326 } },
    ] }] },
  };
  const result = refineRecognitionGeometryWithSources({ elements: [] }, runtime, null, { width: 1000, height: 1000 });
  assert.equal(result.elements.filter((element) => element.elementType === 'icon-button' && !element.label).length, 0);
  assert.equal(result.geometryRefinement.runtimeSupplementCount, 1);
  assert.equal(result.elements.filter((element) => element.label === '显示通知').length, 1);
});

test('不会把可点击的 WebView 根容器误补成图标按钮', () => {
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 2000 }, root: {
      class: '', clickable: true, bounds: { left: 0, top: 0, right: 1000, bottom: 2000 }, children: [],
    } },
  };
  const result = refineRecognitionGeometryWithSources({ elements: [] }, runtime, null, { width: 1000, height: 2000 });
  assert.equal(result.geometryRefinement.runtimeSupplementCount, 0);
  assert.equal(result.elements.length, 0);
});

test('整页长截图使用整页高度归一化运行时和 DOM 坐标', () => {
  const recognition = { elements: [
    element('native-title', '日志', 'title', { x: 0.4, y: 0.05, width: 0.2, height: 0.04 }),
    element('form-title', '葛超烨的日报', 'title', { x: 0.08, y: 0.1, width: 0.4, height: 0.04 }),
  ] };
  const runtime = {
    hierarchy: {
      coordinateSpace: 'display_px', viewport: { width: 1152, height: 2376 },
      root: { class: 'FrameLayout', bounds: { left: 0, top: 0, right: 1152, bottom: 2376 }, children: [
        { class: 'TextView', text: '日志', bounds: { left: 528, top: 154, right: 624, bottom: 219 }, children: [] },
      ] },
    },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1152, height: 2376 }, nodes: [{
      tag: 'div', role: '', type: '', text: '葛超烨的日报', interactive: false,
      bounds: { left: 99, top: 309, right: 432, bottom: 372 },
    }] }] },
  };
  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1152, height: 9270 });
  assert.deepEqual(roundedBox(result.elements[0].approximateRegion), { x: 0.458333, y: 0.016613, width: 0.083333, height: 0.007012 });
  assert.deepEqual(roundedBox(result.elements[1].approximateRegion), { x: 0.085938, y: 0.033333, width: 0.289063, height: 0.006796 });
  assert.ok(result.elements.every((item) => item.riskSignals.includes('geometry-grounded-by-runtime') || item.riskSignals.includes('geometry-grounded-by-dom')));
});

test('整页长截图保留模型按实际图片输出的坐标和实例区域', () => {
  const recognition = {
    elements: [element('header', '标题', 'section', { x: 0, y: 0.1, width: 1, height: 0.1 }, {
      abstraction: { instanceRegions: [{ x: 0.1, y: 0.2, width: 0.8, height: 0.1 }], fields: [{ instanceRegions: [{ x: 0.2, y: 0.25, width: 0.2, height: 0.03 }] }] },
    })],
  };
  const result = refineRecognitionGeometryWithSources(recognition, { viewport: { width: 1152, height: 2376 } }, null, { width: 1152, height: 9270 });
  assert.deepEqual(roundedBox(result.elements[0].approximateRegion), { x: 0, y: 0.1, width: 1, height: 0.1 });
  assert.deepEqual(roundedBox(result.elements[0].abstraction.instanceRegions[0]), { x: 0.1, y: 0.2, width: 0.8, height: 0.1 });
  assert.deepEqual(roundedBox(result.elements[0].abstraction.fields[0].instanceRegions[0]), { x: 0.2, y: 0.25, width: 0.2, height: 0.03 });
});

test('整页截图不会把整图归一化的共相容器再次套用视口文字校准', () => {
  const recognition = {
    elements: [element('log_text_sections', '日志文本字段', 'section', { x: 0, y: 0.0434, width: 1, height: 0.268 }, {
      abstraction: {
        kind: 'repeated-template',
        instanceRegions: [
          { x: 0, y: 0.0434, width: 1, height: 0.09 },
          { x: 0, y: 0.133, width: 1, height: 0.09 },
          { x: 0, y: 0.223, width: 1, height: 0.089 },
        ],
        fields: [
          { key: 'label', label: '字段标题', elementType: 'static-label', instanceRegions: [
            { x: 0.097, y: 0.049, width: 0.287, height: 0.008 },
            { x: 0.097, y: 0.133, width: 0.287, height: 0.008 },
            { x: 0.097, y: 0.218, width: 0.125, height: 0.008 },
          ] },
          { key: 'input', label: '多行文本输入', elementType: 'text-area', instanceRegions: [
            { x: 0.112, y: 0.062, width: 0.783, height: 0.065 },
            { x: 0.112, y: 0.155, width: 0.783, height: 0.065 },
            { x: 0.112, y: 0.242, width: 0.783, height: 0.065 },
          ] },
        ],
      },
    })],
  };
  const runtime = {
    hierarchy: {
      coordinateSpace: 'display_px',
      viewport: { width: 1152, height: 2376 },
      root: { class: 'FrameLayout', bounds: { left: 0, top: 0, right: 1152, bottom: 2376 }, children: [
        { class: 'TextView', text: '1. 今日完成工作', bounds: { left: 111, top: 456, right: 441, bottom: 528 }, children: [] },
        { class: 'TextView', text: '2. 明日工作计划', bounds: { left: 111, top: 1290, right: 441, bottom: 1362 }, children: [] },
        { class: 'TextView', text: '3. 备注', bounds: { left: 111, top: 2121, right: 255, bottom: 2193 }, children: [] },
      ] },
    },
  };
  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1152, height: 9270 });
  const sections = result.elements[0];
  assert.equal(result.geometryRefinement.fullPageScreenshot, true);
  assert.equal(result.geometryRefinement.calibration.reliable, false);
  assert.equal(result.geometryRefinement.runtimeSupplementCount, 0);
  assert.deepEqual(roundedBox(sections.approximateRegion), { x: 0, y: 0.0434, width: 1, height: 0.268 });
  assert.deepEqual(roundedBox(sections.abstraction.instanceRegions[0]), { x: 0, y: 0.0434, width: 1, height: 0.09 });
  assert.deepEqual(roundedBox(sections.abstraction.instanceRegions[2]), { x: 0, y: 0.223, width: 1, height: 0.089 });
});

test('表单顶部单条分隔带不会导致后续共相实例向上偏移', () => {
  const recognition = {
    elements: [element('sections', '日志字段', 'section', { x: 0, y: 0.0434, width: 1, height: 0.268 }, {
      abstraction: {
        kind: 'repeated-template',
        instanceRegions: [
          { x: 0, y: 0.0434, width: 1, height: 0.09 },
          { x: 0, y: 0.133, width: 1, height: 0.09 },
          { x: 0, y: 0.223, width: 1, height: 0.089 },
        ],
        fields: [{ key: 'input', elementType: 'text-area', instanceRegions: [
          { x: 0.112, y: 0.062, width: 0.783, height: 0.065 },
          { x: 0.112, y: 0.155, width: 0.783, height: 0.065 },
          { x: 0.112, y: 0.242, width: 0.783, height: 0.065 },
        ] }],
      },
    })],
  };
  const ocr = {
    status: 'complete', engine: 'apple-vision', width: 1152, height: 9270,
    observations: [],
    rectangles: [
      { confidence: 1, rect: { x: 129, y: 603, width: 879, height: 546 } },
      { confidence: 1, rect: { x: 129, y: 1434, width: 879, height: 549 } },
      { confidence: 1, rect: { x: 90, y: 2231, width: 955, height: 626 } },
    ],
    separatorBands: [{ orientation: 'horizontal', confidence: 0.7, rect: { x: 0, y: 403, width: 1152, height: 24 } }],
  };
  const result = refineRecognitionGeometryWithSources(recognition, null, ocr, { width: 1152, height: 9270 });
  const sections = result.elements[0];
  assert.equal(result.geometryRefinement.separatorBandCount, 1);
  assert.equal(result.geometryRefinement.visualBlockMatchCount, 0);
  assert.deepEqual(sections.abstraction.instanceRegions.map(roundedBox), [
    { x: 0, y: 0.0434, width: 1, height: 0.09 },
    { x: 0, y: 0.133, width: 1, height: 0.09 },
    { x: 0, y: 0.223, width: 1, height: 0.089 },
  ]);
});

test('截图与 UI Tree 坐标系对齐时不对无文字控件套用全局文字校准', () => {
  const recognition = { elements: [
    element('label-a', 'A', 'static-label', { x: 0.1, y: 0.2, width: 0.2, height: 0.05 }),
    element('label-b', 'B', 'static-label', { x: 0.1, y: 0.7, width: 0.2, height: 0.05 }),
    element('back', null, 'icon-button', { x: 0.02, y: 0.05, width: 0.1, height: 0.05 }),
  ] };
  const runtime = { hierarchy: {
    coordinateSpace: 'display_px', viewport: { width: 100, height: 200 },
    root: { class: 'FrameLayout', bounds: { left: 0, top: 0, right: 100, bottom: 200 }, children: [
      { class: 'TextView', text: 'A', bounds: { left: 10, top: 20, right: 30, bottom: 30 }, children: [] },
      { class: 'TextView', text: 'B', bounds: { left: 10, top: 120, right: 30, bottom: 130 }, children: [] },
    ] },
  } };
  const before = recognition.elements[2].approximateRegion;
  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 100, height: 200 });
  assert.deepEqual(result.elements[2].approximateRegion, before);
  assert.ok(!result.elements[2].riskSignals.includes('geometry-calibrated-by-text-anchors'));
});

test('WebView 多行输入框使用包含占位文字的截图矩形边界', () => {
  const recognition = { elements: [
    element('work', '请填写', 'text-area', { x: 0.08, y: 0.25, width: 0.82, height: 0.35 }),
    element('plan', '请填写', 'text-area', { x: 0.08, y: 0.62, width: 0.82, height: 0.3 }),
  ] };
  const ocr = {
    status: 'complete', engine: 'apple-vision', width: 1000, height: 2000,
    observations: [
      { text: '请填写', confidence: 1, rect: { x: 120, y: 560, width: 120, height: 40 } },
      { text: '请填写', confidence: 1, rect: { x: 120, y: 1320, width: 120, height: 40 } },
    ],
    rectangles: [
      { confidence: 0.98, rect: { x: 80, y: 500, width: 840, height: 600 } },
      { confidence: 0.97, rect: { x: 80, y: 1260, width: 840, height: 600 } },
    ],
  };
  const result = refineRecognitionGeometryWithSources(recognition, null, ocr, { width: 1000, height: 2000 });
  assert.deepEqual(roundedBox(result.elements[0].approximateRegion), { x: 0.08, y: 0.25, width: 0.84, height: 0.3 });
  assert.deepEqual(roundedBox(result.elements[1].approximateRegion), { x: 0.08, y: 0.63, width: 0.84, height: 0.3 });
  assert.ok(result.elements.every((item) => item.riskSignals.includes('geometry-grounded-by-vision-rectangle')));
  assert.equal(result.geometryRefinement.rectangleMatchCount, 2);
});

test('共相中的输入字段只在候选匹配已观测内沿时校正为外沿', () => {
  const recognition = { elements: [element('sections', '日报填写段', 'list-item', { x: 0.05, y: 0.15, width: 0.9, height: 0.84 }, {
    abstraction: {
      instanceRegions: [
        { x: 0.05, y: 0.15, width: 0.9, height: 0.34 },
        { x: 0.05, y: 0.51, width: 0.9, height: 0.35 },
        { x: 0.05, y: 0.88, width: 0.9, height: 0.12 },
      ],
      fields: [{ key: 'textarea', elementType: 'text-area', instanceRegions: [
        { x: 0.05, y: 0.19, width: 0.9, height: 0.3 },
        { x: 0.05, y: 0.55, width: 0.9, height: 0.3 },
        { x: 0.05, y: 0.92, width: 0.9, height: 0.06 },
      ] }],
    },
  })] };
  const ocr = {
    status: 'complete', engine: 'apple-vision', width: 1000, height: 2000, observations: [],
    rectangles: [
      { confidence: 0.98, rect: { x: 80, y: 500, width: 840, height: 600 } },
      { confidence: 0.98, rect: { x: 100, y: 520, width: 800, height: 560 } },
      { confidence: 0.97, rect: { x: 100, y: 1280, width: 800, height: 560 } },
    ],
  };
  const result = refineRecognitionGeometryWithSources(recognition, null, ocr, { width: 1000, height: 2000 });
  assert.deepEqual(result.elements[0].abstraction.fields[0].instanceRegions.map(roundedBox), [
    { x: 0.08, y: 0.25, width: 0.84, height: 0.3 },
    { x: 0.08, y: 0.63, width: 0.84, height: 0.3 },
    { x: 0.05, y: 0.92, width: 0.9, height: 0.06 },
  ]);
  assert.ok(result.elements[0].riskSignals.includes('geometry-grounded-by-vision-rectangle'));
  assert.equal(result.geometryRefinement.rectangleMatchCount, 2);
});

test('共相输入框的视觉边界不会被全局文字校准二次变换', () => {
  const recognition = { elements: [element('sections', '日报填写段', 'list-item', { x: 0.05, y: 0.1, width: 0.9, height: 0.8 }, {
    meaning: meaning(['今日完成工作', '明日工作计划']),
    abstraction: {
      instanceRegions: [
        { x: 0.05, y: 0.1, width: 0.9, height: 0.35 },
        { x: 0.05, y: 0.5, width: 0.9, height: 0.35 },
      ],
      fields: [
        { key: 'title', elementType: 'static-label', instanceRegions: [
          { x: 0.1, y: 0.12, width: 0.3, height: 0.03 },
          { x: 0.1, y: 0.52, width: 0.3, height: 0.03 },
        ] },
        { key: 'textarea', elementType: 'text-area', instanceRegions: [
          { x: 0.08, y: 0.18, width: 0.84, height: 0.25 },
          { x: 0.08, y: 0.58, width: 0.84, height: 0.25 },
        ] },
      ],
    },
  })] };
  const ocr = {
    status: 'complete', engine: 'apple-vision', width: 1000, height: 2000,
    observations: [
      { text: '今日完成工作', confidence: 1, rect: { x: 100, y: 340, width: 300, height: 60 } },
      { text: '明日工作计划', confidence: 1, rect: { x: 100, y: 1140, width: 300, height: 60 } },
    ],
    rectangles: [
      { confidence: 0.98, rect: { x: 80, y: 440, width: 840, height: 500 } },
      { confidence: 0.97, rect: { x: 80, y: 1240, width: 840, height: 500 } },
    ],
  };

  const result = refineRecognitionGeometryWithSources(recognition, null, ocr, { width: 1000, height: 2000 });

  assert.equal(result.geometryRefinement.calibration.reliable, true);
  assert.deepEqual(result.elements[0].abstraction.fields[1].instanceRegions.map(roundedBox), [
    { x: 0.08, y: 0.22, width: 0.84, height: 0.25 },
    { x: 0.08, y: 0.62, width: 0.84, height: 0.25 },
  ]);
});

test('WebView 共相文字字段逐项吸附 OCR，避免长页面按首项等距漂移', () => {
  const recognition = { elements: [element('sections', '日报填写段', 'list-item', { x: 0.05, y: 0.15, width: 0.9, height: 0.84 }, {
    abstraction: {
      instanceRegions: [
        { x: 0.05, y: 0.15, width: 0.9, height: 0.34 },
        { x: 0.05, y: 0.51, width: 0.9, height: 0.35 },
        { x: 0.05, y: 0.88, width: 0.9, height: 0.12 },
      ],
      fields: [
        { key: 'title', label: '段标题', elementType: 'title', instanceRegions: [
          { x: 0.08, y: 0.16, width: 0.35, height: 0.02 },
          { x: 0.08, y: 0.55, width: 0.3, height: 0.02 },
          { x: 0.08, y: 0.93, width: 0.15, height: 0.02 },
        ] },
      ],
    },
  })] };
  const ocr = {
    status: 'complete', engine: 'apple-vision', width: 1000, height: 2400,
    observations: [
      { text: '* 1. 今日完成工作', confidence: 0.5, rect: { x: 65, y: 439, width: 346, height: 67 } },
      { text: '2. 明日工作计划', confidence: 0.5, rect: { x: 101, y: 1269, width: 314, height: 58 } },
      { text: '3.备注', confidence: 0.3, rect: { x: 101, y: 2093, width: 139, height: 49 } },
    ],
  };
  const result = refineRecognitionGeometryWithSources(recognition, null, ocr, { width: 1000, height: 2400 });
  const labels = result.elements[0].abstraction.fields[0].instanceRegions;
  assert.ok(Math.abs(labels[0].y - 0.183) < 0.01);
  assert.ok(Math.abs(labels[1].y - 0.529) < 0.01);
  assert.ok(Math.abs(labels[2].y - 0.872) < 0.01);
  assert.ok(result.elements[0].riskSignals.includes('geometry-grounded-by-ocr'));
});

test('重复卡片字段优先按 UI Tree 顺序匹配，避免 DOM 偏移造成末项错位', () => {
  const recognition = { elements: [element('related', '关联汇报条目', 'list-item', { x: 0.08, y: 0.1, width: 0.84, height: 0.75 }, {
    abstraction: {
      kind: 'dynamic-template', instanceCount: 3,
      instanceRegions: [
        { x: 0.08, y: 0.1, width: 0.84, height: 0.24 },
        { x: 0.08, y: 0.35, width: 0.84, height: 0.24 },
        { x: 0.08, y: 0.6, width: 0.84, height: 0.24 },
      ],
      fields: [
        { key: 'related_report_title', label: '汇报标题', elementType: 'text', instanceRegions: [
          { x: 0.12, y: 0.12, width: 0.7, height: 0.02 },
          { x: 0.12, y: 0.37, width: 0.7, height: 0.02 },
          { x: 0.12, y: 0.62, width: 0.7, height: 0.02 },
        ] },
        { key: 'creator', label: '创建人', elementType: 'text', instanceRegions: [
          { x: 0.12, y: 0.14, width: 0.7, height: 0.015 },
          { x: 0.12, y: 0.39, width: 0.7, height: 0.015 },
          { x: 0.12, y: 0.64, width: 0.7, height: 0.015 },
        ] },
        { key: 'submit_time', label: '提交时间', elementType: 'text', instanceRegions: [
          { x: 0.12, y: 0.16, width: 0.7, height: 0.015 },
          { x: 0.12, y: 0.41, width: 0.7, height: 0.015 },
          { x: 0.12, y: 0.66, width: 0.7, height: 0.015 },
        ] },
      ],
    },
  })] };
  const rows = [
    { title: '第一条汇报', creator: '创建人：甲', time: '提交时间：09:00-18:00' },
    { title: '第二条汇报', creator: '创建人：乙', time: '提交时间：09:00-18:00' },
    { title: '第三条汇报', creator: '创建人：丙', time: '提交时间：09:00-20:00' },
  ];
  const uiNodes = rows.flatMap((row, index) => {
    const top = 300 + index * 750;
    return [
      { class: 'TextView', text: row.title, bounds: { left: 120, top, right: 820, bottom: top + 60 }, children: [] },
      { class: 'TextView', text: row.creator, bounds: { left: 120, top: top + 70, right: 820, bottom: top + 115 }, children: [] },
      { class: 'TextView', text: row.time, bounds: { left: 120, top: top + 130, right: 820, bottom: top + 175 }, children: [] },
    ];
  });
  const domNodes = rows.flatMap((row, index) => {
    const top = 100 + index * 750;
    return [
      { tag: 'div', text: row.title, bounds: { left: 120, top, right: 820, bottom: top + 60 } },
      { tag: 'div', text: row.creator, bounds: { left: 120, top: top + 70, right: 820, bottom: top + 115 } },
      { tag: 'div', text: row.time, bounds: { left: 120, top: top + 130, right: 820, bottom: top + 175 } },
    ];
  });
  const runtime = {
    hierarchy: {
      coordinateSpace: 'display_px', viewport: { width: 1000, height: 3000 },
      root: { class: 'FrameLayout', bounds: { left: 0, top: 0, right: 1000, bottom: 3000 }, children: uiNodes },
    },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1000, height: 3000 }, nodes: domNodes }] },
  };
  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 3000 });
  const fields = Object.fromEntries(result.elements[0].abstraction.fields.map((field) => [field.key, field.instanceRegions]));
  assert.deepEqual(fields.related_report_title.map((box) => Math.round(box.y * 3000)), [300, 1050, 1800]);
  assert.deepEqual(fields.creator.map((box) => Math.round(box.y * 3000)), [370, 1120, 1870]);
  assert.deepEqual(fields.submit_time.map((box) => Math.round(box.y * 3000)), [430, 1180, 1930]);
});

test('重复模板实例优先使用运行时卡片边界并修正漂移的实例与字段', () => {
  const recognition = { elements: [element('cards', '规则卡片', 'list-item', { x: 0.08, y: 0.15, width: 0.84, height: 0.75 }, {
    interactive: true,
    abstraction: {
      kind: 'repeated-template', templateKey: 'rule-card', instanceCount: 3, bboxStyle: 'abstract',
      // The second and third x values model the common failure where a long
      // screenshot's y coordinate is accidentally written into x.
      instanceRegions: [
        { x: 0.08, y: 0.15, width: 0.84, height: 0.18 },
        { x: 0.5, y: 0.35, width: 0.84, height: 0.18 },
        { x: 0.7, y: 0.55, width: 0.84, height: 0.18 },
      ],
      fields: [
        { key: 'title', label: '规则名称', elementType: 'text', instanceRegions: [
          { x: 0.12, y: 0.17, width: 0.65, height: 0.03 },
          { x: 0.52, y: 0.37, width: 0.65, height: 0.03 },
          { x: 0.72, y: 0.57, width: 0.65, height: 0.03 },
        ] },
        { key: 'creator', label: '创建人', elementType: 'text', instanceRegions: [
          { x: 0.12, y: 0.21, width: 0.65, height: 0.025 },
          { x: 0.52, y: 0.41, width: 0.65, height: 0.025 },
          { x: 0.72, y: 0.61, width: 0.65, height: 0.025 },
        ] },
        { key: 'submit_time', label: '提交时间', elementType: 'text', instanceRegions: [
          { x: 0.12, y: 0.25, width: 0.65, height: 0.025 },
          { x: 0.52, y: 0.45, width: 0.65, height: 0.025 },
          { x: 0.72, y: 0.65, width: 0.65, height: 0.025 },
        ] },
      ],
    },
  })] };
  const cards = [300, 700, 1100];
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1600 }, root: { class: 'FrameLayout', children: cards.flatMap((top, index) => [
      { class: 'android.view.View', clickable: true, bounds: { left: 100, top, right: 900, bottom: top + 300 }, children: [] },
      { class: 'TextView', text: `规则 ${index + 1}`, bounds: { left: 140, top: top + 25, right: 820, bottom: top + 70 }, children: [] },
      { class: 'TextView', text: `创建人：用户 ${index + 1}`, bounds: { left: 140, top: top + 100, right: 820, bottom: top + 135 }, children: [] },
      { class: 'TextView', text: `提交时间：${index + 9}:00`, bounds: { left: 140, top: top + 160, right: 820, bottom: top + 200 }, children: [] },
    ]) } },
    dom: { status: 'unavailable', documents: [] },
  };
  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 1600 });
  const card = result.elements[0];
  assert.equal(result.geometryRefinement.repeatedRuntimeMatchCount, 3);
  assert.deepEqual(card.abstraction.instanceRegions.map(roundedBox), cards.map((top) => ({
    x: 0.1, y: Number((top / 1600).toFixed(6)), width: 0.8, height: 0.1875,
  })));
  const fields = Object.fromEntries(card.abstraction.fields.map((field) => [field.key, field]));
  assert.equal(Math.round(fields.submit_time.instanceRegions[2].y * 1600), 1260);
  assert.equal(Math.round(fields.submit_time.instanceRegions[2].x * 1000), 140);
});

test('重复项由运行时落地后列表容器同步收敛到实例并集', () => {
  const list = element('rule_list', '规则列表', 'list', { x: 0.02, y: 0.1, width: 0.96, height: 0.82 });
  const item = element('rule_items', '规则项', 'list-item', { x: 0.08, y: 0.15, width: 0.84, height: 0.75 }, {
    abstraction: {
      kind: 'repeated-template', templateKey: 'rule-item', instanceCount: 3, bboxStyle: 'abstract',
      instanceRegions: [
        { x: 0.08, y: 0.15, width: 0.84, height: 0.18 },
        { x: 0.08, y: 0.40, width: 0.84, height: 0.18 },
        { x: 0.08, y: 0.65, width: 0.84, height: 0.18 },
      ],
      fields: [],
    },
  });
  const recognition = {
    elements: [list, item],
    relationships: [{ fromCandidateKey: list.candidateKey, type: 'contains', toCandidateKey: item.candidateKey }],
  };
  const cardTops = [300, 700, 1100];
  const runtime = { hierarchy: {
    coordinateSpace: 'display_px', viewport: { width: 1000, height: 1600 },
    root: { class: 'FrameLayout', children: cardTops.map((top) => ({
      class: 'android.view.View', clickable: true,
      bounds: { left: 100, top, right: 900, bottom: top + 300 }, children: [],
    })) },
  } };

  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 1600 });
  const refinedList = result.elements.find((element) => element.candidateKey === list.candidateKey);
  const refinedItem = result.elements.find((element) => element.candidateKey === item.candidateKey);
  assert.deepEqual(roundedBox(refinedList.approximateRegion), roundedBox(refinedItem.approximateRegion));
  assert.deepEqual(roundedBox(refinedList.approximateRegion), {
    x: 0.1, y: 0.1875, width: 0.8, height: 0.6875,
  });
  assert.ok(refinedList.riskSignals.includes('geometry-grounded-by-repeated-runtime-container'));
  assert.equal(result.geometryRefinement.repeatedListContainerMatchCount, 1);
});

test('九个运行时卡片按同尺寸规则间距校准实例外框并隔离包装层噪声', () => {
  const cardTops = Array.from({ length: 9 }, (_, index) => 5046 + index * 393);
  const recognition = { elements: [element('items', '规则项', 'list-item', {
    x: 0.08, y: 0.56, width: 0.84, height: 0.4,
  }, {
    abstraction: {
      kind: 'repeated-template', templateKey: 'rule-items', instanceCount: 9,
      bboxStyle: 'abstract',
      instanceRegions: cardTops.map((top, index) => ({
        // Simulate model x drift after the first item.
        x: index === 0 ? 0.08 : Math.min(0.8, 0.12 + index * 0.04),
        y: top / 8877, width: 0.8, height: 0.04,
      })),
      fields: [{ key: 'title', label: '规则名称', elementType: 'text', instanceRegions: cardTops.map((top, index) => ({
        x: index === 0 ? 0.13 : Math.min(0.85, 0.17 + index * 0.03),
        y: (top + 40) / 8877, width: 0.68, height: 0.009,
      })) }],
    },
  })] };
  const cardNodes = cardTops.map((top) => ({
    tag: 'div', interactive: true, text: '',
    bounds: { left: 96, top, right: 1018, bottom: top + 369 },
  }));
  const noiseNodes = [
    // Full-page root and small avatar/checkbox wrappers must not be selected.
    { tag: 'div', interactive: true, text: '', bounds: { left: 0, top: 0, right: 1152, bottom: 8877 } },
    { tag: 'div', interactive: true, text: '', bounds: { left: 106, top: 3794, right: 202, bottom: 3890 } },
    { tag: 'label', interactive: true, text: '', bounds: { left: 96, top: 4750, right: 360, bottom: 4816 } },
  ];
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1152, height: 8877 }, root: null },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1152, height: 8877 }, nodes: [
      ...noiseNodes,
      ...cardNodes,
      ...cardTops.flatMap((top, index) => [
        { tag: 'div', text: `规则 ${index + 1}`, bounds: { left: 148, top: top + 40, right: 965, bottom: top + 75 } },
        { tag: 'div', text: `提交时间：${index + 9}:00`, bounds: { left: 148, top: top + 220, right: 965, bottom: top + 250 } },
      ]),
    ] }] },
  };
  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1152, height: 8877 });
  const item = result.elements[0];
  const expected = cardTops.map((top) => ({
    x: Number((96 / 1152).toFixed(6)), y: Number((top / 8877).toFixed(6)),
    width: Number((922 / 1152).toFixed(6)), height: Number((369 / 8877).toFixed(6)),
  }));
  assert.deepEqual(item.abstraction.instanceRegions.map(roundedBox), expected);
  assert.deepEqual(roundedBox(item.approximateRegion), roundedBox({
    x: expected[0].x, y: expected[0].y,
    width: expected[0].width,
    height: expected.at(-1).y + expected.at(-1).height - expected[0].y,
  }));
  assert.ok(item.abstraction.fields[0].instanceRegions.every((region, index) => (
    region.y >= expected[index].y && region.y + region.height <= expected[index].y + expected[index].height
  )));
  assert.equal(result.geometryRefinement.repeatedRuntimeMatchCount, 9);
});

test('实例横向尺寸离散时回退到模板外框并仍使用运行时卡片组', () => {
  const cardTops = Array.from({ length: 9 }, (_, index) => 5046 + index * 393);
  const recognition = { elements: [element('items', '规则项', 'list-item', {
    x: 0.083, y: 0.568, width: 0.8, height: 0.396,
  }, {
    abstraction: {
      kind: 'repeated-template', templateKey: 'rule-items', instanceCount: 9,
      instanceRegions: cardTops.map((top, index) => ({
        // Widths after the first row are malformed/serialized from another
        // coordinate. They must not become the expected runtime card width.
        x: index === 0 ? 0.083 : 0.128 + index * 0.04,
        y: top / 8877, width: Math.max(0.24, 0.8 - index * 0.07), height: 0.042,
      })),
      fields: [],
    },
  })] };
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1152, height: 8877 }, root: null },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1152, height: 8877 }, nodes: cardTops.map((top) => ({
      tag: 'div', interactive: true, text: '',
      bounds: { left: 96, top, right: 1018, bottom: top + 369 },
    })) }] },
  };
  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1152, height: 8877 });
  const item = result.elements[0];
  assert.equal(result.geometryRefinement.repeatedRuntimeMatchCount, 9);
  assert.ok(item.abstraction.instanceRegions.every((region) => Math.abs(region.x - 96 / 1152) < 1e-9));
  assert.ok(item.abstraction.instanceRegions.every((region) => Math.abs(region.width - 922 / 1152) < 1e-9));
});

test('混合 DOM 与 UI Tree 拼接片段时保留完整 DOM 卡片边界', () => {
  const cardTops = [300, 800, 1300];
  const recognition = { elements: [element('cards', '规则卡片', 'list-item', {
    x: 0.08, y: 0.1, width: 0.84, height: 0.8,
  }, {
    abstraction: {
      kind: 'repeated-template', templateKey: 'mixed-runtime-cards', instanceCount: 3,
      bboxStyle: 'abstract',
      instanceRegions: cardTops.map((top) => ({
        x: 0.12, y: top / 2000, width: 0.72, height: 0.15,
      })),
      fields: [],
    },
  })] };
  const runtime = {
    hierarchy: {
      coordinateSpace: 'display_px', viewport: { width: 1152, height: 2000 },
      root: { class: 'FrameLayout', children: cardTops.map((top) => ({
        // Accessibility snapshots can expose a slightly wider wrapper at a
        // scroll seam than the complete WebView DOM card.
        class: 'android.view.View', clickable: true,
        bounds: { left: 96, top, right: 1020, bottom: top + 300 }, children: [],
      })) },
    },
    dom: {
      status: 'complete', documents: [{ displayViewport: { width: 1152, height: 2000 }, nodes: cardTops.map((top) => ({
        tag: 'div', interactive: true, text: '',
        bounds: { left: 96, top, right: 1018, bottom: top + 300 },
      })) }],
    },
  };

  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, {
    width: 1152, height: 2000,
  });
  const item = result.elements[0];
  assert.equal(result.geometryRefinement.repeatedRuntimeMatchCount, 3);
  assert.ok(item.abstraction.instanceRegions.every((region) => (
    Math.abs(region.x - 96 / 1152) < 1e-9
      && Math.abs(region.x + region.width - 1018 / 1152) < 1e-9
  )));
});

test('带文案的普通文字控件通用吸附 OCR 边界', () => {
  const recognition = { elements: [
    element('secondary-action', '批量导入', 'text-button', { x: 0.65, y: 0.12, width: 0.22, height: 0.03 }),
  ] };
  const ocr = {
    status: 'complete', engine: 'apple-vision', width: 1000, height: 2000,
    observations: [
      { text: '图标 批量导入', confidence: 0.3, rect: { x: 720, y: 300, width: 230, height: 50 } },
    ],
  };
  const result = refineRecognitionGeometryWithSources(recognition, null, ocr, { width: 1000, height: 2000 });
  assert.deepEqual(roundedBox(result.elements[0].approximateRegion), { x: 0.7, y: 0.14, width: 0.27, height: 0.045 });
  assert.ok(result.elements[0].riskSignals.includes('geometry-grounded-by-ocr'));
  assert.ok(result.elements[0].riskSignals.includes('geometry-tap-target-expanded-from-ocr'));
});

test('OCR 合并相邻图标时文字按钮命中框截止到右侧独立控件左边界', () => {
  const recognition = { elements: [
    element('submit', '提交', 'text-button', { x: 0.769, y: 0.054, width: 0.123, height: 0.042 }),
    element('close', '关闭', 'icon-button', { x: 0.892, y: 0.054, width: 0.094, height: 0.042 }),
  ] };
  const ocr = {
    status: 'complete', engine: 'apple-vision', width: 1080, height: 2400,
    observations: [{
      text: '提交X', confidence: 0.9,
      rect: { x: 846.15, y: 151.99, width: 192.47, height: 58.81 },
    }],
  };

  const result = refineRecognitionGeometryWithSources(recognition, null, ocr, { width: 1080, height: 2400 });
  const submit = result.elements[0].approximateRegion;
  const close = result.elements[1].approximateRegion;
  assert.ok(Math.abs(submit.x + submit.width - close.x) < 1e-9);
  assert.deepEqual(close, recognition.elements[1].approximateRegion);
  assert.ok(result.elements[0].riskSignals.includes('geometry-tap-target-expanded-from-ocr'));
});

test('顶层输入框只使用包含自身文字或足够接近的独占矩形', () => {
  const recognition = { elements: [
    element('field-2-input', '明日工作计划', 'text-area', { x: 0.08, y: 0.55, width: 0.84, height: 0.25 }),
    element('field-3-input', '备注', 'text-area', { x: 0.08, y: 0.9, width: 0.84, height: 0.1 }),
  ] };
  const ocr = {
    status: 'complete', engine: 'apple-vision', width: 1000, height: 2000,
    observations: [
      { text: '2. 明日工作计划', confidence: 0.9, rect: { x: 90, y: 1030, width: 250, height: 40 } },
      { text: '3. 备注', confidence: 0.9, rect: { x: 90, y: 1740, width: 140, height: 40 } },
    ],
    rectangles: [{ confidence: 0.98, rect: { x: 80, y: 1120, width: 840, height: 500 } }],
  };
  const result = refineRecognitionGeometryWithSources(recognition, null, ocr, { width: 1000, height: 2000 });
  assert.deepEqual(result.elements[0].approximateRegion, { x: 0.08, y: 0.56, width: 0.84, height: 0.25 });
  assert.deepEqual(result.elements[1].approximateRegion, recognition.elements[1].approximateRegion);
  assert.ok(!result.elements[1].riskSignals.includes('geometry-grounded-by-vision-rectangle'));
  assert.equal(result.geometryRefinement.rectangleMatchCount, 1);
});

test('重复表单共相保留必填标记、序号、字段标签、可见占位语和输入框', () => {
  const recognition = { elements: [element('field-blocks', '表单字段块', 'section', { x: 0, y: 0.1, width: 1, height: 0.9 }, {
    abstraction: {
      kind: 'repeated-template', instanceCount: 3, templateKey: 'form-field', bboxStyle: 'abstract',
      instanceRegions: [
        { x: 0, y: 0.1, width: 1, height: 0.28 },
        { x: 0, y: 0.4, width: 1, height: 0.28 },
        { x: 0, y: 0.7, width: 1, height: 0.3 },
      ],
      fields: [
        { key: 'label', label: '字段标题', elementType: 'static-label', instanceRegions: [
          { x: 0.08, y: 0.12, width: 0.3, height: 0.03 },
          { x: 0.08, y: 0.42, width: 0.3, height: 0.03 },
          { x: 0.08, y: 0.72, width: 0.2, height: 0.03 },
        ] },
        { key: 'input', label: '多行文本输入', elementType: 'text-area', instanceRegions: [
          { x: 0.08, y: 0.17, width: 0.84, height: 0.18 },
          { x: 0.08, y: 0.47, width: 0.84, height: 0.18 },
          { x: 0.08, y: 0.77, width: 0.84, height: 0.2 },
        ] },
      ],
    },
  })] };
  const ocr = {
    status: 'complete', engine: 'apple-vision', width: 1000, height: 2000, rectangles: [],
    observations: [
      { text: '*1. 今日完成工作', confidence: 0.9, rect: { x: 70, y: 240, width: 320, height: 50 } },
      { text: '请填写', confidence: 1, rect: { x: 110, y: 370, width: 110, height: 35 } },
      { text: '2. 明日工作计划', confidence: 0.9, rect: { x: 90, y: 840, width: 300, height: 50 } },
      { text: '请填写', confidence: 1, rect: { x: 110, y: 970, width: 110, height: 35 } },
      { text: '3. 备注', confidence: 0.9, rect: { x: 90, y: 1440, width: 150, height: 50 } },
    ],
  };
  const result = refineRecognitionGeometryWithSources(recognition, null, ocr, { width: 1000, height: 2000 });
  const fields = result.elements[0].abstraction.fields;
  assert.deepEqual(fields.map((field) => field.key), ['required-marker', 'ordinal', 'field-label', 'placeholder', 'input']);
  assert.equal(fields.find((field) => field.key === 'required-marker').instanceRegions.length, 1);
  assert.equal(fields.find((field) => field.key === 'ordinal').instanceRegions.length, 3);
  assert.equal(fields.find((field) => field.key === 'field-label').instanceRegions.length, 3);
  assert.equal(fields.find((field) => field.key === 'placeholder').instanceRegions.length, 2);
  assert.equal(fields.find((field) => field.key === 'input').instanceRegions.length, 3);
  assert.ok(result.elements[0].riskSignals.includes('structural-fields-grounded-by-ocr'));
});

test('重复模板缺少输入字段时从顶层输入候选按实例归属回填，并隔离结构字段吸附', () => {
  const recognition = { elements: [
    element('field-blocks', '日报字段块', 'section', { x: 0.06, y: 0.16, width: 0.88, height: 0.79 }, {
      abstraction: {
        kind: 'repeated-template', templateKey: 'form-field', instanceCount: 3, bboxStyle: 'abstract',
        instanceRegions: [
          { x: 0.06, y: 0.16, width: 0.88, height: 0.25 },
          { x: 0.06, y: 0.43, width: 0.88, height: 0.25 },
          { x: 0.06, y: 0.70, width: 0.88, height: 0.25 },
        ],
        fields: [{ key: 'title', label: '段标题', elementType: 'title', instanceRegions: [
          { x: 0.08, y: 0.17, width: 0.3, height: 0.02 },
          { x: 0.08, y: 0.44, width: 0.3, height: 0.02 },
          { x: 0.08, y: 0.71, width: 0.2, height: 0.02 },
        ] }],
      },
    }),
    element('section1-input', '今日完成工作', 'text-area', { x: 0.07, y: 0.20, width: 0.86, height: 0.20 }),
    element('section2-input', '明日工作计划', 'text-area', { x: 0.07, y: 0.47, width: 0.86, height: 0.20 }),
    element('section3-input', '备注', 'text-area', { x: 0.07, y: 0.74, width: 0.86, height: 0.20 }),
  ] };
  const ocr = {
    status: 'complete', engine: 'apple-vision', width: 1000, height: 2000, rectangles: [],
    observations: [
      { text: '*1.今日完成工作', confidence: 0.95, rect: { x: 80, y: 350, width: 300, height: 42 } },
      { text: '请填写', confidence: 0.95, rect: { x: 100, y: 450, width: 100, height: 32 } },
      { text: '2. 明日工作计划', confidence: 0.95, rect: { x: 80, y: 890, width: 290, height: 42 } },
      { text: '请填写', confidence: 0.95, rect: { x: 100, y: 990, width: 100, height: 32 } },
      { text: '3.备注', confidence: 0.95, rect: { x: 80, y: 1430, width: 130, height: 42 } },
    ],
  };

  const result = refineRecognitionGeometryWithSources(recognition, null, ocr, { width: 1000, height: 2000 });
  const fields = result.elements[0].abstraction.fields;
  assert.deepEqual(fields.map((field) => field.key), ['required-marker', 'ordinal', 'field-label', 'placeholder', 'input']);
  assert.deepEqual(fields.find((field) => field.key === 'input').instanceRegions.map(roundedBox), [
    { x: 0.07, y: 0.20, width: 0.86, height: 0.20 },
    { x: 0.07, y: 0.47, width: 0.86, height: 0.20 },
    { x: 0.07, y: 0.74, width: 0.86, height: 0.20 },
  ]);
  assert.equal(fields.find((field) => field.key === 'required-marker').instanceRegions.length, 1);
  assert.equal(fields.find((field) => field.key === 'ordinal').instanceRegions.length, 3);
  assert.equal(fields.find((field) => field.key === 'field-label').instanceRegions.length, 3);
  assert.equal(fields.find((field) => field.key === 'placeholder').instanceRegions.length, 2);
  const titleRegion = fields.find((field) => field.key === 'field-label').instanceRegions[0];
  const ordinalRegion = fields.find((field) => field.key === 'ordinal').instanceRegions[0];
  assert.ok(titleRegion.x >= ordinalRegion.x + ordinalRegion.width - 1e-6);
  assert.ok(titleRegion.width < 0.25);
});

test('纵向分隔边界重建横向排列的重复表单块', () => {
  const recognition = { elements: [element('horizontal-fields', '横向字段块', 'section', { x: 0.05, y: 0.2, width: 0.9, height: 0.7 }, {
    abstraction: {
      kind: 'repeated-template', instanceCount: 3, templateKey: 'horizontal-field', bboxStyle: 'abstract',
      instanceRegions: [
        { x: 0.05, y: 0.2, width: 0.27, height: 0.7 },
        { x: 0.34, y: 0.2, width: 0.3, height: 0.7 },
        { x: 0.66, y: 0.2, width: 0.29, height: 0.7 },
      ],
      fields: [
        { key: 'title', elementType: 'static-label', instanceRegions: [
          { x: 0.08, y: 0.24, width: 0.15, height: 0.04 },
          { x: 0.38, y: 0.24, width: 0.15, height: 0.04 },
          { x: 0.7, y: 0.24, width: 0.15, height: 0.04 },
        ] },
        { key: 'input', elementType: 'text-area', instanceRegions: [
          { x: 0.08, y: 0.32, width: 0.2, height: 0.5 },
          { x: 0.38, y: 0.32, width: 0.2, height: 0.5 },
          { x: 0.7, y: 0.32, width: 0.2, height: 0.5 },
        ] },
      ],
    },
  })] };
  const ocr = {
    status: 'complete', engine: 'test', width: 1000, height: 1000, observations: [], rectangles: [],
    separatorBands: [
      { orientation: 'vertical', confidence: 0.9, rect: { x: 320, y: 200, width: 20, height: 700 } },
      { orientation: 'vertical', confidence: 0.9, rect: { x: 640, y: 200, width: 20, height: 700 } },
    ],
  };
  const result = refineRecognitionGeometryWithSources(recognition, null, ocr, { width: 1000, height: 1000 });
  assert.deepEqual(result.elements[0].abstraction.instanceRegions.map(roundedBox), [
    { x: 0.05, y: 0.2, width: 0.28, height: 0.7 },
    { x: 0.33, y: 0.2, width: 0.32, height: 0.7 },
    { x: 0.65, y: 0.2, width: 0.3, height: 0.7 },
  ]);
  assert.ok(result.elements[0].riskSignals.includes('geometry-grounded-by-visual-separation'));
  assert.equal(result.geometryRefinement.separatorBandCount, 2);
});

test('分隔边界重建重复表单块，底部实例只保留可见区域', () => {
  const recognition = { elements: [element('field-blocks', '表单字段块', 'section', { x: 0, y: 0.14, width: 1, height: 0.86 }, {
    abstraction: {
      kind: 'repeated-template',
      instanceRegions: [
        { x: 0.05, y: 0.15, width: 0.9, height: 0.34 },
        { x: 0.05, y: 0.51, width: 0.9, height: 0.34 },
        { x: 0.05, y: 0.87, width: 0.9, height: 0.13 },
      ],
      fields: [
        { key: 'title', elementType: 'static-label', instanceRegions: [
          { x: 0.09, y: 0.18, width: 0.3, height: 0.03 },
          { x: 0.09, y: 0.53, width: 0.3, height: 0.03 },
          { x: 0.09, y: 0.88, width: 0.2, height: 0.03 },
        ] },
        { key: 'input', elementType: 'text-area', instanceRegions: [
          { x: 0.08, y: 0.22, width: 0.84, height: 0.25 },
          { x: 0.08, y: 0.57, width: 0.84, height: 0.25 },
          { x: 0.08, y: 0.92, width: 0.84, height: 0.08 },
        ] },
      ],
    },
  })] };
  const ocr = {
    status: 'complete', engine: 'apple-vision', width: 1000, height: 2000, observations: [], rectangles: [],
    horizontalBands: [
      { confidence: 0.9, rect: { x: 0, y: 320, width: 1000, height: 20 } },
      { confidence: 0.9, rect: { x: 0, y: 1020, width: 1000, height: 20 } },
      { confidence: 0.9, rect: { x: 0, y: 1700, width: 1000, height: 20 } },
    ],
  };
  const result = refineRecognitionGeometryWithSources(recognition, null, ocr, { width: 1000, height: 2000 });
  assert.deepEqual(result.elements[0].abstraction.instanceRegions.map(roundedBox), [
    { x: 0, y: 0.17, width: 1, height: 0.34 },
    { x: 0, y: 0.52, width: 1, height: 0.33 },
    { x: 0, y: 0.86, width: 1, height: 0.14 },
  ]);
  assert.ok(result.elements[0].riskSignals.includes('geometry-grounded-by-visual-separator'));
  assert.ok(result.elements[0].riskSignals.includes('last-repeated-block-partially-visible'));
  assert.equal(result.geometryRefinement.separatorBandCount, 3);
  assert.equal(result.geometryRefinement.visualBlockMatchCount, 3);
});

test('运行时结构恢复日报必填标记、占位语并修正字段标签左边界', () => {
  const recognition = { elements: [element('daily-fields', '日报文本字段', 'section', { x: 0, y: 0.04, width: 1, height: 0.3 }, {
    abstraction: {
      kind: 'repeated-template', instanceCount: 3, templateKey: 'daily-field',
      instanceRegions: [
        { x: 0, y: 0.04, width: 1, height: 0.1 },
        { x: 0, y: 0.14, width: 1, height: 0.1 },
        { x: 0, y: 0.24, width: 1, height: 0.1 },
      ],
      fields: [
        { key: 'sequence', elementType: 'text', instanceRegions: [
          { x: 0.1, y: 0.05, width: 0.05, height: 0.01 },
          { x: 0.1, y: 0.15, width: 0.05, height: 0.01 },
          { x: 0.1, y: 0.25, width: 0.05, height: 0.01 },
        ] },
        { key: 'required_marker', elementType: 'text', required: true, instanceRegions: [{ x: 0.07, y: 0.05, width: 0.02, height: 0.01 }] },
        { key: 'field_label', elementType: 'static-label', instanceRegions: [
          { x: 0.15, y: 0.05, width: 0.3, height: 0.01 },
          { x: 0.15, y: 0.15, width: 0.3, height: 0.01 },
          { x: 0.15, y: 0.25, width: 0.1, height: 0.01 },
        ] },
        { key: 'placeholder', elementType: 'caption', instanceRegions: [{ x: 0.13, y: 0.07, width: 0.08, height: 0.006 }] },
        { key: 'text_input', elementType: 'text-area', instanceRegions: [
          { x: 0.11, y: 0.07, width: 0.77, height: 0.06 },
          { x: 0.11, y: 0.17, width: 0.77, height: 0.06 },
          { x: 0.11, y: 0.27, width: 0.77, height: 0.06 },
        ] },
      ],
    },
  })] };
  const inputBounds = [
    { left: 110, top: 700, right: 890, bottom: 1300 },
    { left: 110, top: 1700, right: 890, bottom: 2300 },
    { left: 110, top: 2700, right: 890, bottom: 3300 },
  ];
  const runtime = { hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 10000 }, root: {
    class: 'FrameLayout', children: [
      { class: 'TextView', text: '*', bounds: { left: 70, top: 500, right: 90, bottom: 560 }, children: [] },
      { class: 'TextView', text: '1. 今日完成工作', bounds: { left: 100, top: 500, right: 400, bottom: 570 }, children: [] },
      { class: 'TextView', text: '2. 明日工作计划', bounds: { left: 100, top: 1500, right: 400, bottom: 1570 }, children: [] },
      { class: 'TextView', text: '3. 备注', bounds: { left: 100, top: 2500, right: 240, bottom: 2570 }, children: [] },
      ...inputBounds.map((bounds) => ({ class: 'android.widget.EditText', text: '请填写\n', bounds, children: [] })),
    ],
  } } };
  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 10000 });
  const fields = Object.fromEntries(result.elements[0].abstraction.fields.map((field) => [field.key, field]));
  assert.equal(fields['required-marker'].instanceRegions.length, 1);
  assert.equal(fields.placeholder.instanceRegions.length, 3);
  assert.ok(Math.abs(fields.placeholder.instanceRegions[0].x - 0.12716) < 1e-6);
  assert.ok(Math.abs(fields.placeholder.instanceRegions[0].y - 0.0718) < 1e-6);
  const firstLabel = fields['field-label'].instanceRegions[0];
  const firstOrdinal = fields.ordinal.instanceRegions[0];
  assert.ok(firstLabel.x >= firstOrdinal.x + firstOrdinal.width - 1e-6);
  assert.ok(result.elements[0].approximateRegion.height < 0.3);
});

test('DOM/UI Tree 可见下沿会修正只覆盖首个字段的表单边框', () => {
  const recognition = {
    elements: [element('daily_log_form', '日报填写表单', 'form', { x: 0, y: 0.1, width: 1, height: 0.08 })],
    relationships: [],
  };
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: null },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1000, height: 1000 }, nodes: [
      { tag: 'div', text: '1. 今日完成工作', bounds: { left: 100, top: 100, right: 450, bottom: 130 } },
      { tag: 'div', editable: true, interactive: true, bounds: { left: 120, top: 180, right: 880, bottom: 420 } },
      { tag: 'div', text: '关联汇报', bounds: { left: 80, top: 800, right: 920, bottom: 830 } },
      { tag: 'div', text: '规则卡片', interactive: true, bounds: { left: 80, top: 840, right: 880, bottom: 900 } },
    ] }] },
  };
  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 1000 });
  const form = result.elements[0];
  assert.ok(form.approximateRegion.y + form.approximateRegion.height >= 0.899);
  assert.equal(result.geometryRefinement.formContainerMatchCount, 1);
  assert.ok(form.riskSignals.includes('geometry-grounded-by-semantic-form'));
});

test('精修补齐页面区域层级并过滤空运行时容器', () => {
  const recognition = { elements: [
    element('attachment_section', '图片和附件', 'section', { x: 0, y: 0.3, width: 1, height: 0.1 }),
    element('file_upload_button', '选择文件(不超过400M)', 'text-button', { x: 0.1, y: 0.34, width: 0.5, height: 0.05 }),
    element('recipient_section', '接收人', 'section', { x: 0.08, y: 0.45, width: 0.84, height: 0.06 }),
    element('remove_recipient_button', '移除接收人', 'icon-button', { x: 0.15, y: 0.48, width: 0.05, height: 0.02 }),
    element('add_recipient_button', '添加接收人', 'icon-button', { x: 0.22, y: 0.48, width: 0.1, height: 0.03 }),
    element('recipient_group_section', '接收群', 'section', { x: 0.08, y: 0.53, width: 0.84, height: 0.06 }),
    element('remove_group_button', '移除接收群', 'icon-button', { x: 0.15, y: 0.56, width: 0.05, height: 0.02 }),
    element('add_group_button', '添加接收群', 'icon-button', { x: 0.22, y: 0.56, width: 0.1, height: 0.03 }),
    element('more_options_section', '更多', 'section', { x: 0.08, y: 0.61, width: 0.84, height: 0.05 }),
    element('allow_forward_checkbox', '允许转发', 'checkbox', { x: 0.08, y: 0.64, width: 0.25, height: 0.02 }),
    element('related_reports_title', '关联汇报', 'title', { x: 0.08, y: 0.68, width: 0.84, height: 0.03 }),
    element('related_report_items', '关联汇报项', 'list-item', { x: 0.08, y: 0.71, width: 0.84, height: 0.25 }, {
      abstraction: { kind: 'repeated-template', instanceCount: 2, instanceRegions: [{ x: 0.08, y: 0.71, width: 0.84, height: 0.12 }, { x: 0.08, y: 0.84, width: 0.84, height: 0.12 }], fields: [] },
    }),
  ] };
  const runtime = { hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: {
    class: 'FrameLayout', bounds: { left: 0, top: 0, right: 1000, bottom: 1000 }, children: [
      { class: 'android.widget.FrameLayout', resourceId: 'surface', bounds: { left: 0, top: 0, right: 1000, bottom: 900 }, children: [] },
      { class: 'TextView', text: '葛超烨', clickable: true, bounds: { left: 100, top: 490, right: 210, bottom: 530 }, children: [] },
      { class: 'TextView', text: 'Onl...', clickable: true, bounds: { left: 110, top: 570, right: 200, bottom: 610 }, children: [] },
    ],
  } } };
  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 1000 });
  const relation = (from, to) => result.relationships.some((item) => item.fromCandidateKey === from && item.toCandidateKey === to && item.type === 'contains');
  assert.ok(relation('attachment_section', 'file_upload_button'));
  assert.ok(result.relationships.some((item) => item.fromCandidateKey === 'recipient_section'
    && item.type === 'contains'
    && result.elements.some((element) => element.candidateKey === item.toCandidateKey)));
  assert.ok(relation('recipient_section', 'add_recipient_button'));
  assert.ok(result.relationships.some((item) => item.fromCandidateKey === 'recipient_group_section'
    && item.type === 'contains'
    && result.elements.some((element) => element.candidateKey === item.toCandidateKey)));
  assert.ok(relation('more_options_section', 'allow_forward_checkbox'));
  assert.ok(result.elements.some((item) => item.candidateKey === 'related_report_items'
    && item.abstraction?.kind === 'repeated-template'));
  assert.equal(result.elements.find((item) => item.candidateKey === 'related_reports_title').elementType, 'title');
  assert.equal(result.elements.some((item) => item.label === 'root'), false);
});

test('几何精修移除外层容器到深层子元素的传递性 contains', () => {
  const recognition = {
    elements: [
      element('outer_form', '日志填写表单', 'form', { x: 0, y: 0.1, width: 1, height: 0.8 }),
      element('recipient_section', '接收人', 'section', { x: 0.08, y: 0.3, width: 0.84, height: 0.2 }),
      element('recipient_button', '添加接收人', 'text-button', { x: 0.2, y: 0.4, width: 0.15, height: 0.04 }),
    ],
    relationships: [
      { fromCandidateKey: 'outer_form', type: 'contains', toCandidateKey: 'recipient_section' },
      { fromCandidateKey: 'outer_form', type: 'contains', toCandidateKey: 'recipient_button' },
      { fromCandidateKey: 'recipient_section', type: 'contains', toCandidateKey: 'recipient_button' },
    ],
  };
  const result = refineRecognitionGeometryWithSources(recognition, null, null, { width: 1000, height: 1000 });
  assert.equal(result.relationships.some((relation) => relation.fromCandidateKey === 'outer_form'
    && relation.toCandidateKey === 'recipient_button' && relation.type === 'contains'), false);
  assert.equal(result.relationships.some((relation) => relation.fromCandidateKey === 'recipient_section'
    && relation.toCandidateKey === 'recipient_button' && relation.type === 'contains'), true);
});

test('接收人容器内的动态对象与添加移除按钮分别补齐', () => {
  const recognition = { elements: [
    element('recipient_section', '接收人', 'section', { x: 0.08, y: 0.2, width: 0.84, height: 0.12 }),
  ] };
  const runtime = { hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: {
    class: 'FrameLayout', bounds: { left: 0, top: 0, right: 1000, bottom: 1000 }, children: [
      { class: 'TextView', text: '葛超烨', clickable: true, bounds: { left: 100, top: 240, right: 220, bottom: 280 }, children: [] },
      { class: 'TextView', text: '移除接收人', clickable: true, bounds: { left: 240, top: 240, right: 340, bottom: 280 }, children: [] },
      { class: 'TextView', text: '添加接收人', clickable: true, bounds: { left: 360, top: 240, right: 480, bottom: 280 }, children: [] },
    ],
  } } };
  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 1000 });
  const labels = result.elements.map((item) => item.label);
  assert.ok(labels.includes('葛超烨'));
  assert.ok(labels.includes('移除接收人'));
  assert.ok(labels.includes('添加接收人'));
  assert.equal(result.elements.filter((item) => item.label === '葛超烨').length, 1);
  assert.ok(result.elements.some((item) => item.label === '移除接收人' && item.elementType === 'text-button'));
  assert.ok(result.elements.some((item) => item.label === '添加接收人' && item.elementType === 'text-button'));
  const relation = (to) => result.relationships.some((item) => item.fromCandidateKey === 'recipient_section'
    && item.toCandidateKey === to && item.type === 'contains');
  assert.ok(relation(result.elements.find((item) => item.label === '葛超烨').candidateKey));
  assert.ok(relation(result.elements.find((item) => item.label === '移除接收人').candidateKey));
  assert.ok(relation(result.elements.find((item) => item.label === '添加接收人').candidateKey));
});

test('新候选键结果会校准 section、拆分接收人共相并清理跨区域关系', () => {
  const dynamicContainer = (key, label, templateKey, fieldKey, fieldLabel, fieldType, region) => element(key, label, 'section', region, {
    abstraction: {
      kind: 'dynamic-template', templateKey, instanceCount: 1, bboxStyle: 'abstract',
      instanceRegions: [region],
      fields: [{ key: fieldKey, label: fieldLabel, elementType: fieldType, description: '当前已添加对象',
        displayCondition: '存在已添加对象时显示', capabilities: ['none'], interactionBoundary: 'none',
        actionEffects: [{ action: 'none', effect: '仅展示当前对象' }], parentId: key, required: false,
        instanceRegions: [{ x: region.x + 0.009, y: region.y, width: 0.1, height: 0.018 }] }],
    },
  });
  const recognition = {
    elements: [
      element('attachments_section', '图片和附件', 'section', { x: 0, y: 0.31, width: 1, height: 0.13 }),
      element('choose_file', '选择文件', 'text-button', { x: 0.3, y: 0.37, width: 0.13, height: 0.02 }),
      dynamicContainer('recipient_section', '接收人', 'recipient_person_template', 'recipient_person', '葛超烨', 'avatar', { x: 0.092, y: 0.426, width: 0.113, height: 0.024 }),
      element('remove_recipient', '移除接收人', 'icon-button', { x: 0.216, y: 0.427, width: 0.107, height: 0.014 }),
      element('add_recipient', '添加接收人', 'icon-button', { x: 0.216, y: 0.427, width: 0.109, height: 0.014 }),
      element('send_by_private_chat', '通过单聊发送给对方', 'checkbox', { x: 0.083, y: 0.455, width: 0.414, height: 0.008 }),
      dynamicContainer('group_section', '接收群', 'recipient_group_template', 'recipient_group', 'Onl...', 'avatar-group', { x: 0.092, y: 0.487, width: 0.113, height: 0.024 }),
      element('remove_group', '移除接收群', 'icon-button', { x: 0.216, y: 0.488, width: 0.107, height: 0.014 }),
      element('add_group', '添加接收群', 'icon-button', { x: 0.216, y: 0.488, width: 0.109, height: 0.014 }),
      element('more_section', '更多', 'section', { x: 0.083, y: 0.554, width: 0.833, height: 0.021 }),
      element('allow_forward', '允许转发', 'checkbox', { x: 0.083, y: 0.536, width: 0.24, height: 0.008 }),
      element('related_report_item_template', '关联汇报规则', 'list-item', { x: 0.083, y: 0.569, width: 0.8, height: 0.397 }, {
        abstraction: { kind: 'repeated-template', templateKey: 'related_report_item_template', instanceCount: 1,
          fields: [], instanceRegions: [{ x: 0.083, y: 0.569, width: 0.8, height: 0.397 }], bboxStyle: 'abstract' },
      }),
      element('related_report_section', '关联汇报', 'section', { x: 0.083, y: 0.555, width: 0.833, height: 0.411 }),
    ],
    comparison: { basisFrameId: null, status: 'not-requested' },
    relationships: [
      { fromCandidateKey: 'attachments_section', type: 'contains', toCandidateKey: 'remove_recipient' },
      { fromCandidateKey: 'recipient_section', type: 'contains', toCandidateKey: 'recipient_person_template' },
      { fromCandidateKey: 'group_section', type: 'contains', toCandidateKey: 'recipient_group_template' },
      { fromCandidateKey: 'more_section', type: 'contains', toCandidateKey: 'related_report_section' },
    ],
  };
  const domNodes = [
    ['div', '4 . 图片和附件', false, 333, 346], ['div', '单个文件最大为 400 M，最多可上传 10 个文件', false, 341, 348],
    ['div', '', true, 352, 394], ['span', '选择文件', true, 370, 378],
    ['div', '接收人', false, 414, 427], ['div', '', true, 427, 438], ['div', '葛超烨', false, 439, 444],
    ['img', '', true, 427, 441], ['label', '', true, 455, 462], ['span', '通过单聊发送给对方', true, 456, 461],
    ['div', '接收群', false, 475, 488], ['div', '', true, 488, 500], ['div', 'Onl...', false, 500, 505], ['img', '', true, 488, 502],
    ['div', '更多', false, 522, 535], ['label', '', true, 536, 544], ['span', '允许转发', true, 537, 543],
    ['div', '关联汇报', false, 555, 568], ['div', '', true, 569, 965],
  ].map(([tag, text, interactive, top, bottom]) => ({ tag, text, interactive, bounds: { left: 96, top, right: 1053, bottom } }));
  const result = refineRecognitionGeometryWithSources(recognition, {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: null },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1000, height: 1000 }, nodes: domNodes }] },
  }, null, { width: 1000, height: 1000 });
  const recipient = result.elements.find((item) => item.candidateKey === 'recipient_section');
  const group = result.elements.find((item) => item.candidateKey === 'group_section');
  const more = result.elements.find((item) => item.candidateKey === 'more_section');
  const attachment = result.elements.find((item) => item.candidateKey === 'attachments_section');
  assert.equal(recipient.abstraction, null);
  assert.equal(group.abstraction, null);
  assert.equal(result.elements.find((item) => item.candidateKey === 'recipient_person_item')?.abstraction?.kind, 'dynamic-template');
  assert.equal(result.elements.find((item) => item.candidateKey === 'recipient_group_item')?.abstraction?.kind, 'dynamic-template');
  assert.ok(Math.abs(attachment.approximateRegion.y + attachment.approximateRegion.height - 0.394) < 0.003);
  assert.ok(Math.abs(more.approximateRegion.y - 0.522) < 0.003);
  assert.ok(result.relationships.some((item) => item.fromCandidateKey === 'recipient_section' && item.toCandidateKey === 'recipient_person_item' && item.type === 'contains'));
  assert.ok(result.relationships.some((item) => item.fromCandidateKey === 'group_section' && item.toCandidateKey === 'recipient_group_item' && item.type === 'contains'));
  assert.equal(result.relationships.some((item) => item.fromCandidateKey === 'attachments_section' && item.toCandidateKey === 'remove_recipient'), false);
  assert.equal(result.relationships.some((item) => item.fromCandidateKey === 'more_section' && item.toCandidateKey === 'related_report_section'), false);
  assert.deepEqual(validateRecognitionConsistency(result), []);
});

test('DOM label 精确提供单聊复选框边界并归属接收人 section', () => {
  const recognition = {
    elements: [
      element('recipient_section', '接收人', 'section', { x: 0.08, y: 0.4, width: 0.84, height: 0.08 }),
      element('direct_message_checkbox', '通过单聊发送给对方', 'checkbox', { x: 0.08, y: 0.46, width: 0.4, height: 0.02 }),
    ],
    relationships: [],
  };
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: null },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1000, height: 1000 }, nodes: [
      { tag: 'div', text: '接收人', interactive: false, bounds: { left: 80, top: 400, right: 920, bottom: 460 } },
      { tag: 'label', text: '', interactive: true, bounds: { left: 80, top: 460, right: 500, bottom: 480 } },
      { tag: 'span', text: '通过单聊发送给对方', interactive: true, bounds: { left: 140, top: 462, right: 480, bottom: 478 } },
    ] }] },
  };
  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 1000 });
  const checkbox = result.elements.find((item) => item.candidateKey === 'direct_message_checkbox');
  assert.deepEqual(roundedBox(checkbox.approximateRegion), { x: 0.08, y: 0.46, width: 0.42, height: 0.02 });
  assert.equal(checkbox.geometryKind, 'tap-target');
  assert.ok(result.relationships.some((item) => item.fromCandidateKey === 'recipient_section'
    && item.toCandidateKey === 'direct_message_checkbox' && item.type === 'contains'));
});

test('DOM 和 UI Tree 节点优先校准接收人动态头像与姓名字段', () => {
  const recipientRegion = { x: 0.08, y: 0.4, width: 0.84, height: 0.08 };
  const recognition = {
    elements: [
      element('recipient_section', '接收人', 'section', recipientRegion, {
        abstraction: { kind: 'dynamic-template', templateKey: 'recipient_item_template', instanceCount: 1,
          instanceRegions: [recipientRegion], bboxStyle: 'abstract', fields: [
            { key: 'recipient_avatar', label: '接收人头像', elementType: 'avatar', instanceRegions: [{ x: 0.09, y: 0.43, width: 0.08, height: 0.02 }] },
            { key: 'recipient_name', label: '接收人姓名', elementType: 'text', instanceRegions: [{ x: 0.09, y: 0.45, width: 0.12, height: 0.01 }] },
          ] },
      }),
    ],
    relationships: [],
  };
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: { class: 'FrameLayout', children: [
      { class: 'ImageView', bounds: { left: 100, top: 420, right: 180, bottom: 500 }, children: [] },
    ] } },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1000, height: 1000 }, nodes: [
      { tag: 'div', text: '接收人', interactive: false, bounds: { left: 80, top: 400, right: 920, bottom: 460 } },
      { tag: 'img', text: '', role: 'img', interactive: true, bounds: { left: 100, top: 420, right: 180, bottom: 500 } },
      { tag: 'div', text: '葛超烨', interactive: false, bounds: { left: 100, top: 510, right: 220, bottom: 550 } },
    ] }] },
  };
  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 1000 });
  // Dynamic recipient payloads are normalized into a child common element;
  // the section itself remains a structural boundary.
  const recipientItem = result.elements.find((item) => item.candidateKey === 'recipient_avatar_item');
  const fields = Object.fromEntries(recipientItem.abstraction.fields.map((field) => [field.key, field]));
  assert.deepEqual(roundedBox(fields.recipient_avatar.instanceRegions[0]), { x: 0.1, y: 0.42, width: 0.08, height: 0.08 });
  assert.deepEqual(roundedBox(fields.recipient_name.instanceRegions[0]), { x: 0.1, y: 0.51, width: 0.12, height: 0.04 });
});

test('动态模板父标签是当前值时不会把相邻对象名称互相吸附', () => {
  const dynamic = (key, label, sectionKey, y, nameKey) => element(key, label, 'avatar', {
    x: 0.1, y, width: 0.12, height: 0.04,
  }, {
    dynamicContent: true,
    abstraction: {
      kind: 'dynamic-template', templateKey: `${key}-template`, instanceCount: 1,
      bboxStyle: 'abstract', instanceRegions: [{ x: 0.1, y, width: 0.12, height: 0.04 }],
      fields: [
        { key: `${key}-avatar`, label: '头像', elementType: 'avatar',
          instanceRegions: [{ x: 0.1, y, width: 0.08, height: 0.03 }] },
        { key: nameKey, label: '名称', elementType: 'static-label',
          instanceRegions: [{ x: 0.1, y: y + 0.03, width: 0.12, height: 0.01 }] },
      ],
    },
    meaning: meaning([label]),
    relationships: [{ fromCandidateKey: sectionKey, type: 'contains', toCandidateKey: key }],
  });
  const recognition = {
    elements: [
      element('recipient_section', '接收人', 'section', { x: 0.05, y: 0.1, width: 0.4, height: 0.07 }),
      dynamic('recipient_item', '葛超烨', 'recipient_section', 0.12, 'recipient-name'),
      element('group_section', '接收群', 'section', { x: 0.05, y: 0.18, width: 0.4, height: 0.07 }),
      dynamic('group_item', 'Onl...', 'group_section', 0.2, 'group-name'),
    ],
    relationships: [
      { fromCandidateKey: 'recipient_section', type: 'contains', toCandidateKey: 'recipient_item' },
      { fromCandidateKey: 'group_section', type: 'contains', toCandidateKey: 'group_item' },
    ],
  };
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: null },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1000, height: 1000 }, nodes: [
      { tag: 'img', role: 'img', interactive: true, bounds: { left: 100, top: 120, right: 180, bottom: 150 } },
      { tag: 'div', text: '葛超烨', bounds: { left: 100, top: 150, right: 220, bottom: 160 } },
      { tag: 'img', role: 'img', interactive: true, bounds: { left: 100, top: 200, right: 180, bottom: 230 } },
      { tag: 'div', text: 'Onl...', bounds: { left: 100, top: 230, right: 220, bottom: 240 } },
    ] }] },
  };

  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, {
    width: 1000, height: 1000,
  });
  const recipient = result.elements.find((item) => item.candidateKey === 'recipient_item');
  const group = result.elements.find((item) => item.candidateKey === 'group_item');
  const field = (item, key) => item.abstraction.fields.find((candidate) => candidate.key === key).instanceRegions[0];
  assert.ok(Math.abs(field(recipient, 'recipient-name').y - 0.15) < 1e-9);
  assert.ok(Math.abs(field(group, 'group-name').y - 0.23) < 1e-9);
});

test('普通头像候选从整行包装框收敛到运行时主图片边界', () => {
  const recognition = {
    elements: [
      element('recipient_avatar', '张三', 'avatar', { x: 0.08, y: 0.3, width: 0.32, height: 0.09 }),
      element('group_avatar', '研发群', 'avatar-group', { x: 0.08, y: 0.5, width: 0.32, height: 0.09 }),
    ],
  };
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: null },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1000, height: 1000 }, nodes: [
      // The wrapper and action icons are all interactive; only the leading
      // image is the visual avatar slot.
      { tag: 'div', interactive: true, bounds: { left: 80, top: 300, right: 400, bottom: 390 } },
      { tag: 'img', role: 'img', interactive: true, bounds: { left: 100, top: 300, right: 180, bottom: 360 } },
      { tag: 'img', role: 'img', interactive: true, bounds: { left: 220, top: 295, right: 260, bottom: 325 } },
      { tag: 'img', role: 'img', interactive: true, bounds: { left: 300, top: 300, right: 360, bottom: 360 } },
      { tag: 'div', text: '张三', bounds: { left: 100, top: 360, right: 200, bottom: 380 } },
      { tag: 'div', interactive: true, bounds: { left: 80, top: 500, right: 400, bottom: 590 } },
      { tag: 'img', role: 'img', interactive: true, bounds: { left: 100, top: 500, right: 180, bottom: 560 } },
      { tag: 'img', role: 'img', interactive: true, bounds: { left: 220, top: 495, right: 260, bottom: 525 } },
      { tag: 'img', role: 'img', interactive: true, bounds: { left: 300, top: 500, right: 360, bottom: 560 } },
      { tag: 'div', text: '研发群', bounds: { left: 100, top: 560, right: 220, bottom: 580 } },
    ] }] },
  };

  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, {
    width: 1000, height: 1000,
  });
  assert.deepEqual(roundedBox(result.elements[0].approximateRegion), {
    x: 0.1, y: 0.3, width: 0.08, height: 0.06,
  });
  assert.deepEqual(roundedBox(result.elements[1].approximateRegion), {
    x: 0.1, y: 0.5, width: 0.08, height: 0.06,
  });
  assert.equal(result.geometryRefinement.standaloneAvatarGroundingCount, 2);
});

test('运行时图片和文本将分离头像候选稳定归并为动态模板', () => {
  const recognition = {
    elements: [
      element('recipient_section', '对象区域', 'section', { x: 0.05, y: 0.05, width: 0.9, height: 0.5 }),
      element('avatar_a', '甲', 'avatar', { x: 0.08, y: 0.1, width: 0.25, height: 0.1 }, { interactive: true }),
      // The text estimates are intentionally swapped. Runtime text and
      // one-to-one assignment must still keep each object's name with its
      // corresponding image.
      element('name_a', '甲', 'static-label', { x: 0.1, y: 0.35, width: 0.12, height: 0.02 }),
      element('avatar_b', '乙', 'avatar-group', { x: 0.08, y: 0.3, width: 0.25, height: 0.1 }, { interactive: true }),
      element('name_b', '乙', 'static-label', { x: 0.1, y: 0.15, width: 0.12, height: 0.02 }),
    ],
    relationships: [
      { fromCandidateKey: 'recipient_section', type: 'contains', toCandidateKey: 'avatar_a' },
      { fromCandidateKey: 'recipient_section', type: 'contains', toCandidateKey: 'name_a' },
      { fromCandidateKey: 'recipient_section', type: 'contains', toCandidateKey: 'avatar_b' },
      { fromCandidateKey: 'recipient_section', type: 'contains', toCandidateKey: 'name_b' },
    ],
    actionCandidates: [{ triggerCandidateKey: 'avatar_a', action: 'tap', expectedOutcome: '查看对象', basis: 'visible-affordance', confidence: 0.9 }],
  };
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: null },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1000, height: 1000 }, nodes: [
      { tag: 'img', role: 'img', interactive: true, bounds: { left: 100, top: 100, right: 180, bottom: 160 } },
      { tag: 'div', text: '甲', bounds: { left: 100, top: 160, right: 220, bottom: 180 } },
      { tag: 'img', role: 'img', interactive: true, bounds: { left: 100, top: 300, right: 180, bottom: 360 } },
      { tag: 'div', text: '乙', bounds: { left: 100, top: 360, right: 220, bottom: 380 } },
    ] }] },
  };

  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, {
    width: 1000,
    height: 1000,
  });
  const avatarA = result.elements.find((item) => item.candidateKey === 'avatar_a');
  const avatarB = result.elements.find((item) => item.candidateKey === 'avatar_b');
  assert.equal(avatarA.abstraction?.kind, 'dynamic-template');
  assert.equal(avatarB.abstraction?.kind, 'dynamic-template');
  assert.equal(result.elements.some((item) => item.candidateKey === 'name_a' || item.candidateKey === 'name_b'), false);
  assert.deepEqual(roundedBox(avatarA.abstraction.fields.find((field) => field.elementType === 'avatar').instanceRegions[0]), {
    x: 0.1, y: 0.1, width: 0.08, height: 0.06,
  });
  assert.deepEqual(roundedBox(avatarA.abstraction.fields.find((field) => field.elementType === 'static-label').instanceRegions[0]), {
    x: 0.1, y: 0.16, width: 0.12, height: 0.02,
  });
  assert.deepEqual(roundedBox(avatarB.abstraction.fields.find((field) => field.elementType === 'avatar-group').instanceRegions[0]), {
    x: 0.1, y: 0.3, width: 0.08, height: 0.06,
  });
  assert.deepEqual(roundedBox(avatarB.abstraction.fields.find((field) => field.elementType === 'static-label').instanceRegions[0]), {
    x: 0.1, y: 0.36, width: 0.12, height: 0.02,
  });
  assert.ok(result.relationships.some((relation) => relation.fromCandidateKey === 'recipient_section'
    && relation.toCandidateKey === 'avatar_a' && relation.type === 'contains'));
  assert.equal(result.actionCandidates.some((action) => action.triggerCandidateKey === 'avatar_a'), true);
  assert.equal(result.geometryRefinement.runtimeAvatarNameMergeCount, 2);
});

test('动态对象名称使用父候选当前值避免相邻接收对象交换位置', () => {
  const dynamic = (candidateKey, label, sectionKey, y, estimatedNameY) => element(
    candidateKey,
    label,
    'avatar',
    { x: 0.08, y, width: 0.2, height: 0.08 },
    {
      dynamicContent: true,
      abstraction: {
        kind: 'dynamic-template',
        templateKey: `${candidateKey}-template`,
        instanceCount: 1,
        bboxStyle: 'abstract',
        instanceRegions: [{ x: 0.08, y, width: 0.2, height: 0.08 }],
        fields: [
          { key: `${candidateKey}-avatar`, label: '头像', elementType: 'avatar',
            instanceRegions: [{ x: 0.1, y, width: 0.08, height: 0.05 }] },
          { key: `${candidateKey}-name`, label: '名称', elementType: 'static-label',
            // Simulate a model run that assigned the neighbouring object's
            // vertical slot to this field.
            instanceRegions: [{ x: 0.1, y: estimatedNameY, width: 0.12, height: 0.01 }] },
        ],
      },
      meaning: meaning([label]),
      relationships: [{ fromCandidateKey: sectionKey, type: 'contains', toCandidateKey: candidateKey }],
    },
  );
  const recognition = {
    elements: [
      element('recipient_section', '接收对象', 'section', { x: 0.05, y: 0.05, width: 0.9, height: 0.5 }),
      dynamic('recipient_item', '葛超烨', 'recipient_section', 0.1, 0.32),
      dynamic('group_item', 'Onl...', 'recipient_section', 0.3, 0.12),
    ],
    relationships: [
      { fromCandidateKey: 'recipient_section', type: 'contains', toCandidateKey: 'recipient_item' },
      { fromCandidateKey: 'recipient_section', type: 'contains', toCandidateKey: 'group_item' },
    ],
  };
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: null },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1000, height: 1000 }, nodes: [
      { tag: 'div', text: '接收对象', bounds: { left: 50, top: 50, right: 950, bottom: 60 } },
      { tag: 'img', role: 'img', bounds: { left: 100, top: 100, right: 180, bottom: 150 } },
      { tag: 'div', text: '葛超烨', bounds: { left: 100, top: 150, right: 220, bottom: 160 } },
      { tag: 'img', role: 'img', bounds: { left: 100, top: 300, right: 180, bottom: 350 } },
      { tag: 'div', text: 'Onl...', bounds: { left: 100, top: 350, right: 220, bottom: 360 } },
    ] }] },
  };

  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, {
    width: 1000, height: 1000,
  });
  const field = (candidateKey) => result.elements.find((item) => item.candidateKey === candidateKey)
    .abstraction.fields.find((item) => item.key.endsWith('-name')).instanceRegions[0];
  assert.deepEqual(roundedBox(field('recipient_item')), {
    x: 0.1, y: 0.15, width: 0.12, height: 0.01,
  });
  assert.deepEqual(roundedBox(field('group_item')), {
    x: 0.1, y: 0.35, width: 0.12, height: 0.01,
  });
});

test('动态共相外框跨越相邻 section 时按稳定字段归属并裁剪', () => {
  const section = (key, label, y) => element(key, label, 'section', {
    x: 0.05, y, width: 0.9, height: 0.18,
  });
  const dynamic = (key, label, avatarRegion, nameRegion) => element(key, label, 'avatar', {
    // Deliberately spans the boundary between the two sections. This is the
    // malformed outer geometry produced by an interrupted model response.
    x: 0.1, y: 0.18, width: 0.2, height: 0.2,
  }, {
    dynamicContent: true,
    abstraction: {
      kind: 'dynamic-template', templateKey: `${key}-template`, instanceCount: 1,
      bboxStyle: 'abstract', instanceRegions: [{ x: 0.1, y: 0.18, width: 0.2, height: 0.2 }],
      fields: [
        { key: `${key}-avatar`, label: '稳定视觉槽位', elementType: 'avatar', instanceRegions: [avatarRegion] },
        { key: `${key}-name`, label: '稳定文本槽位', elementType: 'static-label', instanceRegions: [nameRegion] },
      ],
    },
  });
  const recognition = {
    elements: [
      section('upper_section', '上方区域', 0.1),
      section('lower_section', '下方区域', 0.3),
      dynamic('upper_payload', '甲', { x: 0.1, y: 0.18, width: 0.08, height: 0.05 }, { x: 0.1, y: 0.23, width: 0.1, height: 0.02 }),
      dynamic('lower_payload', '乙', { x: 0.1, y: 0.3, width: 0.08, height: 0.05 }, { x: 0.1, y: 0.35, width: 0.1, height: 0.02 }),
    ],
    // Both stale edges point at the first section; field evidence must repair
    // the second edge without relying on candidate names or labels.
    relationships: [
      { fromCandidateKey: 'upper_section', type: 'contains', toCandidateKey: 'upper_payload' },
      { fromCandidateKey: 'upper_section', type: 'contains', toCandidateKey: 'lower_payload' },
    ],
  };
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: null },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1000, height: 1000 }, nodes: [
      { tag: 'div', text: '上方区域', bounds: { left: 50, top: 100, right: 950, bottom: 130 } },
      { tag: 'div', text: '下方区域', bounds: { left: 50, top: 300, right: 950, bottom: 330 } },
      { tag: 'img', role: 'img', bounds: { left: 100, top: 180, right: 180, bottom: 230 } },
      { tag: 'div', text: '甲', bounds: { left: 100, top: 230, right: 200, bottom: 250 } },
      { tag: 'img', role: 'img', bounds: { left: 100, top: 300, right: 180, bottom: 350 } },
      { tag: 'div', text: '乙', bounds: { left: 100, top: 350, right: 200, bottom: 370 } },
    ] }] },
  };

  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, {
    width: 1000, height: 1000,
  });
  const ownerOf = (key) => result.relationships
    .find((relation) => relation.type === 'contains' && relation.toCandidateKey === key)?.fromCandidateKey;
  assert.equal(ownerOf('upper_payload'), 'upper_section');
  assert.equal(ownerOf('lower_payload'), 'lower_section');
  const lower = result.elements.find((item) => item.candidateKey === 'lower_payload');
  const lowerName = lower.abstraction.fields.find((field) => field.key === 'lower_payload-name').instanceRegions[0];
  assert.deepEqual(roundedBox(lowerName), { x: 0.1, y: 0.35, width: 0.1, height: 0.02 });
  assert.ok(lower.approximateRegion.y >= 0.3);
  assert.ok(lower.approximateRegion.y + lower.approximateRegion.height <= 0.37);
  assert.ok(result.geometryRefinement.dynamicChildGroundingCount >= 2);
});

test('接收群动态共相及其字段始终裁剪在 section 容器内', () => {
  const recognition = {
    elements: [
      element('group_section', '接收群', 'section', { x: 0.08, y: 0.4, width: 0.84, height: 0.1 }),
      element('recipient_group_item', '接收群头像', 'avatar-group', { x: 0.09, y: 0.47, width: 0.12, height: 0.07 }, {
        dynamicContent: true,
        abstraction: { kind: 'dynamic-template', templateKey: 'recipient-group-item', instanceCount: 1,
          instanceRegions: [{ x: 0.09, y: 0.47, width: 0.12, height: 0.07 }], bboxStyle: 'abstract',
          fields: [{ key: 'group_name', label: '群组名称', elementType: 'text', instanceRegions: [{ x: 0.1, y: 0.51, width: 0.1, height: 0.04 }] }] },
      }),
    ],
    relationships: [],
  };
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: null },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1000, height: 1000 }, nodes: [
      { tag: 'div', text: '接收群', bounds: { left: 80, top: 400, right: 920, bottom: 430 } },
      { tag: 'img', role: 'img', bounds: { left: 100, top: 450, right: 180, bottom: 490 } },
      { tag: 'div', text: 'Onl...', bounds: { left: 100, top: 490, right: 200, bottom: 510 } },
    ] }] },
  };
  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 1000 });
  const owner = result.elements.find((item) => item.candidateKey === 'group_section').approximateRegion;
  const child = result.elements.find((item) => item.candidateKey === 'recipient_group_item');
  const inside = (outer, inner) => inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
  assert.ok(inside(owner, child.approximateRegion));
  assert.ok(child.riskSignals.includes('geometry-clipped-to-semantic-owner'));
  assert.ok(child.abstraction.instanceRegions.every((region) => inside(owner, region)));
  assert.ok(child.abstraction.fields.every((field) => field.instanceRegions.every((region) => inside(child.approximateRegion, region))));
});

test('旧键 group_dynamic 的动态共相也会裁剪在接收群容器内', () => {
  const recognition = {
    elements: [
      element('group_section', '接收群', 'section', { x: 0.08, y: 0.4, width: 0.84, height: 0.1 }),
      element('group_dynamic', 'Onl...', 'avatar-group', { x: 0.09, y: 0.47, width: 0.12, height: 0.08 }, {
        dynamicContent: true,
        abstraction: { kind: 'dynamic-template', templateKey: 'group_identity_template', instanceCount: 1,
          instanceRegions: [{ x: 0.09, y: 0.47, width: 0.12, height: 0.08 }], bboxStyle: 'abstract',
          fields: [{ key: 'group_identity', label: '接收群', elementType: 'avatar-group',
            instanceRegions: [{ x: 0.09, y: 0.47, width: 0.12, height: 0.08 }] }] },
      }),
    ],
    relationships: [{ fromCandidateKey: 'group_section', type: 'contains', toCandidateKey: 'group_dynamic' }],
  };
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: null },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1000, height: 1000 }, nodes: [
      { tag: 'div', text: '接收群', bounds: { left: 80, top: 400, right: 920, bottom: 430 } },
      { tag: 'img', role: 'img', bounds: { left: 100, top: 450, right: 180, bottom: 490 } },
      { tag: 'div', text: 'Onl...', bounds: { left: 100, top: 490, right: 200, bottom: 510 } },
    ] }] },
  };
  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 1000 });
  const owner = result.elements.find((item) => item.candidateKey === 'group_section').approximateRegion;
  const child = result.elements.find((item) => item.candidateKey === 'group_dynamic');
  assert.ok(child.approximateRegion.y + child.approximateRegion.height <= owner.y + owner.height);
  assert.ok(child.riskSignals.includes('geometry-clipped-to-semantic-owner'));
});

test('嵌套容器中的动态共相只由最具体直接父级校准', () => {
  const recipientRegion = { x: 0.08, y: 0.4, width: 0.84, height: 0.16 };
  const recognition = {
    elements: [
      element('outer_form', '填写表单', 'form', { x: 0, y: 0.1, width: 1, height: 0.8 }),
      element('recipient_section', '接收对象', 'section', recipientRegion, {
        dynamicContent: true,
        abstraction: {
          kind: 'dynamic-template', templateKey: 'recipient-payload', instanceCount: 1,
          instanceRegions: [{ x: 0.1, y: 0.44, width: 0.14, height: 0.1 }], bboxStyle: 'abstract',
          fields: [
            { key: 'payload_avatar', label: '对象头像', elementType: 'avatar',
              instanceRegions: [{ x: 0.1, y: 0.44, width: 0.08, height: 0.06 }] },
            { key: 'payload_name', label: '对象名称', elementType: 'text',
              instanceRegions: [{ x: 0.1, y: 0.51, width: 0.14, height: 0.03 }] },
          ],
        },
      }),
      element('next_section', '其他设置', 'section', { x: 0.08, y: 0.58, width: 0.84, height: 0.08 }),
    ],
    relationships: [
      { fromCandidateKey: 'outer_form', type: 'contains', toCandidateKey: 'recipient_section' },
    ],
  };
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: null },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1000, height: 1000 }, nodes: [
      { tag: 'div', text: '接收对象', bounds: { left: 80, top: 400, right: 920, bottom: 430 } },
      { tag: 'img', role: 'img', bounds: { left: 100, top: 440, right: 180, bottom: 500 } },
      { tag: 'div', text: '任意动态值 A7', bounds: { left: 100, top: 510, right: 240, bottom: 540 } },
      { tag: 'div', text: '其他设置', bounds: { left: 80, top: 580, right: 920, bottom: 610 } },
    ] }] },
  };

  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 1000 });
  const child = result.elements.find((item) => item.candidateKey === 'payload_avatar_item');
  const fields = Object.fromEntries(child.abstraction.fields.map((field) => [field.key, field]));
  assert.deepEqual(roundedBox(fields.payload_avatar.instanceRegions[0]), { x: 0.1, y: 0.44, width: 0.08, height: 0.06 });
  assert.deepEqual(roundedBox(fields.payload_name.instanceRegions[0]), { x: 0.1, y: 0.51, width: 0.14, height: 0.03 });
  assert.deepEqual(roundedBox(child.approximateRegion), { x: 0.1, y: 0.44, width: 0.14, height: 0.1 });
  assert.equal(result.geometryRefinement.dynamicChildGroundingCount, 1);
  assert.ok(result.relationships.some((relation) => relation.fromCandidateKey === 'recipient_section'
    && relation.toCandidateKey === child.candidateKey && relation.type === 'contains'));
  assert.equal(result.relationships.some((relation) => relation.fromCandidateKey === 'outer_form'
    && relation.toCandidateKey === child.candidateKey && relation.type === 'contains'), false);
});

test('原生顶部导航不会被 WebView 远处的同词长文本迁移', () => {
  const recognition = {
    elements: [
      element('page_navigation', '日志', 'navigation-bar', { x: 0, y: 0.02, width: 1, height: 0.1 }),
      element('back', '返回', 'icon-button', { x: 0.02, y: 0.04, width: 0.08, height: 0.05 }),
      element('title', '日志', 'title', { x: 0.45, y: 0.04, width: 0.1, height: 0.05 }),
      element('submit', '提交', 'text-button', { x: 0.82, y: 0.04, width: 0.1, height: 0.05 }),
    ],
    relationships: [
      { fromCandidateKey: 'page_navigation', type: 'contains', toCandidateKey: 'back' },
      { fromCandidateKey: 'page_navigation', type: 'contains', toCandidateKey: 'title' },
      { fromCandidateKey: 'page_navigation', type: 'contains', toCandidateKey: 'submit' },
    ],
  };
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: {
      class: 'FrameLayout', children: [
        { class: 'TextView', text: '日志', bounds: { left: 450, top: 40, right: 550, bottom: 90 }, children: [] },
        { class: 'TextView', text: '提交', bounds: { left: 820, top: 40, right: 920, bottom: 90 }, children: [] },
      ],
    } },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1000, height: 1000 }, nodes: [
      { tag: 'div', text: '测试日志规则', interactive: true, bounds: { left: 120, top: 600, right: 880, bottom: 660 } },
      { tag: 'div', text: '提交时间：09:00-18:00', bounds: { left: 120, top: 700, right: 880, bottom: 750 } },
    ] }] },
  };

  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 1000 });
  const navigation = result.elements.find((item) => item.candidateKey === 'page_navigation');
  assert.ok(navigation.approximateRegion.y < 0.04);
  assert.ok(navigation.approximateRegion.y + navigation.approximateRegion.height < 0.15);
  assert.ok(result.relationships.some((relation) => relation.fromCandidateKey === 'page_navigation'
    && relation.toCandidateKey === 'title' && relation.type === 'contains'));
  assert.ok(result.relationships.some((relation) => relation.fromCandidateKey === 'page_navigation'
    && relation.toCandidateKey === 'submit' && relation.type === 'contains'));
});

test('导航栏模型框整体偏移时由已落地的直接子元素纠正', () => {
  const recognition = {
    elements: [
      element('navigation', '操作页', 'navigation-bar', { x: 0, y: 0.2, width: 1, height: 0.1 }),
      element('back', '返回', 'icon-button', { x: 0.02, y: 0.04, width: 0.08, height: 0.05 }),
      element('title', '操作页', 'title', { x: 0.42, y: 0.04, width: 0.16, height: 0.05 }),
      element('save', '保存', 'text-button', { x: 0.84, y: 0.04, width: 0.1, height: 0.05 }),
    ],
    relationships: [
      { fromCandidateKey: 'navigation', type: 'contains', toCandidateKey: 'back' },
      { fromCandidateKey: 'navigation', type: 'contains', toCandidateKey: 'title' },
      { fromCandidateKey: 'navigation', type: 'contains', toCandidateKey: 'save' },
    ],
  };
  const runtime = { hierarchy: {
    coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: {
      class: 'FrameLayout', children: [
        { class: 'TextView', text: '操作页', bounds: { left: 420, top: 40, right: 580, bottom: 90 }, children: [] },
        { class: 'TextView', text: '保存', bounds: { left: 840, top: 40, right: 940, bottom: 90 }, children: [] },
      ],
    },
  } };

  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 1000 });
  const navigation = result.elements.find((item) => item.candidateKey === 'navigation');
  assert.ok(navigation.approximateRegion.y < 0.03);
  assert.ok(navigation.approximateRegion.y + navigation.approximateRegion.height >= 0.09);
  assert.ok(result.relationships.some((relation) => relation.fromCandidateKey === 'navigation'
    && relation.toCandidateKey === 'title' && relation.type === 'contains'));
  assert.ok(result.relationships.some((relation) => relation.fromCandidateKey === 'navigation'
    && relation.toCandidateKey === 'save' && relation.type === 'contains'));
});

test('单个异常大导航框按运行时同一水平带恢复而不是保留内容区边界', () => {
  const recognition = {
    elements: [element('navigation', '操作页', 'navigation-bar', { x: 0, y: 0.57, width: 1, height: 0.39 }, {
      meaning: meaning(['操作页', '保存']),
    })],
    relationships: [],
  };
  const runtime = { hierarchy: {
    coordinateSpace: 'display_px', viewport: { width: 1000, height: 4000 }, root: {
      class: 'FrameLayout', children: [
        { class: 'TextView', text: '操作页', bounds: { left: 420, top: 40, right: 580, bottom: 90 }, children: [] },
        { class: 'TextView', text: '保存', bounds: { left: 840, top: 40, right: 940, bottom: 90 }, children: [] },
        // A full WebView is a page surface, not another navigation child.
        { class: 'WebView', clickable: true, bounds: { left: 0, top: 110, right: 1000, bottom: 4000 }, children: [] },
      ],
    },
  } };

  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 4000 });
  const navigation = result.elements.find((item) => item.candidateKey === 'navigation');
  assert.ok(navigation.approximateRegion.y < 0.03);
  assert.ok(navigation.approximateRegion.y + navigation.approximateRegion.height < 0.08);
  assert.ok(navigation.riskSignals.includes('geometry-grounded-by-navigation-band'));
  assert.equal(result.elements.filter((item) => item.elementType === 'navigation-bar').length, 1);
});

test('重叠的模型导航候选去重并迁移子关系和动作引用', () => {
  const recognition = {
    elements: [
      element('page_navigation', '页面导航', 'navigation-bar', { x: 0, y: 0.02, width: 1, height: 0.1 }),
      element('runtime_nav_duplicate', '页面导航', 'navigation-bar', { x: 0.002, y: 0.021, width: 0.996, height: 0.098 }, {
        riskSignals: ['geometry-grounded-by-runtime'],
      }),
      element('title', '页面标题', 'title', { x: 0.4, y: 0.04, width: 0.2, height: 0.04 }),
      element('back', '返回', 'icon-button', { x: 0.02, y: 0.04, width: 0.08, height: 0.04 }),
    ],
    relationships: [
      { fromCandidateKey: 'page_navigation', type: 'contains', toCandidateKey: 'title' },
      { fromCandidateKey: 'runtime_nav_duplicate', type: 'contains', toCandidateKey: 'back' },
    ],
    actionCandidates: [
      { triggerCandidateKey: 'runtime_nav_duplicate', action: 'tap' },
    ],
  };
  const result = refineRecognitionGeometryWithSources(recognition, null, null, { width: 1000, height: 1000 });
  const navigation = result.elements.filter((item) => item.elementType === 'navigation-bar');
  assert.equal(navigation.length, 1);
  assert.equal(navigation[0].candidateKey, 'page_navigation');
  assert.equal(result.geometryRefinement.navigationDedupCount, 1);
  assert.ok(result.relationships.some((relation) => relation.fromCandidateKey === 'page_navigation'
    && relation.toCandidateKey === 'title' && relation.type === 'contains'));
  assert.ok(result.relationships.some((relation) => relation.fromCandidateKey === 'page_navigation'
    && relation.toCandidateKey === 'back' && relation.type === 'contains'));
  assert.deepEqual(result.actionCandidates, [{ triggerCandidateKey: 'page_navigation', action: 'tap' }]);
});

test('上下分离的合法导航栏不会被全局去重', () => {
  const recognition = {
    elements: [
      element('top_navigation', '顶部导航', 'navigation-bar', { x: 0, y: 0.02, width: 1, height: 0.1 }),
      element('bottom_navigation', '底部导航', 'navigation-bar', { x: 0, y: 0.88, width: 1, height: 0.1 }),
    ],
  };
  const result = refineRecognitionGeometryWithSources(recognition, null, null, { width: 1000, height: 1000 });
  assert.equal(result.elements.filter((item) => item.elementType === 'navigation-bar').length, 2);
  assert.equal(result.geometryRefinement.navigationDedupCount, 0);
});

test('全屏运行时伪导航包裹真实导航时只保留真实导航', () => {
  const recognition = {
    elements: [
      element('page_navigation', '页面导航', 'navigation-bar', { x: 0, y: 0.02, width: 1, height: 0.1 }),
      element('runtime_fullscreen_navigation', 'root', 'navigation-bar', { x: 0, y: 0, width: 1, height: 1 }, {
        riskSignals: ['geometry-grounded-by-runtime'],
      }),
    ],
  };
  const result = refineRecognitionGeometryWithSources(recognition, null, null, { width: 1000, height: 1000 });
  assert.deepEqual(result.elements.filter((item) => item.elementType === 'navigation-bar').map((item) => item.candidateKey), ['page_navigation']);
  assert.equal(result.geometryRefinement.navigationDedupCount, 1);
});

test('兄弟 form 只使用各自结构边界内的运行时节点校准', () => {
  const recognition = {
    elements: [
      element('form_a', '表单 A', 'form', { x: 0.05, y: 0.1, width: 0.9, height: 0.2 }),
      element('field_a', '字段 A', 'static-label', { x: 0.1, y: 0.2, width: 0.3, height: 0.04 }),
      element('form_b', '表单 B', 'form', { x: 0.05, y: 0.6, width: 0.9, height: 0.2 }),
      element('field_b', '字段 B', 'static-label', { x: 0.1, y: 0.7, width: 0.3, height: 0.04 }),
    ],
    relationships: [
      { fromCandidateKey: 'form_a', type: 'contains', toCandidateKey: 'field_a' },
      { fromCandidateKey: 'form_b', type: 'contains', toCandidateKey: 'field_b' },
    ],
  };
  const runtime = { hierarchy: {
    coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: {
      class: 'FrameLayout', children: [
        { class: 'TextView', text: '字段 A', bounds: { left: 100, top: 200, right: 400, bottom: 240 }, children: [] },
        { class: 'TextView', text: '字段 B', bounds: { left: 100, top: 700, right: 400, bottom: 740 }, children: [] },
      ],
    },
  } };

  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 1000 });
  const formA = result.elements.find((item) => item.candidateKey === 'form_a');
  assert.ok(formA.approximateRegion.y + formA.approximateRegion.height < 0.6);
  assert.equal(result.relationships.some((relation) => relation.fromCandidateKey === 'form_a'
    && relation.toCandidateKey === 'field_b' && relation.type === 'contains'), false);
  assert.ok(result.relationships.some((relation) => relation.fromCandidateKey === 'form_b'
    && relation.toCandidateKey === 'field_b' && relation.type === 'contains'));
});

test('外层 section 不会被其内层 section 标题截断', () => {
  const recognition = {
    elements: [
      element('outer', '外层区域', 'section', { x: 0.05, y: 0.1, width: 0.9, height: 0.3 }),
      element('inner', '内层区域', 'section', { x: 0.1, y: 0.18, width: 0.8, height: 0.12 }),
      element('inner_field', '内层字段', 'static-label', { x: 0.15, y: 0.24, width: 0.3, height: 0.03 }),
      element('next', '后续区域', 'section', { x: 0.05, y: 0.42, width: 0.9, height: 0.1 }),
    ],
    relationships: [
      { fromCandidateKey: 'outer', type: 'contains', toCandidateKey: 'inner' },
      { fromCandidateKey: 'inner', type: 'contains', toCandidateKey: 'inner_field' },
    ],
  };
  const runtime = { hierarchy: {
    coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: {
      class: 'FrameLayout', children: [
        { class: 'TextView', text: '外层区域', bounds: { left: 50, top: 100, right: 300, bottom: 130 }, children: [] },
        { class: 'TextView', text: '内层区域', bounds: { left: 100, top: 180, right: 350, bottom: 210 }, children: [] },
        { class: 'TextView', text: '内层字段', bounds: { left: 150, top: 240, right: 450, bottom: 270 }, children: [] },
        { class: 'TextView', text: '后续区域', bounds: { left: 50, top: 420, right: 300, bottom: 450 }, children: [] },
      ],
    },
  } };

  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 1000 });
  const outer = result.elements.find((item) => item.candidateKey === 'outer');
  const inner = result.elements.find((item) => item.candidateKey === 'inner');
  assert.ok(outer.approximateRegion.y + outer.approximateRegion.height
    >= inner.approximateRegion.y + inner.approximateRegion.height);
  assert.ok(result.relationships.some((relation) => relation.fromCandidateKey === 'outer'
    && relation.toCandidateKey === 'inner' && relation.type === 'contains'));
});

test('重复字段跳过同一行噪声并拒绝拼接缝截断的文本框', () => {
  const recognition = { elements: [element('cards', '规则卡片', 'list-item', { x: 0.08, y: 0.1, width: 0.84, height: 0.7 }, {
    abstraction: {
      kind: 'repeated-template', instanceCount: 3, bboxStyle: 'abstract',
      instanceRegions: [
        { x: 0.08, y: 0.1, width: 0.84, height: 0.2 },
        { x: 0.08, y: 0.35, width: 0.84, height: 0.2 },
        { x: 0.08, y: 0.6, width: 0.84, height: 0.2 },
      ],
      fields: [
        { key: 'rule_title', label: '规则名称', elementType: 'title', instanceRegions: [
          { x: 0.12, y: 0.12, width: 0.7, height: 0.03 },
          { x: 0.12, y: 0.37, width: 0.7, height: 0.03 },
          { x: 0.12, y: 0.62, width: 0.7, height: 0.03 },
        ] },
        { key: 'creator', label: '创建人', elementType: 'text', instanceRegions: [
          { x: 0.12, y: 0.18, width: 0.7, height: 0.03 },
          { x: 0.12, y: 0.43, width: 0.7, height: 0.03 },
          { x: 0.12, y: 0.68, width: 0.7, height: 0.03 },
        ] },
        { key: 'submission_time', label: '提交时间', elementType: 'text', instanceRegions: [
          { x: 0.12, y: 0.24, width: 0.7, height: 0.03 },
          { x: 0.12, y: 0.49, width: 0.7, height: 0.03 },
          { x: 0.12, y: 0.74, width: 0.7, height: 0.03 },
        ] },
      ],
    },
  })] };
  const rows = [0.12, 0.37, 0.62];
  const uiNodes = rows.flatMap((top, index) => [
    { class: 'TextView', text: `规则 ${index + 1}`, bounds: { left: 120, top: top * 1000, right: 820, bottom: (top + 0.03) * 1000 }, children: [] },
    { class: 'TextView', text: `创建人：用户 ${index + 1}`, bounds: { left: 120, top: (top + 0.06) * 1000, right: 820, bottom: (top + 0.09) * 1000 }, children: [] },
    { class: 'TextView', text: `提交时间：${index + 9}:00`, bounds: {
      left: 120, top: (top + 0.12) * 1000, right: 820,
      bottom: (top + (index === 2 ? 0.125 : 0.15)) * 1000,
    }, children: [] },
  ]);
  const domNodes = rows.flatMap((top, index) => [
    { tag: 'div', text: `规则 ${index + 1}`, bounds: { left: 120, top: top * 1000, right: 700, bottom: (top + 0.03) * 1000 } },
    ...(index === 2 ? [{ tag: 'span', text: '已选择', bounds: { left: 705, top: top * 1000, right: 790, bottom: (top + 0.03) * 1000 } }] : []),
    { tag: 'div', text: `创建人：用户 ${index + 1}`, bounds: { left: 120, top: (top + 0.06) * 1000, right: 820, bottom: (top + 0.09) * 1000 } },
    { tag: 'div', text: `提交时间：${index + 9}:00`, bounds: { left: 120, top: (top + 0.12) * 1000, right: 820, bottom: (top + 0.15) * 1000 } },
  ]);
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: { class: 'FrameLayout', children: uiNodes } },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1000, height: 1000 }, nodes: domNodes }] },
  };

  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 1000 });
  const fields = Object.fromEntries(result.elements[0].abstraction.fields.map((field) => [field.key, field]));
  assert.deepEqual(roundedBox(fields.creator.instanceRegions[2]), { x: 0.12, y: 0.68, width: 0.7, height: 0.03 });
  assert.deepEqual(roundedBox(fields.submission_time.instanceRegions[2]), { x: 0.12, y: 0.74, width: 0.7, height: 0.03 });
});

test('无字符级片段时保留已分离字段标签的横向边界', () => {
  const recognition = { elements: [element('fields', '字段块', 'section', { x: 0, y: 0.1, width: 1, height: 0.5 }, {
    abstraction: {
      kind: 'repeated-template', instanceCount: 2, bboxStyle: 'abstract',
      instanceRegions: [
        { x: 0, y: 0.1, width: 1, height: 0.22 },
        { x: 0, y: 0.35, width: 1, height: 0.22 },
      ],
      fields: [
        { key: 'ordinal', label: '填写项序号', elementType: 'static-label', instanceRegions: [
          { x: 0.1, y: 0.12, width: 0.04, height: 0.03 },
          { x: 0.1, y: 0.37, width: 0.04, height: 0.03 },
        ] },
        { key: 'field_label', label: '字段标签', elementType: 'static-label', instanceRegions: [
          { x: 0.145, y: 0.12, width: 0.25, height: 0.03 },
          { x: 0.145, y: 0.37, width: 0.25, height: 0.03 },
        ] },
        { key: 'input', label: '输入框', elementType: 'text-area', instanceRegions: [
          { x: 0.1, y: 0.17, width: 0.8, height: 0.12 },
          { x: 0.1, y: 0.42, width: 0.8, height: 0.12 },
        ] },
      ],
    },
  })] };
  const runtime = { hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: {
    class: 'FrameLayout', children: [
      { class: 'TextView', text: '1. 第一个字段', bounds: { left: 100, top: 120, right: 400, bottom: 150 }, children: [] },
      { class: 'TextView', text: '2. 第二个字段', bounds: { left: 100, top: 370, right: 400, bottom: 400 }, children: [] },
    ],
  } } };

  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 1000 });
  const labelRegions = result.elements[0].abstraction.fields
    .find((field) => field.key === 'field-label').instanceRegions;
  assert.deepEqual(labelRegions.map((box) => roundedBox(box).x), [0.145, 0.145]);
});

test('序号占据整行时按字符比例收敛字段标签左边界', () => {
  const recognition = { elements: [element('repeated-fields', '重复字段', 'section', { x: 0, y: 0.1, width: 1, height: 0.5 }, {
    abstraction: {
      kind: 'repeated-template', instanceCount: 2, bboxStyle: 'abstract',
      instanceRegions: [
        { x: 0, y: 0.1, width: 1, height: 0.2 },
        { x: 0, y: 0.32, width: 1, height: 0.2 },
      ],
      fields: [
        // Deliberately place the model label boundary too far right.  The
        // runtime only exposes one box for each complete title line, so the
        // repair must use the title text structure rather than a business key.
        { key: 'ordinal', label: '序号', elementType: 'static-label', instanceRegions: [
          { x: 0.1, y: 0.12, width: 0.044, height: 0.008 },
          { x: 0.1, y: 0.34, width: 0.044, height: 0.008 },
        ] },
        { key: 'field-label', label: '字段标签', elementType: 'static-label', instanceRegions: [
          { x: 0.15, y: 0.12, width: 0.24, height: 0.008 },
          { x: 0.15, y: 0.34, width: 0.24, height: 0.008 },
        ] },
        { key: 'input', label: '输入框', elementType: 'text-area', instanceRegions: [
          { x: 0.1, y: 0.14, width: 0.8, height: 0.12 },
          { x: 0.1, y: 0.36, width: 0.8, height: 0.12 },
        ] },
      ],
    },
  })] };
  const runtime = { hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1152, height: 8877 }, root: {
    class: 'FrameLayout', children: [
      { class: 'TextView', text: '1.\u00a0甲乙丙丁戊己', bounds: { left: 111, top: 456, right: 441, bottom: 528 }, children: [] },
      { class: 'TextView', text: '2.\u00a0甲乙丙丁戊己', bounds: { left: 111, top: 1290, right: 441, bottom: 1362 }, children: [] },
    ],
  } } };

  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1152, height: 8877 });
  const fields = Object.fromEntries(result.elements[0].abstraction.fields.map((field) => [field.key, field]));
  const labels = fields['field-label'].instanceRegions;
  const ordinals = fields.ordinal.instanceRegions;
  // The inferred split is materially left of the stale model estimate, while
  // remaining to the right of the visible ordinal region.
  assert.ok(labels[0].x < 0.145);
  assert.ok(labels[0].x > ordinals[0].x + ordinals[0].width);
  assert.ok(Math.abs(labels[0].x - labels[1].x) < 0.002);
});

test('多行文字按钮使用包含全部文案的交互边界并抑制内部节点补报', () => {
  const recognition = { elements: [
    element('upload', '选择文件(大小受限)', 'text-button', { x: 0.1, y: 0.3, width: 0.6, height: 0.3 }),
  ], relationships: [] };
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: null },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1000, height: 1000 }, nodes: [
      { tag: 'div', text: '', interactive: true, bounds: { left: 100, top: 300, right: 700, bottom: 600 } },
      { tag: 'img', role: 'img', text: '', interactive: true, bounds: { left: 370, top: 340, right: 430, bottom: 390 } },
      { tag: 'span', text: '选择文件', interactive: true, bounds: { left: 300, top: 410, right: 500, bottom: 460 } },
      { tag: 'span', text: '(大小受限)', interactive: true, bounds: { left: 280, top: 470, right: 520, bottom: 520 } },
    ] }] },
  };

  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 1000 });
  assert.deepEqual(roundedBox(result.elements.find((item) => item.candidateKey === 'upload').approximateRegion), {
    x: 0.1, y: 0.3, width: 0.6, height: 0.3,
  });
  assert.equal(result.elements.some((item) => item.candidateKey.startsWith('runtime_')), false);
});

test('首行模型文案也会按同一交互祖先覆盖多行文本控件', () => {
  const recognition = { elements: [
    // Deliberately make the model label and box incomplete/wide. The runtime
    // evidence below uses unrelated generic text for the second line.
    element('wrapped-action', '执行操作', 'text-button', { x: 0.04, y: 0.2, width: 0.92, height: 0.06 }),
  ], relationships: [] };
  const runtime = {
    hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: null },
    dom: { status: 'complete', documents: [{ displayViewport: { width: 1000, height: 1000 }, nodes: [
      { tag: 'div', text: '', interactive: true, bounds: { left: 100, top: 220, right: 500, bottom: 520 } },
      { tag: 'span', text: '执行操作', interactive: true, bounds: { left: 260, top: 330, right: 340, bottom: 370 } },
      { tag: 'span', text: '(附加说明)', interactive: true, bounds: { left: 240, top: 370, right: 360, bottom: 410 } },
    ] }] },
  };

  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 1000 });
  assert.deepEqual(roundedBox(result.elements[0].approximateRegion), {
    x: 0.1, y: 0.22, width: 0.4, height: 0.3,
  });
  assert.equal(result.elements.some((item) => item.candidateKey.startsWith('runtime_')), false);
});

test('重复表单结构字段缺失中间标题时保留实例索引空槽', () => {
  const recognition = { elements: [element('repeated-form', '重复表单', 'section', { x: 0, y: 0.1, width: 1, height: 0.65 }, {
    abstraction: {
      kind: 'repeated-template', templateKey: 'generic-form', instanceCount: 3, bboxStyle: 'abstract',
      instanceRegions: [
        { x: 0, y: 0.1, width: 1, height: 0.18 },
        { x: 0, y: 0.32, width: 1, height: 0.18 },
        { x: 0, y: 0.54, width: 1, height: 0.18 },
      ],
      fields: [{ key: 'input', label: '输入', elementType: 'text-area', instanceRegions: [
        { x: 0.1, y: 0.16, width: 0.8, height: 0.1 },
        { x: 0.1, y: 0.38, width: 0.8, height: 0.1 },
        { x: 0.1, y: 0.60, width: 0.8, height: 0.1 },
      ] }],
    },
  })] };
  const runtime = { hierarchy: { coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: {
    class: 'FrameLayout', children: [
      { class: 'TextView', text: '1. 第一项', bounds: { left: 100, top: 120, right: 340, bottom: 145 }, children: [] },
      // The second title is not observable in this snapshot.
      { class: 'TextView', text: '3. 第三项', bounds: { left: 100, top: 560, right: 340, bottom: 585 }, children: [] },
    ],
  } } };

  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 1000 });
  const fields = Object.fromEntries(result.elements[0].abstraction.fields.map((field) => [field.key, field]));
  for (const key of ['ordinal', 'field-label']) {
    const regions = fields[key].instanceRegions;
    assert.equal(regions.length, 3, `${key} keeps the third instance index`);
    assert.ok(regions[0]);
    assert.equal(regions[1], null);
    assert.ok(regions[2]);
  }
});

test('重叠容器同时声明动态共相时只保留最具体直接父级', () => {
  const dynamic = element('dynamic_value', '当前值', 'text', { x: 0.3, y: 0.3, width: 0.12, height: 0.04 }, {
    dynamicContent: true,
    abstraction: {
      kind: 'dynamic-template', templateKey: 'value-template', instanceCount: 1, bboxStyle: 'abstract',
      instanceRegions: [{ x: 0.3, y: 0.3, width: 0.12, height: 0.04 }],
      fields: [{ key: 'value', label: '当前值', elementType: 'text',
        instanceRegions: [{ x: 0.3, y: 0.3, width: 0.12, height: 0.04 }] }],
    },
  });
  const recognition = {
    elements: [
      element('broad_section', '外层区域', 'section', { x: 0.05, y: 0.1, width: 0.8, height: 0.6 }),
      element('specific_section', '局部区域', 'section', { x: 0.2, y: 0.2, width: 0.35, height: 0.25 }),
      dynamic,
    ],
    relationships: [
      { fromCandidateKey: 'broad_section', type: 'contains', toCandidateKey: 'dynamic_value' },
      { fromCandidateKey: 'specific_section', type: 'contains', toCandidateKey: 'dynamic_value' },
    ],
  };

  const result = refineRecognitionGeometryWithSources(recognition, null, null, { width: 1000, height: 1000 });
  const owners = result.relationships.filter((relation) => relation.type === 'contains'
    && relation.toCandidateKey === 'dynamic_value').map((relation) => relation.fromCandidateKey);
  assert.deepEqual(owners, ['specific_section']);
});

test('完全不相交的显式动态父级不会扩张并由几何直接父级接管', () => {
  const recognition = {
    elements: [
      element('stale_section', '旧区域', 'section', { x: 0.05, y: 0.1, width: 0.2, height: 0.12 }),
      element('actual_section', '当前区域', 'section', { x: 0.65, y: 0.65, width: 0.25, height: 0.2 }),
      element('dynamic_value', '任意值', 'text', { x: 0.7, y: 0.72, width: 0.1, height: 0.04 }, {
        dynamicContent: true,
        abstraction: {
          kind: 'dynamic-template', templateKey: 'value-template', instanceCount: 1, bboxStyle: 'abstract',
          instanceRegions: [{ x: 0.7, y: 0.72, width: 0.1, height: 0.04 }],
          fields: [{ key: 'value', label: '任意值', elementType: 'text',
            instanceRegions: [{ x: 0.7, y: 0.72, width: 0.1, height: 0.04 }] }],
        },
      }),
    ],
    relationships: [{ fromCandidateKey: 'stale_section', type: 'contains', toCandidateKey: 'dynamic_value' }],
  };

  const result = refineRecognitionGeometryWithSources(recognition, null, null, { width: 1000, height: 1000 });
  assert.deepEqual(roundedBox(result.elements.find((item) => item.candidateKey === 'stale_section').approximateRegion), {
    x: 0.05, y: 0.1, width: 0.2, height: 0.12,
  });
  const owners = result.relationships.filter((relation) => relation.type === 'contains'
    && relation.toCandidateKey === 'dynamic_value').map((relation) => relation.fromCandidateKey);
  assert.deepEqual(owners, ['actual_section']);
});

test('容器下方相邻的动态元素不会因长图归一化容差被吸入容器', () => {
  const recognition = {
    elements: [
      element('top_bar', '顶部区域', 'navigation-bar', { x: 0, y: 0.01, width: 1, height: 0.015 }),
      element('bar_title', '当前页面', 'title', { x: 0.4, y: 0.014, width: 0.2, height: 0.006 }),
      element('adjacent_dynamic', '当前用户标题', 'title', { x: 0.08, y: 0.032, width: 0.3, height: 0.007 }, {
        dynamicContent: true,
        abstraction: {
          kind: 'dynamic-template', templateKey: 'user-title', instanceCount: 1, bboxStyle: 'abstract',
          instanceRegions: [{ x: 0.08, y: 0.032, width: 0.3, height: 0.007 }],
          fields: [{ key: 'user', label: '当前用户', elementType: 'text',
            instanceRegions: [{ x: 0.08, y: 0.032, width: 0.18, height: 0.007 }] }],
        },
      }),
      element('adjacent_action', '相邻操作', 'text-button', { x: 0.7, y: 0.032, width: 0.2, height: 0.007 }),
    ],
    relationships: [
      { fromCandidateKey: 'top_bar', type: 'contains', toCandidateKey: 'bar_title' },
    ],
  };

  const result = refineRecognitionGeometryWithSources(recognition, null, null, { width: 1000, height: 9000 });
  const navigation = result.elements.find((item) => item.candidateKey === 'top_bar');
  assert.deepEqual(roundedBox(navigation.approximateRegion), { x: 0, y: 0.01, width: 1, height: 0.015 });
  assert.deepEqual(result.relationships.filter((relation) => relation.type === 'contains'
    && relation.fromCandidateKey === 'top_bar').map((relation) => relation.toCandidateKey), ['bar_title']);
});

test('等面积动态父级按显式层级和稳定键选择且不受数组顺序影响', () => {
  const makeRecognition = (reversed = false) => {
    const elements = [
      element('outer', '外层', 'form', { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }),
      element('inner', '内层', 'section', { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }),
      element('value', '动态值', 'text', { x: 0.3, y: 0.3, width: 0.2, height: 0.05 }, {
        dynamicContent: true,
        abstraction: {
          kind: 'dynamic-template', templateKey: 'value', instanceCount: 1, bboxStyle: 'abstract',
          instanceRegions: [{ x: 0.3, y: 0.3, width: 0.2, height: 0.05 }],
          fields: [{ key: 'value', label: '动态值', elementType: 'text',
            instanceRegions: [{ x: 0.3, y: 0.3, width: 0.2, height: 0.05 }] }],
        },
      }),
    ];
    const relationships = [
      { fromCandidateKey: 'outer', type: 'contains', toCandidateKey: 'inner' },
      { fromCandidateKey: 'outer', type: 'contains', toCandidateKey: 'value' },
      { fromCandidateKey: 'inner', type: 'contains', toCandidateKey: 'value' },
    ];
    return {
      elements: reversed ? [...elements].reverse() : elements,
      relationships: reversed ? [...relationships].reverse() : relationships,
    };
  };
  const owner = (result) => result.relationships.find((relation) => relation.type === 'contains'
    && relation.toCandidateKey === 'value')?.fromCandidateKey;

  assert.equal(owner(refineRecognitionGeometryWithSources(makeRecognition(), null, null, { width: 1000, height: 1000 })), 'inner');
  assert.equal(owner(refineRecognitionGeometryWithSources(makeRecognition(true), null, null, { width: 1000, height: 1000 })), 'inner');
});

test('动态字段运行时落地后重新归属到更具体的直接容器', () => {
  const recognition = {
    elements: [
      element('outer', '外层', 'form', { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }),
      element('inner', '局部', 'section', { x: 0.48, y: 0.3, width: 0.25, height: 0.2 }),
      element('value', '动态值', 'text', { x: 0.4, y: 0.35, width: 0.08, height: 0.04 }, {
        dynamicContent: true,
        abstraction: {
          kind: 'dynamic-template', templateKey: 'value', instanceCount: 1, bboxStyle: 'abstract',
          instanceRegions: [{ x: 0.4, y: 0.35, width: 0.08, height: 0.04 }],
          fields: [{ key: 'value', label: '动态值', elementType: 'text', visibleTexts: ['已落地值'],
            instanceRegions: [{ x: 0.4, y: 0.35, width: 0.08, height: 0.04 }] }],
        },
      }),
    ],
    relationships: [
      { fromCandidateKey: 'outer', type: 'contains', toCandidateKey: 'inner' },
      { fromCandidateKey: 'outer', type: 'contains', toCandidateKey: 'value' },
    ],
  };
  const runtime = { hierarchy: {
    coordinateSpace: 'display_px', viewport: { width: 1000, height: 1000 }, root: {
      class: 'FrameLayout', children: [
        { class: 'TextView', text: '已落地值', bounds: { left: 500, top: 360, right: 580, bottom: 400 }, children: [] },
      ],
    },
  } };

  const result = refineRecognitionGeometryWithSources(recognition, runtime, null, { width: 1000, height: 1000 });
  const owners = result.relationships.filter((relation) => relation.type === 'contains'
    && relation.toCandidateKey === 'value').map((relation) => relation.fromCandidateKey);
  assert.deepEqual(owners, ['inner']);
  assert.deepEqual(roundedBox(result.elements.find((item) => item.candidateKey === 'value').approximateRegion), {
    x: 0.5, y: 0.36, width: 0.08, height: 0.04,
  });
});
