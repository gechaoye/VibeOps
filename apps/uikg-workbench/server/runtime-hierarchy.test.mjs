import assert from 'node:assert/strict';
import test from 'node:test';
import { captureDisplayMetrics, captureRuntimeHierarchy, groundRecognitionGeometry, mergeRuntimeHierarchySnapshots } from './runtime-hierarchy.mjs';

const xml = `<?xml version="1.0"?><hierarchy><node class="android.widget.FrameLayout" package="com.example" bounds="[0,0][1440,3168]"><node class="android.widget.TextView" package="com.example" text="我的待办" bounds="[592,205][848,291]"/><node class="android.webkit.WebView" package="com.example" bounds="[0,336][1440,3168]"/></node></hierarchy>`;

test('采集 UIAutomator 层级时保留 display_px 坐标并识别 H5 Activity', async () => {
  const commands = [];
  const adb = {
    async shell(command) {
      commands.push(command);
      if (command[0] === 'dumpsys') return 'mCurrentFocus=Window{a u0 com.example/com.example.BHWebActivity}';
      if (command[0] === 'cat') return xml;
      return 'UI hierarchy dumped';
    },
  };
  const result = await captureRuntimeHierarchy({ interface: { getAdb: async () => adb } }, { width: 1440, height: 3168 });
  assert.equal(result.hierarchySource, 'uiautomator');
  assert.equal(result.implementationType, 'h5');
  assert.equal(result.activity, 'com.example.BHWebActivity');
  assert.deepEqual(result.viewport, { width: 1440, height: 3168 });
  assert.equal('dpr' in result, false);
  assert.equal(result.nodeCount, 3);
  assert.deepEqual(commands[1], ['uiautomator', 'dump', '/sdcard/vibeops-window.xml']);
});

test('显示指标优先读取当前 override 分辨率而不是固定物理分辨率', async () => {
  const adb = {
    async shell(command) {
      if (command[0] === 'dumpsys' && command[1] === 'display') {
        return 'mBaseDisplayInfo=DisplayInfo{real 1440 x 3168}\nmOverrideDisplayInfo=DisplayInfo{real 1080 x 2376, mode 5}';
      }
      if (command[0] === 'wm') return 'Physical density: 640\nOverride density: 480';
      if (command[0] === 'dumpsys' && command[1] === 'input') return 'SurfaceOrientation: 0';
      return '';
    },
  };
  const metrics = await captureDisplayMetrics({ interface: { getAdb: async () => adb } });
  assert.deepEqual(metrics && { width: metrics.width, height: metrics.height, density: metrics.density, rotation: metrics.rotation }, {
    width: 1080, height: 2376, density: 480, rotation: 0,
  });
});

test('运行时 bounds 直接按截图像素归一化，不重复应用 DPR 或状态栏偏移', () => {
  const recognition = {
    elements: [{
      candidateKey: 'header-title', label: '我的待办', elementType: 'static-label',
      approximateRegion: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
      geometryKind: 'approximate', geometryConfidence: 0.5,
      meaning: { evidence: { visibleTexts: ['我的待办'] } }, riskSignals: [],
    }],
  };
  const grounded = groundRecognitionGeometry(recognition, {
    hierarchy: {
      coordinateSpace: 'display_px', viewport: { width: 1440, height: 3168 },
      root: { class: 'FrameLayout', bounds: { left: 0, top: 0, right: 1440, bottom: 3168 }, children: [
        { class: 'TextView', text: '我的待办', bounds: { left: 592, top: 205, right: 848, bottom: 291 }, children: [] },
      ] },
    },
  });
  const box = grounded.elements[0].approximateRegion;
  assert.ok(Math.abs(box.x - 592 / 1440) < 1e-12);
  assert.ok(Math.abs(box.y - 205 / 3168) < 1e-12);
  assert.ok(Math.abs(box.width - 256 / 1440) < 1e-12);
  assert.ok(Math.abs(box.height - 86 / 3168) < 1e-12);
  assert.equal(grounded.elements[0].geometryKind, 'boundary');
  assert.ok(grounded.elements[0].riskSignals.includes('geometry-grounded-by-runtime'));
});

test('容器不会因子节点文本被错误吸附，resource-id 可精确定位容器', () => {
  const recognition = {
    elements: [
      {
        candidateKey: 'navigation', label: null, elementType: 'navigation-bar',
        approximateRegion: { x: 0, y: 0.05, width: 1, height: 0.06 }, geometryKind: 'boundary', geometryConfidence: 0.6,
        meaning: { evidence: { visibleTexts: ['我的待办'], visualCues: ['resource-id=com.example:id/navigation'] } }, riskSignals: [],
      },
      {
        candidateKey: 'title', label: '我的待办', elementType: 'title',
        approximateRegion: { x: 0.2, y: 0.06, width: 0.2, height: 0.03 }, geometryKind: 'approximate', geometryConfidence: 0.6,
        meaning: { evidence: { visibleTexts: ['我的待办'] } }, riskSignals: [],
      },
    ],
  };
  const grounded = groundRecognitionGeometry(recognition, {
    hierarchy: {
      coordinateSpace: 'display_px', viewport: { width: 100, height: 200 },
      root: { class: 'FrameLayout', bounds: { left: 0, top: 0, right: 100, bottom: 200 }, children: [
        { class: 'ViewGroup', resourceId: 'com.example:id/navigation', bounds: { left: 0, top: 10, right: 100, bottom: 40 }, children: [
          { class: 'TextView', text: '我的待办', bounds: { left: 20, top: 16, right: 50, bottom: 28 }, children: [] },
        ] },
      ] },
    },
  });
  assert.equal(grounded.elements[0].approximateRegion.x, 0);
  assert.ok(Math.abs(grounded.elements[0].approximateRegion.y - 10 / 200) < 1e-12);
  assert.ok(Math.abs(grounded.elements[0].approximateRegion.width - 1) < 1e-12);
  assert.ok(Math.abs(grounded.elements[0].approximateRegion.height - 30 / 200) < 1e-12);
  assert.ok(Math.abs(grounded.elements[1].approximateRegion.x - 20 / 100) < 1e-12);
  assert.ok(Math.abs(grounded.elements[1].approximateRegion.y - 16 / 200) < 1e-12);
  assert.ok(Math.abs(grounded.elements[1].approximateRegion.width - 30 / 100) < 1e-12);
  assert.ok(Math.abs(grounded.elements[1].approximateRegion.height - 12 / 200) < 1e-12);
});

test('滚动分段 UI Automation 坐标合并到整图并去重相邻分段节点', () => {
  const base = {
    coordinateSpace: 'display_px',
    viewport: { width: 100, height: 200 },
    root: { class: 'FrameLayout', bounds: { left: 0, top: 0, right: 100, bottom: 200 }, children: [
      { class: 'EditText', resourceId: 'field-1', bounds: { left: 10, top: 40, right: 90, bottom: 70 }, children: [] },
    ] },
  };
  const segment = (top) => ({ hierarchy: { root: { class: 'FrameLayout', children: [
    { class: 'EditText', resourceId: 'field-1', bounds: { left: 10, top: 40 - top, right: 90, bottom: 70 - top }, children: [] },
    { class: 'EditText', resourceId: `field-${top}`, bounds: { left: 10, top: 150, right: 90, bottom: 175 }, children: [] },
  ] } }, scrollTop: top });
  const merged = mergeRuntimeHierarchySnapshots(base, [segment(0), segment(20)], {
    webViewBounds: { left: 0, top: 20, right: 100, bottom: 180 },
    viewport: { width: 100, height: 500 },
    devicePixelRatio: 1,
    scrollClientHeightCss: 160,
  });
  const fields = [];
  const walk = (node) => { if (node.resourceId?.startsWith('field-')) fields.push(node); for (const child of node.children || []) walk(child); };
  walk(merged.root);
  assert.equal(merged.viewport.height, 500);
  assert.equal(fields.filter((node) => node.resourceId === 'field-1').length, 1);
  assert.ok(fields.some((node) => node.resourceId === 'field-20' && node.bounds.top === 170));
});

test('滚动分段同一节点先被裁剪后完整时恢复完整 bounds 且不合并重复行', () => {
  const base = {
    coordinateSpace: 'display_px',
    viewport: { width: 100, height: 200 },
    root: { class: 'FrameLayout', children: [] },
  };
  const merged = mergeRuntimeHierarchySnapshots(base, [
    { scrollTop: 0, hierarchy: { root: { class: 'FrameLayout', children: [
      { class: 'TextView', text: '提交时间', bounds: { left: 10, top: 150, right: 90, bottom: 180 }, children: [] },
    ] } } },
    { scrollTop: 40, hierarchy: { root: { class: 'FrameLayout', children: [
      { class: 'TextView', text: '提交时间', bounds: { left: 10, top: 110, right: 90, bottom: 150 }, children: [] },
      { class: 'TextView', text: '提交时间', bounds: { left: 10, top: 155, right: 90, bottom: 175 }, children: [] },
    ] } } },
  ], {
    webViewBounds: { left: 0, top: 20, right: 100, bottom: 180 },
    viewport: { width: 100, height: 500 },
    devicePixelRatio: 1,
    scrollClientHeightCss: 160,
  });

  const nodes = merged.root.children.filter((node) => node.text === '提交时间');
  assert.deepEqual(nodes.map((node) => node.bounds), [
    { left: 10, top: 150, right: 90, bottom: 190 },
    { left: 10, top: 195, right: 90, bottom: 215 },
  ]);
});

test('UI Automation 滚动偏移与长截图拼接使用同一 DPR', () => {
  const base = { viewport: { width: 100, height: 200 }, root: { children: [] } };
  const merged = mergeRuntimeHierarchySnapshots(base, [{ scrollTop: 100, hierarchy: { root: { children: [
    { class: 'EditText', bounds: { left: 10, top: 30, right: 90, bottom: 50 }, children: [] },
  ] } } }], {
    webViewBounds: { left: 0, top: 20, right: 100, bottom: 180 },
    viewport: { width: 100, height: 400 },
    devicePixelRatio: 3,
    scrollClientHeightCss: 80,
  });
  const node = merged.root.children[0];
  assert.equal(node.bounds.top, 330);
});

test('滚动结构合并识别固定节点并保持其视口坐标', () => {
  const make = (text, top) => ({ class: 'TextView', text, bounds: { left: 10, top, right: 90, bottom: top + 20 }, children: [] });
  const merged = mergeRuntimeHierarchySnapshots({
    coordinateSpace: 'display_px', viewport: { width: 100, height: 200 }, root: { children: [] },
  }, [
    { scrollTop: 0, hierarchy: { root: { children: [make('固定标题', 20), make('第一项', 100)] } } },
    { scrollTop: 60, hierarchy: { root: { children: [make('固定标题', 20), make('第一项', 40)] } } },
  ], { webViewBounds: { left: 0, top: 0, right: 100, bottom: 200 }, viewport: { width: 100, height: 400 }, devicePixelRatio: 1 });
  assert.equal(merged.fixedNodes.length, 1);
  assert.equal(merged.fixedNodes[0].text, '固定标题');
  assert.equal(merged.fixedNodes[0].bounds.top, 20);
  assert.equal(merged.fixedNodes[0].fixed, true);
});

test('固定判定排除滚动容器子树并识别滚动区外的固定控件', () => {
  const fixed = (className, resourceId, text, top) => ({
    class: className,
    resourceId,
    text,
    clickable: className.includes('Button'),
    bounds: { left: 0, top, right: 100, bottom: top + 20 },
    children: [],
  });
  const snapshot = (scrollTop) => ({
    scrollTop,
    hierarchy: { root: { class: 'FrameLayout', children: [
      fixed('TextView', 'header', '固定标题', 10),
      { class: 'ScrollView', resourceId: 'scroll', scrollable: true, bounds: { left: 0, top: 40, right: 100, bottom: 160 }, children: [
        { class: 'LinearLayout', resourceId: 'scroll-content', bounds: { left: 0, top: 40, right: 100, bottom: 160 }, children: [
          fixed('TextView', 'meeting-mode', '会议模式', 50),
        ] },
      ] },
      fixed('Button', 'footer', '开始会议', 180),
    ] } },
  });
  const merged = mergeRuntimeHierarchySnapshots({
    coordinateSpace: 'display_px',
    viewport: { width: 100, height: 200 },
    root: { class: 'FrameLayout', children: [
      fixed('TextView', 'header', '固定标题', 10),
      { class: 'ScrollView', resourceId: 'scroll', scrollable: true, bounds: { left: 0, top: 40, right: 100, bottom: 160 }, children: [] },
      fixed('Button', 'footer', '开始会议', 180),
    ] },
  }, [snapshot(0), snapshot(60)], {
    webViewBounds: { left: 0, top: 40, right: 100, bottom: 160 },
    fixedViewport: { left: 0, top: 0, right: 100, bottom: 200 },
    viewport: { width: 100, height: 400 },
    devicePixelRatio: 1,
  });
  assert.deepEqual(merged.fixedNodes.map((node) => node.resourceId).sort(), ['footer', 'header']);
  assert.equal(merged.fixedNodes.some((node) => node.resourceId === 'meeting-mode'), false);
});

test('滚动快照缺少容器节点时仍不会把其已知子树识别为固定', () => {
  const base = {
    coordinateSpace: 'display_px',
    viewport: { width: 100, height: 200 },
    root: { class: 'FrameLayout', children: [{
      class: 'ScrollView', resourceId: 'scroll', scrollable: true,
      bounds: { left: 0, top: 40, right: 100, bottom: 160 }, children: [{
        class: 'LinearLayout', resourceId: 'content', bounds: { left: 0, top: 40, right: 100, bottom: 160 }, children: [
          { class: 'TextView', resourceId: 'meeting-mode', text: '会议模式', bounds: { left: 10, top: 50, right: 90, bottom: 70 }, children: [] },
        ],
      }],
    }] },
  };
  const snapshot = (scrollTop, top) => ({ scrollTop, hierarchy: { root: { class: 'FrameLayout', children: [
    { class: 'TextView', resourceId: 'meeting-mode', text: '会议模式', bounds: { left: 10, top, right: 90, bottom: top + 20 }, children: [] },
  ] } } });
  const merged = mergeRuntimeHierarchySnapshots(base, [snapshot(0, 50), snapshot(60, 20)], {
    webViewBounds: { left: 0, top: 40, right: 100, bottom: 160 },
    fixedViewport: { left: 0, top: 0, right: 100, bottom: 200 },
    viewport: { width: 100, height: 400 },
    devicePixelRatio: 1,
  });
  assert.equal(merged.fixedNodes.some((node) => node.resourceId === 'meeting-mode'), false);
});
