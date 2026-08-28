import assert from 'node:assert/strict';
import test from 'node:test';
import { captureDisplayMetrics, captureRuntimeHierarchy, groundRecognitionGeometry } from './runtime-hierarchy.mjs';

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
