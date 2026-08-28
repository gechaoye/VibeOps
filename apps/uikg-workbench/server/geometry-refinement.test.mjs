import assert from 'node:assert/strict';
import test from 'node:test';
import { refineRecognitionGeometryWithSources } from './geometry-refinement.mjs';

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
