import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { captureWebViewFullPage, stitchHybridFullPage } from './webview-full-page.mjs';
import { mapDomSnapshot, mergeDomSnapshots } from './webview-dom.mjs';

async function solid(width, height, background) {
  return sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
}

async function strips(width, strips) {
  const height = strips.reduce((total, strip) => total + strip.height, 0);
  return sharp({ create: { width, height, channels: 4, background: '#ffffff' } })
    .composite(await Promise.all(strips.map(async (strip, index) => ({
      input: await solid(width, strip.height, strip.background),
      left: 0,
      top: strips.slice(0, index).reduce((total, item) => total + item.height, 0),
    }))))
    .png()
    .toBuffer();
}

test('非 debug 包在 CDP 截图前快速降级，不等待 Page.captureScreenshot', async () => {
  const result = await captureWebViewFullPage({
    interface: {
      async getAdb() {
        return { shell: async () => 'pkgFlags=[ HAS_CODE ALLOW_BACKUP ]' };
      },
    },
  }, {
    packageName: 'com.example.release',
    viewport: { width: 100, height: 200 },
    root: { class: 'android.webkit.WebView', bounds: { left: 0, top: 20, right: 100, bottom: 180 }, children: [] },
  }, { buffer: Buffer.alloc(0) });
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /不是 debug 包/);
});

test('整页拼接保留原生头尾，并按 scrollTop 连续拼接 WebView 分段', async () => {
  const result = await stitchHybridFullPage({
    nativeBuffer: await solid(100, 200, '#00ff00'),
    chunks: [
      { buffer: await solid(100, 200, '#ff0000'), scrollTop: 0, clientHeight: 160, rect: { x: 0, y: 20, width: 100, height: 160 } },
      { buffer: await solid(100, 200, '#0000ff'), scrollTop: 160, clientHeight: 160, rect: { x: 0, y: 20, width: 100, height: 160 } },
    ],
    webViewBounds: { left: 0, top: 20, right: 100, bottom: 180 },
    deviceViewport: { width: 100, height: 200 },
    scrollHeightCss: 300,
    devicePixelRatio: 1,
  });

  const image = sharp(result);
  const metadata = await image.metadata();
  assert.deepEqual({ width: metadata.width, height: metadata.height }, { width: 100, height: 340 });
  const { data } = await image.raw().toBuffer({ resolveWithObject: true });
  const pixel = (x, y) => [...data.subarray((y * 100 + x) * 4, (y * 100 + x) * 4 + 4)];
  assert.deepEqual(pixel(50, 10), [0, 255, 0, 255]);
  assert.deepEqual(pixel(50, 20), [255, 0, 0, 255]);
  assert.deepEqual(pixel(50, 179), [255, 0, 0, 255]);
  assert.deepEqual(pixel(50, 180), [0, 0, 255, 255]);
  assert.deepEqual(pixel(50, 319), [0, 0, 255, 255]);
  assert.deepEqual(pixel(50, 330), [0, 255, 0, 255]);
});

test('整页拼接保留滚动容器下方的固定提交栏', async () => {
  const result = await stitchHybridFullPage({
    nativeBuffer: await solid(100, 200, '#00ff00'),
    chunks: [
      { buffer: await strips(100, [{ height: 140, background: '#ff0000' }, { height: 20, background: '#ffff00' }]), scrollTop: 0, clientHeight: 140, rect: { x: 0, y: 0, width: 100, height: 140 } },
      { buffer: await strips(100, [{ height: 140, background: '#0000ff' }, { height: 20, background: '#00ffff' }]), scrollTop: 60, clientHeight: 140, rect: { x: 0, y: 0, width: 100, height: 140 } },
    ],
    webViewBounds: { left: 0, top: 20, right: 100, bottom: 180 },
    deviceViewport: { width: 100, height: 200 },
    scrollHeightCss: 200,
    devicePixelRatio: 1,
  });

  const image = sharp(result);
  const metadata = await image.metadata();
  assert.deepEqual({ width: metadata.width, height: metadata.height }, { width: 100, height: 260 });
  const { data } = await image.raw().toBuffer({ resolveWithObject: true });
  const pixel = (y) => [...data.subarray((y * 100 + 50) * 4, (y * 100 + 50) * 4 + 4)];
  assert.deepEqual(pixel(20), [255, 0, 0, 255]);
  assert.deepEqual(pixel(159), [0, 0, 255, 255]);
  assert.deepEqual(pixel(220), [0, 255, 255, 255]);
  assert.deepEqual(pixel(245), [0, 255, 0, 255]);
});

test('DOM 分段按滚动偏移合并到整图，并去重重叠节点', () => {
  const document = (top, id) => ({
    url: 'https://example.test/form',
    viewport: { width: 100, height: 160 },
    nodes: [{ tag: 'input', id, interactive: true, rect: { x: 10, y: 0, width: 30, height: 20 }, bounds: { left: 10, top, right: 40, bottom: top + 20 } }],
  });
  const merged = mergeDomSnapshots({ status: 'complete', documents: [document(20, 'first')] }, [
    { scrollTop: 0, dom: document(20, 'first') },
    { scrollTop: 100, dom: document(20, 'second') },
  ], { webViewBounds: { left: 0, top: 20, right: 100, bottom: 180 }, viewport: { width: 100, height: 400 }, devicePixelRatio: 1 });
  const nodes = merged.documents[0].nodes;
  assert.equal(nodes.filter((node) => node.id === 'first').length, 1);
  assert.equal(nodes.find((node) => node.id === 'second').bounds.top, 120);
  assert.equal(merged.documents[0].displayViewport.height, 400);
});

test('DOM CSS 坐标按页面 DPR 映射而不是 WebView 可见高度反推', () => {
  const mapped = mapDomSnapshot({
    viewport: { width: 384, height: 708, scale: 1, devicePixelRatio: 3 },
    nodes: [{ tag: 'div', text: '测试日志规则0413', rect: { x: 49.38, y: 1611.5625, width: 272.44, height: 24.57 } }],
  }, { left: 0, top: 252, right: 1152, bottom: 2256 }, { width: 1152, height: 2376 });
  assert.ok(Math.abs(mapped.nodes[0].bounds.top - 5086.6875) < 0.001);
  assert.ok(Math.abs(mapped.nodes[0].bounds.bottom - 5160.3975) < 0.01);
});

test('DOM 固定节点在长页面合并后保持视口位置', () => {
  const base = { status: 'complete', documents: [{ viewport: { width: 100, height: 160, devicePixelRatio: 1 }, nodes: [] }] };
  const fixed = (top) => ({ tag: 'div', role: 'banner', text: '固定提交栏', fixed: true, bounds: { left: 0, top, right: 100, bottom: top + 20 } });
  const merged = mergeDomSnapshots(base, [
    { scrollTop: 0, dom: { viewport: { width: 100, height: 160, devicePixelRatio: 1 }, nodes: [fixed(120)] } },
    { scrollTop: 80, dom: { viewport: { width: 100, height: 160, devicePixelRatio: 1 }, nodes: [fixed(120)] } },
  ], { webViewBounds: { left: 0, top: 0, right: 100, bottom: 160 }, viewport: { width: 100, height: 400 } });
  assert.equal(merged.fixedNodes.length, 1);
  assert.equal(merged.documents[0].nodes.filter((node) => node.text === '固定提交栏').length, 1);
  assert.equal(merged.fixedNodes[0].bounds.top, 120);
});
