import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recognizeScreenshotText } from './vision-ocr.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uikg-ocr-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const imagePath = path.join(root, 'frame.png');
  await writeFile(imagePath, 'fixture');
  return imagePath;
}

function paddleOutput(overrides = {}) {
  return `Paddle log\nUIKG_OCR_RESULT=${JSON.stringify({
    engine: 'paddleocr', coordinateSpace: 'screenshot_px', width: 100, height: 200,
    observations: [{ text: '设置', confidence: 0.91, rect: { x: 10, y: 20, width: 30, height: 15 } }],
    rectangles: [{ confidence: 0.88, rect: { x: 5, y: 15, width: 80, height: 60 } }],
    horizontalBands: [{ confidence: 0.9, rect: { x: 0, y: 100, width: 100, height: 5 } }],
    ...overrides,
  })}\n`;
}

test('auto 在非 macOS 平台调用 PaddleOCR 并规范化结果', async (t) => {
  const imagePath = await fixture(t);
  const calls = [];
  const result = await recognizeScreenshotText(imagePath, {
    platform: 'linux', pythonBinary: '/opt/ocr-python',
    execFile: async (binary, args) => {
      calls.push({ binary, args });
      return { stdout: paddleOutput() };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].binary, '/opt/ocr-python');
  assert.match(calls[0].args[0], /paddle-ocr\.py$/);
  assert.equal(result.status, 'complete');
  assert.equal(result.engine, 'paddleocr');
  assert.deepEqual(result.observations[0].rect, { x: 10, y: 20, width: 30, height: 15 });
  assert.deepEqual(result.rectangles[0].rect, { x: 5, y: 15, width: 80, height: 60 });
  assert.equal(result.separatorBands[0].orientation, 'horizontal');
  assert.deepEqual(result.separatorBands[0].rect, { x: 0, y: 100, width: 100, height: 5 });
  assert.deepEqual(result.horizontalBands[0].rect, { x: 0, y: 100, width: 100, height: 5 });
});

test('auto 在 macOS Vision 失败后回退 PaddleOCR', async (t) => {
  const imagePath = await fixture(t);
  const calls = [];
  const result = await recognizeScreenshotText(imagePath, {
    platform: 'darwin',
    execFile: async (binary) => {
      calls.push(binary);
      if (binary === '/usr/bin/swift') throw new Error('Vision unavailable');
      return { stdout: paddleOutput() };
    },
  });
  assert.deepEqual(calls, ['/usr/bin/swift', 'python3']);
  assert.equal(result.status, 'complete');
  assert.equal(result.engine, 'paddleocr');
});

test('disabled 不启动 OCR 子进程', async (t) => {
  const imagePath = await fixture(t);
  let called = false;
  const result = await recognizeScreenshotText(imagePath, {
    engine: 'disabled', platform: 'linux',
    execFile: async () => { called = true; },
  });
  assert.equal(called, false);
  assert.deepEqual(result, { status: 'unavailable', engine: null, observations: [], rectangles: [], separatorBands: [], horizontalBands: [] });
});

test('无效引擎返回可诊断的 unavailable 结果', async (t) => {
  const imagePath = await fixture(t);
  const result = await recognizeScreenshotText(imagePath, { engine: 'unknown', platform: 'linux' });
  assert.equal(result.status, 'unavailable');
  assert.match(result.error, /Unsupported UIKG_OCR_ENGINE/);
});
