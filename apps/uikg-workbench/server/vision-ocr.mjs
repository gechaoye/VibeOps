import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const serverRoot = path.dirname(fileURLToPath(import.meta.url));
const appleVisionScript = path.join(serverRoot, 'vision-ocr.swift');
const paddleOcrScript = path.join(serverRoot, 'paddle-ocr.py');
const paddleResultMarker = 'UIKG_OCR_RESULT=';
const cache = new Map();
const supportedEngines = new Set(['auto', 'apple-vision', 'paddleocr', 'disabled']);

function configuredTimeout(timeout) {
  const value = Number(timeout ?? process.env.UIKG_OCR_TIMEOUT_MS ?? 120_000);
  return Number.isFinite(value) && value > 0 ? value : 120_000;
}

function providerOrder(engine, platform) {
  if (engine === 'disabled') return [];
  if (engine === 'apple-vision') return platform === 'darwin' ? ['apple-vision'] : [];
  if (engine === 'paddleocr') return ['paddleocr'];
  return platform === 'darwin' ? ['apple-vision', 'paddleocr'] : ['paddleocr'];
}

function normalizeObservation(observation) {
  const rect = observation?.rect;
  const normalized = {
    text: String(observation?.text || '').trim(),
    confidence: Number(observation?.confidence),
    rect: {
      x: Number(rect?.x),
      y: Number(rect?.y),
      width: Number(rect?.width),
      height: Number(rect?.height),
    },
  };
  if (!normalized.text || !Number.isFinite(normalized.confidence)) return null;
  if (!Object.values(normalized.rect).every(Number.isFinite)) return null;
  if (normalized.rect.width <= 0 || normalized.rect.height <= 0) return null;
  normalized.confidence = Math.min(1, Math.max(0, normalized.confidence));
  return normalized;
}

function normalizeFragments(observation) {
  return (Array.isArray(observation?.fragments) ? observation.fragments : [])
    .map((fragment) => {
      const rect = fragment?.rect;
      const start = Number(fragment?.start);
      const end = Number(fragment?.end);
      if (!fragment?.text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
      if (!rect || !Object.values(rect).every((value) => Number.isFinite(Number(value)))) return null;
      return {
        text: String(fragment.text), start, end,
        rect: { x: Number(rect.x), y: Number(rect.y), width: Number(rect.width), height: Number(rect.height) },
      };
    }).filter(Boolean);
}

function normalizeRectangle(observation) {
  const normalized = normalizeObservation({ ...observation, text: 'rectangle' });
  return normalized ? { confidence: normalized.confidence, rect: normalized.rect } : null;
}

function normalizeHorizontalBand(observation) {
  return normalizeRectangle(observation);
}

function normalizeResult(parsed, fallbackEngine) {
  const rawSeparators = Array.isArray(parsed?.separatorBands)
    ? parsed.separatorBands
    : (Array.isArray(parsed?.horizontalBands) ? parsed.horizontalBands.map((band) => ({ ...band, orientation: 'horizontal' })) : []);
  const separatorBands = rawSeparators.map((observation) => {
    const normalized = normalizeRectangle(observation);
    return normalized ? { ...normalized, orientation: observation?.orientation === 'vertical' ? 'vertical' : 'horizontal' } : null;
  }).filter(Boolean);
  return {
    status: 'complete',
    engine: parsed?.engine || fallbackEngine,
    coordinateSpace: parsed?.coordinateSpace || 'screenshot_px',
    width: Number(parsed?.width) || null,
    height: Number(parsed?.height) || null,
    observations: (Array.isArray(parsed?.observations) ? parsed.observations : [])
      .map((observation) => {
        const normalized = normalizeObservation(observation);
        return normalized ? { ...normalized, fragments: normalizeFragments(observation) } : null;
      })
      .filter(Boolean),
    rectangles: (Array.isArray(parsed?.rectangles) ? parsed.rectangles : [])
      .map(normalizeRectangle)
      .filter(Boolean),
    separatorBands,
    // Kept as a compatibility alias for older stored OCR results.
    horizontalBands: separatorBands.filter((band) => band.orientation === 'horizontal'),
  };
}

function parsePaddleOutput(stdout) {
  const markerIndex = stdout.lastIndexOf(paddleResultMarker);
  if (markerIndex < 0) throw new Error('PaddleOCR did not emit a structured result');
  const payload = stdout.slice(markerIndex + paddleResultMarker.length).trim().split(/\r?\n/, 1)[0];
  return JSON.parse(payload);
}

async function runAppleVision(imagePath, { timeout, execute }) {
  const { stdout } = await execute('/usr/bin/swift', [appleVisionScript, imagePath], {
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8',
  });
  return normalizeResult(JSON.parse(stdout), 'apple-vision');
}

async function runPaddleOcr(imagePath, { timeout, execute, platform, pythonBinary }) {
  const binary = pythonBinary
    || process.env.UIKG_OCR_PYTHON
    || process.env.UIKG_WORKBENCH_PYTHON
    || (platform === 'win32' ? 'python' : 'python3');
  const { stdout } = await execute(binary, [paddleOcrScript, imagePath], {
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8',
    env: process.env,
  });
  return normalizeResult(parsePaddleOutput(stdout), 'paddleocr');
}

function unavailable(engine, errors = []) {
  return {
    status: 'unavailable',
    engine: engine === 'disabled' ? null : engine,
    observations: [],
    rectangles: [],
    separatorBands: [],
    horizontalBands: [],
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
  };
}

export async function recognizeScreenshotText(imagePath, options = {}) {
  const platform = options.platform || process.platform;
  const engine = String(options.engine || process.env.UIKG_OCR_ENGINE || 'auto').trim().toLowerCase();
  if (!supportedEngines.has(engine)) {
    return unavailable(engine, [`Unsupported UIKG_OCR_ENGINE: ${engine}`]);
  }
  if (!imagePath || engine === 'disabled') return unavailable(engine);

  const providers = providerOrder(engine, platform);
  if (providers.length === 0) {
    return unavailable(engine, [`${engine} is not available on ${platform}`]);
  }

  const cacheKey = `${engine}:${platform}:${options.pythonBinary || ''}:${imagePath}`;
  if (cache.has(cacheKey)) return structuredClone(cache.get(cacheKey));

  try {
    await access(imagePath);
  } catch (error) {
    return unavailable(engine, [String(error?.message || error)]);
  }

  const context = {
    timeout: configuredTimeout(options.timeout),
    execute: options.execFile || execFileAsync,
    platform,
    pythonBinary: options.pythonBinary,
  };
  const errors = [];
  for (const provider of providers) {
    try {
      const result = provider === 'apple-vision'
        ? await runAppleVision(imagePath, context)
        : await runPaddleOcr(imagePath, context);
      cache.set(cacheKey, result);
      return structuredClone(result);
    } catch (error) {
      errors.push(`${provider}: ${String(error?.stderr || error?.message || error).trim()}`);
    }
  }
  return unavailable(engine === 'auto' ? providers.at(-1) : engine, errors);
}
