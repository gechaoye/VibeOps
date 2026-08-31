import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { stitchHybridFullPage } from './webview-full-page.mjs';

async function solid(width, height, background) {
  return sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
}

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
