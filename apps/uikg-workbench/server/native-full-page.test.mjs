import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { captureNativeFullPage } from './native-full-page.mjs';

async function frame(contentStart, contentHeight = 320) {
  const width = 100;
  const height = 200;
  const data = Buffer.alloc(width * height * 4);
  const pixel = (x, y) => {
    const index = (y * width + x) * 4;
    if (y < 20 || y >= 180) return [12, 18, 24, 255];
    const value = Math.max(0, Math.min(255, contentStart + (y - 20)));
    return [value, 80, 160, 255];
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set(pixel(x, y), (y * width + x) * 4);
  }
  const buffer = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return { buffer, width, height, contentHeight };
}

test('原生滚动截图按真实视口拼接并保留固定头尾', async () => {
  const initial = await frame(0);
  const moved60 = await frame(60);
  const moved120 = await frame(120);
  const sequence = [initial, initial, moved60, moved120, moved120, initial];
  let index = 0;
  let structureIndex = 0;
  const shellCalls = [];
  const hierarchy = {
    implementationType: 'native',
    viewport: { width: 100, height: 200 },
    root: {
      class: 'android.widget.FrameLayout',
      children: [{
        class: 'android.widget.ScrollView',
        resourceId: 'com.example:id/scroll',
        scrollable: true,
        bounds: { left: 0, top: 20, right: 100, bottom: 180 },
        children: [],
      }],
    },
  };
  const result = await captureNativeFullPage({
    interface: {
      async getAdb() {
        return { shell: async (command) => { shellCalls.push(command); } };
      },
    },
    async _snapshotContext() {
      const current = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      return { screenshot: { base64: `data:image/png;base64,${current.buffer.toString('base64')}` } };
    },
  }, hierarchy, initial, {
    settleDelayMs: 0,
    captureScreen: async () => sequence[Math.min(index++, sequence.length - 1)],
    captureChunk: async () => {
      const shift = Math.min(structureIndex++, 2) * 60;
      return { hierarchy: { root: { children: [
        { class: 'android.widget.TextView', resourceId: 'com.example:id/first', text: '第一项', bounds: { left: 10, top: 80 - shift, right: 80, bottom: 100 - shift }, children: [] },
        { class: 'android.widget.TextView', resourceId: 'com.example:id/second', text: '第二项', bounds: { left: 10, top: 130 - shift, right: 80, bottom: 150 - shift }, children: [] },
      ] } } };
    },
  });

  assert.equal(result.status, 'complete');
  assert.equal(result.capture.kind, 'native-full-page');
  assert.equal(result.capture.chunkCount, 3);
  assert.equal(result.capture.settleDelayMs, 0);
  assert.deepEqual(result.structureSnapshots.map((snapshot) => snapshot.scrollTop), [0, 60, 120]);
  const metadata = await sharp(result.image.buffer).metadata();
  assert.deepEqual({ width: metadata.width, height: metadata.height }, { width: 100, height: 320 });
  assert.ok(shellCalls.length >= 3, '应包含回顶和采集滚动段的手势');
});
