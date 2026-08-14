#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_GRAPH_ROOT = resolve(SCRIPT_DIR, '..');
const APP_ROOT = join(KNOWLEDGE_GRAPH_ROOT, 'apps', 'zto.connect');
const SESSION_ID = '01KY6YECXXQRGNZC5S1MWPRYCX';
const RUNTIME_ROOT = join(
  KNOWLEDGE_GRAPH_ROOT,
  'runtime',
  'zto.connect',
  SESSION_ID,
);
const EXPLORATION_ROOT = join(
  KNOWLEDGE_GRAPH_ROOT,
  'explorations',
  'zto-connect-fat-8.58.0-first-level-20260723',
);
const OBSIDIAN_ROOT = join(KNOWLEDGE_GRAPH_ROOT, 'obsidian', 'zto.connect');
const PROJECTION_MANIFEST_PATH = join(OBSIDIAN_ROOT, 'projection-manifest.json');
const CANONICAL_MANIFEST_PATH = join(APP_ROOT, 'manifest.yaml');
const RUNTIME_MANIFEST_PATH = join(RUNTIME_ROOT, 'manifest.yaml');
const YAML_LIBRARY_PATH = join(SCRIPT_DIR, 'vendor', 'js-yaml-4.1.1.js');
const YAML_LICENSE_PATH = join(SCRIPT_DIR, 'vendor', 'js-yaml-4.1.1.LICENSE');
const YAML_LIBRARY_SHA256 = '283c7386b83e9155de96c51519a4b318bad3b5aaf2ddf3d240d5938193b8187f';
const YAML_LICENSE_SHA256 = 'a07bc24468b9654ce76a547d47a2db282d07733b715db4c73a98bd63961f9550';

const SCHEMA_VERSION = '2.0.0';
const MANIFEST_VERSION = 2;
const GRAPH_REVISION = '01KY9548Z070C4WJ7CTRYZRSTH';
const APPLICATION_KEY = 'zto.connect';
const EXPECTED_ACTIVITY = 'com.zto.zbox.module.main.ZBoxMainActivity';
const EXPECTED_BUILD = Object.freeze({
  platform: 'android',
  packageId: 'com.zto.connect.fat',
  versionName: '8.58.0.10542',
  versionCode: '10542',
  buildId: 'android-package:com.zto.connect.fat@10542',
  channel: 'test',
});
const SCREEN = Object.freeze({ width: 1152, height: 2376 });
const PHYSICAL_SCREEN = Object.freeze({ width: 1344, height: 2772 });
const RFC3339_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const OBSERVATION_TYPES = new Set([
  'summary',
  'classification',
  'relation',
  'risk',
  'anomaly',
  'element_candidate',
]);
const EXPECTED_PAGE_KEYS = new Set([
  'workbench.root',
  'messages.root',
  'contacts.root',
  'news.root',
  'app-drawer.root',
]);
const PAGE_TITLES = Object.freeze({
  'workbench.root': '工作台',
  'messages.root': '消息',
  'contacts.root': '通讯录',
  'news.root': '资讯',
  'app-drawer.root': '更多应用抽屉',
});
const BOTTOM_NAVIGATION_KEY = 'shared.bottom_navigation';
const EXPECTED_BOTTOM_TAB_KEYS = Object.freeze([
  'shared.bottom_tab.workbench',
  'shared.bottom_tab.messages',
  'shared.bottom_tab.contacts',
  'shared.bottom_tab.news',
  'shared.bottom_tab.more',
]);
const EXPECTED_SHARED_NAVIGATION_KEYS = new Set([
  BOTTOM_NAVIGATION_KEY,
  ...EXPECTED_BOTTOM_TAB_KEYS,
]);
const EXPECTED_BADGES = new Map([
  ['shared.bottom_tab.workbench', { count: 6, value: { kind: 'text', text: '99+', semanticMeaning: 'unknown' } }],
  ['shared.bottom_tab.messages', { count: 6, value: { kind: 'text', text: '99+', semanticMeaning: 'unknown' } }],
  ['shared.bottom_tab.more', { count: 6, value: { kind: 'dot', text: null, semanticMeaning: 'unknown' } }],
  ['shared.app_drawer.todos', { count: 1, value: { kind: 'text', text: '19', semanticMeaning: 'unknown' } }],
]);
const EXPECTED_LAYOUT_COUNTS = [6, 6, 6, 6, 22, 6];
const EXTENSION_NAMESPACE_PATTERN = /^(?:[a-z0-9][a-z0-9-]*\.){2,}[A-Za-z][A-Za-z0-9._-]*$/;
const EXPECTED_NAVIGATION_TOPOLOGY_FILE = '一级底部导航路网.md';

const require = createRequire(import.meta.url);
const failures = [];
const groupResults = [];
let currentGroup = 'initialization';

function fail(message) {
  failures.push({ group: currentGroup, message });
}

function ensure(condition, message) {
  if (!condition) fail(message);
  return Boolean(condition);
}

function group(name, callback) {
  currentGroup = name;
  const before = failures.length;
  try {
    callback();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const issueCount = failures.length - before;
  groupResults.push({ name, issueCount });
  const status = issueCount === 0 ? 'PASS' : 'FAIL';
  const suffix = issueCount === 0 ? '' : ` (${issueCount} issue(s))`;
  const output = `[${status}] ${name}${suffix}`;
  if (issueCount === 0) console.log(output);
  else console.error(output);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizePath(path) {
  return path.split(sep).join('/');
}

function graphRelative(path) {
  return normalizePath(relative(KNOWLEDGE_GRAPH_ROOT, path));
}

function listFiles(root, predicate = () => true) {
  if (!existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '__pycache__') {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && predicate(path)) files.push(path);
    }
  }
  return files.sort();
}

function walk(value, visitor, path = []) {
  visitor(value, path);
  if (Array.isArray(value)) {
    value.forEach((child, index) => walk(child, visitor, [...path, index]));
  } else if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      walk(child, visitor, [...path, key]);
    }
  }
}

function sortedValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortedValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortedValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(sortedValue(value));
}

function sameValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function setEquals(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function describeSetDifference(actual, expected) {
  const missing = [...expected].filter((value) => !actual.has(value));
  const unexpected = [...actual].filter((value) => !expected.has(value));
  return [
    missing.length > 0 ? `missing=${missing.join(', ')}` : '',
    unexpected.length > 0 ? `unexpected=${unexpected.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ');
}

function ensureSetEquals(actualValues, expectedValues, message) {
  const actual = actualValues instanceof Set ? actualValues : new Set(actualValues);
  const expected = expectedValues instanceof Set ? expectedValues : new Set(expectedValues);
  return ensure(
    setEquals(actual, expected),
    `${message}${describeSetDifference(actual, expected) ? `: ${describeSetDifference(actual, expected)}` : ''}`,
  );
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function expectedContentHash(record) {
  const { contentHash: _contentHash, ...body } = record;
  return `sha256:${digest(canonicalJson(body))}`;
}

function descriptorRootHash(manifest) {
  const descriptors = [
    ...(manifest.entries ?? []).map(
      (entry) => `entry:${entry.path}:${String(entry.sha256).toLowerCase()}\n`,
    ),
    ...(manifest.resources ?? []).map(
      (resource) =>
        `resource:${String(resource.sha256).toLowerCase()}:${resource.byteLength}:${resource.mediaType}\n`,
    ),
  ]
    .map((line) => Buffer.from(line, 'utf8'))
    .sort(Buffer.compare);
  return `sha256:${digest(Buffer.concat(descriptors))}`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readJsonLines(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${graphRelative(path)}:${index + 1}: ${error.message}`);
      }
    });
}

function loadYamlLibrary() {
  if (!existsSync(YAML_LIBRARY_PATH) || !existsSync(YAML_LICENSE_PATH)) {
    throw new Error('Vendored js-yaml 4.1.1 distribution or license is missing');
  }
  if (
    sha256(YAML_LIBRARY_PATH) !== YAML_LIBRARY_SHA256 ||
    sha256(YAML_LICENSE_PATH) !== YAML_LICENSE_SHA256
  ) {
    throw new Error('Vendored js-yaml 4.1.1 distribution or license has an unexpected SHA-256');
  }
  const library = require(YAML_LIBRARY_PATH);
  if (typeof library.loadAll !== 'function') {
    throw new Error('Vendored js-yaml 4.1.1 does not expose loadAll');
  }
  return library;
}

function findYamlAnchorAliasTokens(source) {
  const tokens = [];
  let quote = null;
  let blockScalarParentIndent = null;
  const lines = source.split(/\r?\n/);

  lines.forEach((line, lineIndex) => {
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (blockScalarParentIndent !== null) {
      if (line.trim().length === 0 || indent > blockScalarParentIndent) return;
      blockScalarParentIndent = null;
    }

    let code = '';
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (quote === "'") {
        if (character === "'" && line[index + 1] === "'") {
          code += '  ';
          index += 1;
        } else {
          if (character === "'") quote = null;
          code += ' ';
        }
        continue;
      }
      if (quote === '"') {
        if (character === '\\' && index + 1 < line.length) {
          code += '  ';
          index += 1;
        } else {
          if (character === '"') quote = null;
          code += ' ';
        }
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        code += ' ';
        continue;
      }
      if (character === '#' && (index === 0 || /\s/.test(line[index - 1]))) break;
      code += character;
    }

    const trimmed = code.trimEnd();
    if (/(?:^|[:\-]\s*)[>|](?:[1-9][+-]?|[+-][1-9]?)?$/.test(trimmed)) {
      blockScalarParentIndent = indent;
    }
    const tokenPattern = /(^|[\s,\[\]{}:?\-])([&*])([^\s,\[\]{}]+)/g;
    for (const match of code.matchAll(tokenPattern)) {
      const column = match.index + match[1].length + 1;
      tokens.push(`${match[2] === '&' ? 'anchor' : 'alias'} ${match[2]}${match[3]} at ${lineIndex + 1}:${column}`);
    }
  });
  return tokens;
}

function readYamlDocuments(yaml, path) {
  const documents = [];
  yaml.loadAll(readFileSync(path, 'utf8'), (document) => {
    if (document !== undefined && document !== null) documents.push(document);
  });
  return documents;
}

function loadYamlRecords(yaml, root, excludedPaths = new Set()) {
  const records = [];
  for (const file of listFiles(root, (path) => /\.ya?ml$/i.test(path))) {
    if (excludedPaths.has(file)) continue;
    const documents = readYamlDocuments(yaml, file);
    documents.forEach((value, documentIndex) =>
      records.push({ file, documentIndex, value }),
    );
  }
  return records;
}

function recordType(record) {
  return String(record?.entityType ?? record?.recordType ?? '');
}

function recordsByType(records, type) {
  return records.filter(({ value }) => recordType(value) === type).map(({ value }) => value);
}

function indexBy(records, keyName) {
  const result = new Map();
  for (const record of records) {
    const key = record?.[keyName];
    if (typeof key !== 'string' || key.length === 0) continue;
    result.set(key, record);
  }
  return result;
}

function validateUniqueIndex(records, index, keyName, label) {
  ensure(
    index.size === records.length,
    `${label} records must each have a unique non-empty ${keyName}`,
  );
}

function appBuildIsExact(appBuild) {
  return sameValue(appBuild, EXPECTED_BUILD);
}

function validateAppBuild(appBuild, label) {
  ensure(
    appBuildIsExact(appBuild),
    `${label} must embed the exact AppBuildContext ${canonicalJson(EXPECTED_BUILD)}`,
  );
}

function validConfidence(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function normalizedTimestamp(value) {
  const date = typeof value === 'string' ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function isRfc3339Utc(value) {
  return (
    typeof value === 'string' &&
    RFC3339_UTC_PATTERN.test(value) &&
    normalizedTimestamp(value) !== null
  );
}

function ulidTimestampMs(value) {
  if (typeof value !== 'string' || !ULID_PATTERN.test(value)) return null;
  let timestamp = 0;
  for (const character of value.slice(0, 10)) {
    timestamp = timestamp * 32 + CROCKFORD.indexOf(character);
  }
  return timestamp;
}

function ensureUlidNotAfter(value, timestamp, label) {
  const idTime = ulidTimestampMs(value);
  const recordedTime = normalizedTimestamp(timestamp);
  if (idTime === null || recordedTime === null) return;
  ensure(idTime <= new Date(recordedTime).getTime(), `${label} ULID timestamp is later than its record timestamp`);
}

function validateObservedAt(value, expectedValue, label) {
  ensure(
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value),
    `${label} must be an RFC 3339 UTC timestamp with millisecond precision`,
  );
  const actual = normalizedTimestamp(value);
  const expected = normalizedTimestamp(expectedValue);
  ensure(Boolean(actual), `${label} is not a valid timestamp`);
  ensure(Boolean(expected) && actual === expected, `${label} must equal its source Frame capturedAt`);
}

function applyMatrix3x3(matrix, point) {
  if (!Array.isArray(matrix) || matrix.length !== 9) return null;
  if (!matrix.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  if (Math.abs(denominator) < 1e-12) return null;
  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator,
  };
}

function approximatelyEqual(left, right, tolerance = 1e-9) {
  return typeof left === 'number' && typeof right === 'number' && Math.abs(left - right) <= tolerance;
}

function validHalfOpenRect(rect, bounds = SCREEN) {
  return (
    isPlainObject(rect) &&
    [rect.x, rect.y, rect.width, rect.height].every(Number.isInteger) &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x + rect.width <= bounds.width &&
    rect.y + rect.height <= bounds.height
  );
}

function rectContains(outer, inner) {
  return (
    isPlainObject(outer) &&
    isPlainObject(inner) &&
    [outer.x, outer.y, outer.width, outer.height, inner.x, inner.y, inner.width, inner.height]
      .every((value) => typeof value === 'number' && Number.isFinite(value)) &&
    outer.width > 0 &&
    outer.height > 0 &&
    inner.width > 0 &&
    inner.height > 0 &&
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function valueAtPath(root, path) {
  if (typeof path !== 'string' || path.length === 0) return undefined;
  return path.split('.').reduce(
    (value, segment) => (value === null || value === undefined ? undefined : value[segment]),
    root,
  );
}

function layoutSatisfiesTransitionState(layout, pageInstance, transitionState) {
  if (!layout || !pageInstance || !transitionState) return false;
  if (
    layout.pageRef !== transitionState.pageRef ||
    pageInstance.pageRef !== transitionState.pageRef ||
    pageInstance.state?.key !== transitionState.stateSelector?.stateKey
  ) {
    return false;
  }
  const snapshot = { snapshot: layout };
  return (transitionState.predicates ?? []).every((predicate) => {
    const actual = valueAtPath(snapshot, predicate?.path);
    if (actual === undefined || actual === null || actual === 'unknown') return false;
    if (predicate?.op === 'eq') return sameValue(actual, predicate.value);
    if (predicate?.op === 'ne') return !sameValue(actual, predicate.value);
    return false;
  });
}

function exactCenter(rect) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function pointInHalfOpenRect(point, rect) {
  return (
    isPlainObject(point) &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    validHalfOpenRect(rect) &&
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  );
}

function expectedRenderedRect(bbox) {
  return { ...bbox, space: 'screenshot_px' };
}

function pngHeader(path) {
  const bytes = readFileSync(path);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    bytes.length < 29 ||
    !bytes.subarray(0, 8).equals(signature) ||
    bytes.subarray(12, 16).toString('ascii') !== 'IHDR'
  ) {
    throw new Error(`${graphRelative(path)} is not a valid PNG`);
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
    interlace: bytes[28],
  };
}

function paethPredictor(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}

function decodePngRgb(path) {
  const bytes = readFileSync(path);
  const header = pngHeader(path);
  if (
    header.bitDepth !== 8 ||
    ![2, 6].includes(header.colorType) ||
    header.interlace !== 0
  ) {
    throw new Error(
      `${graphRelative(path)} uses unsupported PNG encoding ` +
        `(bitDepth=${header.bitDepth}, colorType=${header.colorType}, interlace=${header.interlace})`,
    );
  }

  const idatChunks = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) throw new Error(`${graphRelative(path)} has a truncated PNG chunk`);
    if (type === 'IDAT') idatChunks.push(bytes.subarray(dataStart, dataEnd));
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  if (idatChunks.length === 0) throw new Error(`${graphRelative(path)} has no IDAT data`);

  const channels = header.colorType === 2 ? 3 : 4;
  const stride = header.width * channels;
  const inflated = inflateSync(Buffer.concat(idatChunks));
  const expectedLength = header.height * (stride + 1);
  if (inflated.length !== expectedLength) {
    throw new Error(
      `${graphRelative(path)} has unexpected decompressed size ${inflated.length}; expected ${expectedLength}`,
    );
  }

  const unfiltered = Buffer.allocUnsafe(header.height * stride);
  let sourceOffset = 0;
  for (let y = 0; y < header.height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    const rowOffset = y * stride;
    const previousOffset = rowOffset - stride;
    for (let x = 0; x < stride; x += 1) {
      const encoded = inflated[sourceOffset + x];
      const left = x >= channels ? unfiltered[rowOffset + x - channels] : 0;
      const up = y > 0 ? unfiltered[previousOffset + x] : 0;
      const upperLeft = y > 0 && x >= channels
        ? unfiltered[previousOffset + x - channels]
        : 0;
      let predictor;
      if (filter === 0) predictor = 0;
      else if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paethPredictor(left, up, upperLeft);
      else throw new Error(`${graphRelative(path)} uses unknown PNG filter ${filter}`);
      unfiltered[rowOffset + x] = (encoded + predictor) & 0xff;
    }
    sourceOffset += stride;
  }

  if (channels === 3) return { ...header, pixels: unfiltered };
  const rgb = Buffer.allocUnsafe(header.width * header.height * 3);
  for (let source = 0, target = 0; source < unfiltered.length; source += 4, target += 3) {
    rgb[target] = unfiltered[source];
    rgb[target + 1] = unfiltered[source + 1];
    rgb[target + 2] = unfiltered[source + 2];
  }
  return { ...header, pixels: rgb };
}

function pixelIsInsideStroke(x, y, rect, width) {
  if (
    x < rect.x ||
    y < rect.y ||
    x >= rect.x + rect.width ||
    y >= rect.y + rect.height
  ) {
    return false;
  }
  return (
    x - rect.x < width ||
    y - rect.y < width ||
    rect.x + rect.width - 1 - x < width ||
    rect.y + rect.height - 1 - y < width
  );
}

const sourcePngCache = new Map();

function validateRedOverlay(sourcePath, annotatedPath, renderedRect, strokeWidth) {
  let source = sourcePngCache.get(sourcePath);
  if (!source) {
    source = decodePngRgb(sourcePath);
    sourcePngCache.set(sourcePath, source);
  }
  const annotated = decodePngRgb(annotatedPath);
  if (source.width !== annotated.width || source.height !== annotated.height) {
    throw new Error('annotated PNG dimensions differ from its source screenshot');
  }

  let changedToRed = 0;
  let unexpectedChanges = 0;
  for (let offset = 0, pixel = 0; offset < source.pixels.length; offset += 3, pixel += 1) {
    const unchanged =
      source.pixels[offset] === annotated.pixels[offset] &&
      source.pixels[offset + 1] === annotated.pixels[offset + 1] &&
      source.pixels[offset + 2] === annotated.pixels[offset + 2];
    if (unchanged) continue;
    const x = pixel % source.width;
    const y = Math.floor(pixel / source.width);
    const changedToExactRed =
      annotated.pixels[offset] === 255 &&
      annotated.pixels[offset + 1] === 0 &&
      annotated.pixels[offset + 2] === 0;
    if (changedToExactRed && pixelIsInsideStroke(x, y, renderedRect, strokeWidth)) {
      changedToRed += 1;
    } else {
      unexpectedChanges += 1;
    }
  }
  return { changedToRed, unexpectedChanges };
}

function parseFrontmatter(yaml, path) {
  const text = readFileSync(path, 'utf8');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`${graphRelative(path)} has no YAML frontmatter`);
  return { data: yaml.load(match[1]) ?? {}, text };
}

function resolveProjectionPath(pathValue) {
  const resolved = resolve(OBSIDIAN_ROOT, String(pathValue ?? ''));
  if (resolved !== OBSIDIAN_ROOT && !resolved.startsWith(`${OBSIDIAN_ROOT}${sep}`)) return null;
  return resolved;
}

function resolveReferencedFile(sourceFile, pathValue) {
  if (typeof pathValue !== 'string' || pathValue.trim() === '') return null;
  const clean = pathValue.trim().replace(/^file:/, '').split('#', 1)[0];
  const candidates = [
    resolve(dirname(sourceFile), clean),
    resolve(KNOWLEDGE_GRAPH_ROOT, clean.replace(/^[/\\]+/, '')),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

let yaml;
let canonicalRecords = [];
let runtimeRecords = [];
let canonicalManifest = null;
let runtimeManifest = null;
let projectionManifest = null;
let evidenceManifest = null;
let evidenceResources = [];
let evidenceSession = null;
let evidenceFrames = [];
let evidenceActions = [];
let evidenceObservations = [];
let markdownFiles = [];
const frontmatterByFile = new Map();

group('Artifact loading and UIKG 2.0 schema', () => {
  yaml = loadYamlLibrary();
  ensure(existsSync(APP_ROOT), 'Canonical app root is missing');
  ensure(existsSync(RUNTIME_ROOT), 'Runtime session root is missing');
  ensure(existsSync(EXPLORATION_ROOT), 'Immutable exploration package is missing');
  ensure(existsSync(OBSIDIAN_ROOT), 'Obsidian projection root is missing');

  canonicalRecords = loadYamlRecords(yaml, APP_ROOT, new Set([CANONICAL_MANIFEST_PATH]));
  runtimeRecords = loadYamlRecords(yaml, RUNTIME_ROOT, new Set([RUNTIME_MANIFEST_PATH]));
  canonicalManifest = readYamlDocuments(yaml, CANONICAL_MANIFEST_PATH)[0] ?? null;
  runtimeManifest = readYamlDocuments(yaml, RUNTIME_MANIFEST_PATH)[0] ?? null;
  projectionManifest = readJson(PROJECTION_MANIFEST_PATH);

  const evidenceManifestPath = join(EXPLORATION_ROOT, 'evidence', 'manifest.json');
  const resourceIndexPath = join(EXPLORATION_ROOT, 'resources', 'index.jsonl');
  evidenceManifest = readJson(evidenceManifestPath);
  evidenceResources = readJsonLines(resourceIndexPath);
  const evidenceSessionRoot = join(
    EXPLORATION_ROOT,
    'evidence',
    'sessions',
    SESSION_ID,
  );
  evidenceSession = readJson(join(evidenceSessionRoot, 'session.json'));
  evidenceFrames = readJsonLines(join(evidenceSessionRoot, 'frames.jsonl'));
  evidenceActions = readJsonLines(join(evidenceSessionRoot, 'action-traces.jsonl'));
  evidenceObservations = readJsonLines(join(evidenceSessionRoot, 'observations.jsonl'));

  for (const { file, documentIndex, value } of [...canonicalRecords, ...runtimeRecords]) {
    ensure(
      value?.schemaVersion === SCHEMA_VERSION,
      `${graphRelative(file)} document ${documentIndex + 1} must use schemaVersion ${SCHEMA_VERSION}`,
    );
  }
  for (const [label, manifest] of [
    ['Canonical manifest', canonicalManifest],
    ['Runtime manifest', runtimeManifest],
    ['Projection manifest', projectionManifest],
  ]) {
    ensure(manifest?.schemaVersion === SCHEMA_VERSION, `${label} must use schemaVersion ${SCHEMA_VERSION}`);
    ensure(manifest?.manifestVersion === MANIFEST_VERSION, `${label} must use manifestVersion ${MANIFEST_VERSION}`);
  }
});

const applications = recordsByType(canonicalRecords, 'Application');
const pages = recordsByType(canonicalRecords, 'Page');
const elements = recordsByType(canonicalRecords, 'Element');
const navigationScopes = recordsByType(canonicalRecords, 'NavigationScope');
const transitions = recordsByType(canonicalRecords, 'Transition');
const observations = recordsByType(canonicalRecords, 'Observation');
const captureSessions = recordsByType(runtimeRecords, 'CaptureSession');
const devices = recordsByType(runtimeRecords, 'DeviceSnapshot');
const layouts = recordsByType(runtimeRecords, 'LayoutSnapshot');
const actionTraces = recordsByType(runtimeRecords, 'ActionTrace');
const pageInstances = recordsByType(runtimeRecords, 'PageInstance');
const elementInstances = recordsByType(runtimeRecords, 'ElementInstance');
const coverageRecords = recordsByType(runtimeRecords, 'ExplorationCoverage');

const pageById = indexBy(pages, 'id');
const pageByKey = indexBy(pages, 'key');
const elementById = indexBy(elements, 'id');
const elementByKey = indexBy(elements, 'key');
const navigationScopeById = indexBy(navigationScopes, 'id');
const transitionById = indexBy(transitions, 'id');
const layoutById = indexBy(layouts, 'id');
const actionTraceById = indexBy(actionTraces, 'id');
const pageInstanceById = indexBy(pageInstances, 'id');
const elementInstanceById = indexBy(elementInstances, 'id');
const deviceById = indexBy(devices, 'id');
const resourceById = indexBy(evidenceResources, 'id');
const frameById = indexBy(evidenceFrames, 'id');
const evidenceActionById = indexBy(evidenceActions, 'id');
const navigationScope = navigationScopes[0];

function pageStateKeys(page) {
  return new Set((page?.stateModel?.states ?? []).map((state) => state?.key).filter(Boolean));
}

function ensurePageState(pageRef, stateKey, label) {
  const page = pageById.get(pageRef);
  if (!ensure(Boolean(page), `${label} references unknown Page ${pageRef}`)) return;
  ensure(pageStateKeys(page).has(stateKey), `${label} references unknown state ${page.key}:${stateKey}`);
}

function pageInstanceObservationBindings(instance) {
  const bindings = [];
  if (typeof instance?.layoutSnapshotRef === 'string') {
    bindings.push({
      layoutSnapshotRef: instance.layoutSnapshotRef,
      screenshotRef: instance.screenshotRefs?.[0],
      observedAt: instance.observedAt,
      primary: true,
    });
  }
  for (const observation of instance?.supportingObservations ?? []) {
    bindings.push({ ...observation, primary: false });
  }
  return bindings;
}

function pageInstanceOwnsLayout(instance, layoutRef) {
  return pageInstanceObservationBindings(instance).some(
    (binding) => binding.layoutSnapshotRef === layoutRef,
  );
}

function screenshotRefForLayout(instance, layoutRef) {
  return pageInstanceObservationBindings(instance).find(
    (binding) => binding.layoutSnapshotRef === layoutRef,
  )?.screenshotRef;
}

function elementPresentationSignature(instance) {
  const device = deviceById.get(instance?.deviceSnapshotRef);
  return {
    schemaVersion: '1.0.0',
    elementRef: instance?.elementRef,
    kind: instance?.kind,
    state: {
      visible: instance?.state?.visible ?? 'unknown',
      selected: instance?.state?.selected ?? 'unknown',
      enabled: instance?.state?.enabled ?? 'unknown',
      hittable: instance?.state?.hittable ?? 'unknown',
    },
    content: {
      resolvedText: instance?.content?.resolvedText ?? null,
      badge: instance?.content?.badge ?? null,
    },
    geometry: {
      bbox: instance?.geometry?.bbox,
      semantics: instance?.geometry?.semantics,
      basis: instance?.geometry?.basis,
    },
    appBuild: instance?.appBuild,
    displayContext: {
      deviceSnapshotRef: instance?.deviceSnapshotRef,
      effectiveGeometry: {
        width: device?.display?.effectiveWidthPx,
        height: device?.display?.effectiveHeightPx,
        orientation: device?.orientation,
        rotationDegrees: device?.rotationDegrees,
        coordinateSpace: 'screenshot_px',
      },
      locale: 'zh-CN',
      theme: device?.theme,
    },
  };
}

function validateResolvedFieldEvidence(instance, fieldPath, expectedValue, options = {}) {
  const label = `ElementInstance ${instance.id}.fieldEvidence.${fieldPath}`;
  const evidence = instance.fieldEvidence?.[fieldPath];
  if (!ensure(isPlainObject(evidence), `${label} must be an object`)) return null;
  ensure(
    typeof evidence.resolutionMethod === 'string' && evidence.resolutionMethod.length > 0,
    `${label}.resolutionMethod is required`,
  );
  ensure(
    Array.isArray(evidence.observations) && evidence.observations.length === 1,
    `${label} must contain exactly one Frame-specific observation`,
  );
  const observation = evidence.observations?.[0];
  if (!isPlainObject(observation)) return null;
  const { observationId, ...observationBody } = observation;
  const expectedObservationId = `field-observation:sha256:${digest(canonicalJson(observationBody))}`;
  ensure(
    typeof observationId === 'string' &&
      /^field-observation:sha256:[a-f0-9]{64}$/.test(observationId) &&
      observationId === expectedObservationId &&
      evidence.selectedObservationRef === observationId,
    `${label} must select its content-addressed observation`,
  );
  ensure(observation.subjectRef === instance.id, `${label}.subjectRef must identify its ElementInstance`);
  ensure(observation.fieldPath === fieldPath, `${label}.fieldPath is stale`);
  ensure(sameValue(observation.value, expectedValue), `${label}.value differs from the resolved field`);
  if (options.factStatus) {
    ensure(observation.factStatus === options.factStatus, `${label}.factStatus must be ${options.factStatus}`);
  }
  if (options.sourceType) {
    ensure(observation.sourceType === options.sourceType, `${label}.sourceType must be ${options.sourceType}`);
  }
  ensure(
    observation.evidenceRef === instance.visualEvidence?.fullPageScreenshotRef &&
      resourceById.get(observation.evidenceRef)?.mediaType === 'image/png',
    `${label}.evidenceRef must reference the full-page evidence PNG`,
  );
  ensure(observation.frameRef === instance.layoutSnapshotRef, `${label}.frameRef is stale`);
  ensure(sameValue(observation.region, instance.geometry?.bbox), `${label}.region must equal the instance bbox`);
  ensure(typeof observation.method === 'string' && observation.method.length > 0, `${label}.method is required`);
  ensure(
    observation.producer?.kind === 'curated_multimodal_review' &&
      observation.producer?.id === 'uikg-curated-visual-annotation' &&
      observation.producer?.version === '2.0.0',
    `${label}.producer is invalid`,
  );
  ensure(validConfidence(observation.confidence), `${label}.confidence must be in [0, 1]`);
  if (options.priorElementRef) {
    ensure(
      observation.priorElementRef === options.priorElementRef,
      `${label}.priorElementRef must identify the canonical prior`,
    );
  }
  return observation;
}

group('Canonical and Runtime YAML serialization', () => {
  ensure(
    findYamlAnchorAliasTokens('base: &shared 1\ncopy: *shared\n').length === 2,
    'Internal YAML Anchor/Alias scanner does not detect executable tokens',
  );
  ensure(
    findYamlAnchorAliasTokens(
      'quoted: "&literal *literal"\ncomment: value # &ignored *ignored\nblock: |\n  &literal *literal\n',
    ).length === 0,
    'Internal YAML Anchor/Alias scanner mistakes scalar content for executable tokens',
  );
  const yamlFiles = [
    ...listFiles(APP_ROOT, (path) => /\.ya?ml$/i.test(path)),
    ...listFiles(RUNTIME_ROOT, (path) => /\.ya?ml$/i.test(path)),
  ];
  for (const file of yamlFiles) {
    const source = readFileSync(file, 'utf8');
    const forbiddenTokens = findYamlAnchorAliasTokens(source);
    ensure(
      forbiddenTokens.length === 0,
      `${graphRelative(file)} must not use YAML Anchor/Alias tokens: ${forbiddenTokens.join(', ')}`,
    );
  }

  for (const { file, documentIndex, value } of [...canonicalRecords, ...runtimeRecords]) {
    const label = `${graphRelative(file)} document ${documentIndex + 1}`;
    walk(value, (child, path) => {
      const field = path.at(-1);
      ensure(!(child instanceof Date), `${label}.${path.join('.')} must be a quoted JSON-compatible string, not a YAML timestamp`);
      if (typeof child === 'number') {
        ensure(Number.isFinite(child), `${label}.${path.join('.')} must be a finite JSON number`);
      }
      if (typeof field === 'string' && /At$/.test(field)) {
        ensure(isRfc3339Utc(child), `${label}.${path.join('.')} must be an RFC 3339 UTC string`);
      }
    });
    if (typeof value?.recordedAt === 'string') {
      ensureUlidNotAfter(value?.id, value.recordedAt, label);
    }
    if (value.extensions === undefined) continue;
    ensure(isPlainObject(value.extensions), `${label}.extensions must be an object`);
    for (const key of Object.keys(value.extensions ?? {})) {
      ensure(
        EXTENSION_NAMESPACE_PATTERN.test(key),
        `${label}.extensions key is not a reverse-domain namespace: ${key}`,
      );
    }
  }

  for (const [label, manifest] of [
    ['Canonical manifest', canonicalManifest],
    ['Runtime manifest', runtimeManifest],
    ['Projection manifest', projectionManifest],
  ]) {
    walk(manifest, (child, path) => {
      const field = path.at(-1);
      if (typeof field === 'string' && /At$/.test(field)) {
        ensure(isRfc3339Utc(child), `${label}.${path.join('.')} must be an RFC 3339 UTC string`);
      }
    });
  }
  ensureUlidNotAfter(canonicalManifest?.graphRevision, canonicalManifest?.createdAt, 'Canonical manifest graphRevision');
  ensureUlidNotAfter(runtimeManifest?.graphRevision, runtimeManifest?.createdAt, 'Runtime manifest graphRevision');
  ensureUlidNotAfter(
    projectionManifest?.source?.graphRevision,
    projectionManifest?.projection?.generatedAt,
    'Projection manifest graphRevision',
  );
});

group('Canonical Element and Page ontology', () => {
  ensure(applications.length === 1, `Expected 1 Application, found ${applications.length}`);
  ensure(pages.length === 5, `Expected 5 Pages, found ${pages.length}`);
  ensure(elements.length === 22, `Expected 22 Elements, found ${elements.length}`);
  ensure(navigationScopes.length === 1, `Expected 1 NavigationScope, found ${navigationScopes.length}`);
  ensure(transitions.length === 5, `Expected 5 Transitions, found ${transitions.length}`);
  ensure(observations.length === 1, `Expected 1 Observation, found ${observations.length}`);
  validateUniqueIndex(pages, pageById, 'id', 'Page');
  validateUniqueIndex(pages, pageByKey, 'key', 'Page');
  validateUniqueIndex(elements, elementById, 'id', 'Element');
  validateUniqueIndex(elements, elementByKey, 'key', 'Element');
  validateUniqueIndex(navigationScopes, navigationScopeById, 'id', 'NavigationScope');
  validateUniqueIndex(transitions, transitionById, 'id', 'Transition');

  for (const observation of observations) {
    ensure(
      OBSERVATION_TYPES.has(observation?.observationType),
      `Observation ${observation?.key ?? observation?.id} has invalid observationType ${observation?.observationType}`,
    );
  }
  ensure(
    observations[0]?.observationType === 'element_candidate',
    'The unresolved message-header icon must be modeled as an element_candidate Observation',
  );

  const application = applications[0];
  ensure(application?.key === APPLICATION_KEY, `Application key must be ${APPLICATION_KEY}`);
  ensureSetEquals(pageByKey.keys(), EXPECTED_PAGE_KEYS, 'Canonical Page keys are incomplete');
  const drawerPage = pageByKey.get('app-drawer.root');
  const primaryPageIds = pages
    .filter((page) => page.key !== 'app-drawer.root')
    .map((page) => page.id);
  ensure(
    navigationScope?.applicationRef === application?.id &&
      navigationScope?.containerElementRef === elementByKey.get(BOTTOM_NAVIGATION_KEY)?.id,
    'NavigationScope must belong to the Application and bottom-navigation container',
  );
  ensureSetEquals(
    navigationScope?.memberPageRefs ?? [],
    pageById.keys(),
    'NavigationScope must contain exactly the five canonical Pages',
  );
  ensureSetEquals(
    navigationScope?.primaryPageRefs ?? [],
    primaryPageIds,
    'NavigationScope primaryPageRefs must contain the four primary Pages',
  );
  ensureSetEquals(
    navigationScope?.overlayPageRefs ?? [],
    [drawerPage?.id],
    'NavigationScope overlayPageRefs must contain only the independent drawer Page',
  );
  ensure(
    isPlainObject(navigationScope?.routingProfiles) &&
      navigationScope.routingProfiles?.common?.usageEvidenceKind === 'user_navigation_usage',
    'NavigationScope must define the common routing profile using user-navigation usage evidence',
  );
  ensure(
    drawerPage?.pageKind === 'overlay_drawer' &&
      drawerPage?.presentation?.hostPageParticipatesInIdentity === false &&
      drawerPage?.stableAnchorRefs?.includes(elementByKey.get('shared.app_drawer')?.id),
    'app-drawer.root must be an independent overlay Page anchored by shared.app_drawer',
  );

  for (const page of pages) {
    const label = `Page ${page.key ?? page.id}`;
    ensure(page.applicationRef === application?.id, `${label} has the wrong applicationRef`);
    ensure(page.navigationScopeRef === navigationScope?.id, `${label} has the wrong navigationScopeRef`);
    ensure(isPlainObject(page.stateModel), `${label} must embed stateModel`);
    ensure(Array.isArray(page.stateModel?.dimensions), `${label}.stateModel.dimensions must be an array`);
    ensure(Array.isArray(page.stateModel?.states) && page.stateModel.states.length > 0, `${label} has no embedded states`);
    const stateKeys = pageStateKeys(page);
    ensure(stateKeys.size === (page.stateModel?.states ?? []).length, `${label} has duplicate state keys`);
    ensure(stateKeys.has(page.stateModel?.defaultStateKey), `${label} defaultStateKey is not defined`);
    for (const state of page.stateModel?.states ?? []) {
      for (const ref of state.expectedElementRefs ?? []) {
        ensure(elementById.has(ref), `${label} state ${state.key} references unknown Element ${ref}`);
      }
      for (const ref of state.recognitionProfile?.requiredAnchors ?? []) {
        ensure(elementById.has(ref), `${label} state ${state.key} has unknown anchor Element ${ref}`);
      }
    }
    for (const ref of page.stableAnchorRefs ?? []) {
      ensure(elementById.has(ref), `${label} has unknown stableAnchorRef ${ref}`);
    }
  }

  for (const element of elements) {
    const label = `Element ${element.key ?? element.id}`;
    ensure(element.applicationRef === application?.id, `${label} has the wrong applicationRef`);
    ensure(['container', 'element'].includes(element.kind), `${label} has invalid kind ${element.kind}`);
    if (element.parentElementRef !== undefined) {
      ensure(elementById.has(element.parentElementRef), `${label} has unknown parentElementRef`);
      ensure(element.parentElementRef !== element.id, `${label} cannot parent itself`);
    }
    for (const capability of element.interactionCapabilities ?? []) {
      ensure(
        ['idempotent', 'non_idempotent', 'unknown'].includes(capability.idempotency),
        `${label} capability ${capability.key} has invalid idempotency`,
      );
      for (const effect of capability.expectedEffects ?? []) {
        if (effect.targetPageRef) {
          ensurePageState(
            effect.targetPageRef,
            effect.stateSelector?.stateKey,
            `${label} capability ${capability.key}`,
          );
        }
      }
    }
    if (EXPECTED_BOTTOM_TAB_KEYS.includes(element.key)) {
      const activate = (element.interactionCapabilities ?? []).find(
        (capability) => capability.semanticAction === 'activate',
      );
      ensure(
        activate?.idempotency === 'unknown',
        `${label} idempotency must remain unknown until repeated activation is observed`,
      );
    }
  }

  const definedPageTargets = new Set(
    (application?.links ?? [])
      .filter((link) => link.predicate === 'DEFINES_PAGE')
      .map((link) => link.target),
  );
  const definedElementTargets = new Set(
    (application?.links ?? [])
      .filter((link) => link.predicate === 'DEFINES_ELEMENT')
      .map((link) => link.target),
  );
  ensureSetEquals(definedPageTargets, pageById.keys(), 'Application DEFINES_PAGE links are incomplete');
  ensureSetEquals(definedElementTargets, elementById.keys(), 'Application DEFINES_ELEMENT links are incomplete');

  const transitionDestinationPageRefs = new Set();
  const transitionTriggerElementRefs = new Set();
  const projectedObservationRefs = new Set();
  for (const transition of transitions) {
    const label = `Transition ${transition.key ?? transition.id}`;
    ensure(
      transition.fromState === undefined &&
        transition.sourceSelector?.kind === 'navigation_scope' &&
        transition.sourceSelector?.navigationScopeRef === navigationScope?.id,
      `${label} must use the generic NavigationScope source selector`,
    );
    ensure(elementById.has(transition.trigger?.elementRef), `${label} references unknown trigger Element`);
    ensure(
      transition.sourceSelector?.requiresActionableElementRef === transition.trigger?.elementRef &&
        transition.trigger?.kind === 'ui_action' &&
        transition.trigger?.capability === 'activate',
      `${label} source selector and trigger must identify the same actionable Element`,
    );
    ensure(
      EXPECTED_BOTTOM_TAB_KEYS.includes(elementById.get(transition.trigger?.elementRef)?.key),
      `${label} must be triggered by one of the five bottom-navigation tabs`,
    );
    ensure(
      transition.routing?.actionCost === 1 &&
        typeof transition.routing?.navigationClass === 'string' &&
        transition.routing.navigationClass.length > 0,
      `${label} must be a one-action atomic navigation edge`,
    );
    ensure(
      (transition.routing?.commonUsage?.sampleCount ?? 0) === 0,
      `${label} common-route usage samples must remain separate from exploration execution observations`,
    );
    const successOutcomes = (transition.outcomes ?? []).filter((outcome) => outcome.type === 'success');
    ensure(successOutcomes.length === 1, `${label} must have exactly one success outcome`);
    for (const outcome of successOutcomes) {
      ensurePageState(outcome.toState?.pageRef, outcome.toState?.stateSelector?.stateKey, `${label} outcome ${outcome.key}`);
      ensure(isPlainObject(outcome.stateTransform), `${label} outcome must declare stateTransform`);
      const destinationPageRef = outcome.toState?.pageRef;
      const triggerKey = elementById.get(transition.trigger?.elementRef)?.key;
      const selectedBottomTab = triggerKey?.replace('shared.bottom_tab.', '');
      if (destinationPageRef === drawerPage?.id) {
        ensure(
          outcome.stateTransform?.primaryPageRef === '$source.primaryPageRef' &&
            outcome.stateTransform?.hostPageRef === '$source.primaryPageRef' &&
            outcome.stateTransform?.activePageRef === drawerPage.id &&
            outcome.stateTransform?.selectedBottomTab === 'more' &&
            sameValue(outcome.stateTransform?.overlayStack, {
              operation: 'push',
              pageRef: drawerPage.id,
            }),
          `${label} must preserve the source primary Page while opening the drawer Page`,
        );
      } else {
        ensure(
          outcome.stateTransform?.primaryPageRef === destinationPageRef &&
            outcome.stateTransform?.activePageRef === destinationPageRef &&
            outcome.stateTransform?.hostPageRef === undefined &&
            outcome.stateTransform?.selectedBottomTab === selectedBottomTab &&
            outcome.stateTransform?.overlayStack?.operation === 'clear',
          `${label} must atomically select its primary Page and clear overlays`,
        );
      }
      transitionDestinationPageRefs.add(outcome.toState?.pageRef);
    }
    transitionTriggerElementRefs.add(transition.trigger?.elementRef);
    ensure(
      Array.isArray(transition.observationRefs) &&
        new Set(transition.observationRefs).size === transition.observationRefs.length,
      `${label}.observationRefs must be a duplicate-free array`,
    );
    for (const ref of transition.observationRefs ?? []) projectedObservationRefs.add(ref);
  }
  ensureSetEquals(
    transitionDestinationPageRefs,
    pageById.keys(),
    'Generic navigation edges must cover exactly the five Page destinations',
  );
  ensureSetEquals(
    transitionTriggerElementRefs,
    EXPECTED_BOTTOM_TAB_KEYS.map((key) => elementByKey.get(key)?.id),
    'Generic navigation edges must cover exactly the five bottom-navigation tabs',
  );
  ensureSetEquals(
    projectedObservationRefs,
    actionTraceById.keys(),
    'Transition observationRefs must cover exactly the observed ActionTraces',
  );
});

group('Embedded AppBuildContext and legacy removal', () => {
  const structuredArtifacts = [
    ...canonicalRecords.map(({ value }) => value),
    ...runtimeRecords.map(({ value }) => value),
    canonicalManifest,
    runtimeManifest,
    projectionManifest,
  ];
  let appBuildCount = 0;
  for (const artifact of structuredArtifacts) {
    walk(artifact, (value, path) => {
      const key = path.at(-1);
      if (key === 'appBuild' || key === 'observedAppBuild') {
        appBuildCount += 1;
        validateAppBuild(value, path.join('.'));
      }
      if (
        typeof key === 'string' &&
        /^(?:applicationReleaseRef|releaseRef|releaseKey|release)$/i.test(key)
      ) {
        fail(`Legacy release field is forbidden at ${path.join('.')}`);
      }
      if (
        ['UIEntityIdentity', 'PageVariant', 'ApplicationRelease'].includes(
          String(value?.entityType ?? value?.recordType ?? ''),
        )
      ) {
        fail(`Legacy node type is forbidden: ${value.entityType ?? value.recordType}`);
      }
    });
  }
  ensure(appBuildCount >= 1, 'No embedded AppBuildContext values were found');

  const forbiddenDirectories = [
    join(APP_ROOT, 'entities'),
    join(APP_ROOT, 'releases'),
    ...readdirSync(join(APP_ROOT, 'pages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(APP_ROOT, 'pages', entry.name, 'variants')),
    join(OBSIDIAN_ROOT, '界面实体'),
    join(OBSIDIAN_ROOT, '页面状态'),
    join(OBSIDIAN_ROOT, '应用版本'),
    join(OBSIDIAN_ROOT, '资源', '界面实体'),
    join(OBSIDIAN_ROOT, '观察记录'),
    join(OBSIDIAN_ROOT, '探索覆盖'),
  ];
  for (const path of forbiddenDirectories) {
    ensure(!existsSync(path), `Legacy directory must not exist: ${graphRelative(path)}`);
  }
});

group('Runtime PageInstance and ElementInstance references', () => {
  ensure(captureSessions.length === 1, `Expected 1 CaptureSession, found ${captureSessions.length}`);
  ensure(devices.length === 1, `Expected 1 DeviceSnapshot, found ${devices.length}`);
  ensure(layouts.length === 6, `Expected 6 LayoutSnapshots, found ${layouts.length}`);
  ensure(actionTraces.length === 5, `Expected 5 ActionTraces, found ${actionTraces.length}`);
  ensure(pageInstances.length === 5, `Expected 5 PageInstances, found ${pageInstances.length}`);
  ensure(elementInstances.length === 52, `Expected 52 ElementInstances, found ${elementInstances.length}`);
  ensure(coverageRecords.length === 1, `Expected 1 ExplorationCoverage, found ${coverageRecords.length}`);
  validateUniqueIndex(layouts, layoutById, 'id', 'LayoutSnapshot');
  validateUniqueIndex(pageInstances, pageInstanceById, 'id', 'PageInstance');
  validateUniqueIndex(elementInstances, elementInstanceById, 'id', 'ElementInstance');
  ensureSetEquals(
    pageInstances.map((instance) => instance.pageRef),
    pageById.keys(),
    'Runtime must contain exactly one PageInstance for each canonical Page',
  );
  ensure(
    pageInstances.every((instance) => !canonicalJson(instance).includes('消息-探索结束')),
    'The duplicate 消息-探索结束 PageInstance entity must not exist',
  );

  const captureSession = captureSessions[0];
  const device = devices[0];
  ensure(captureSession?.id === SESSION_ID, 'CaptureSession has the wrong id');
  ensure(captureSession?.status === 'completed', 'CaptureSession must be completed');
  ensure(
    captureSession?.applicationRef === applications[0]?.id,
    'CaptureSession has the wrong applicationRef',
  );
  validateAppBuild(captureSession?.appBuild, 'CaptureSession.appBuild');
  ensure(
    sameValue(captureSession?.deviceSnapshotRefs, [device?.id]),
    'CaptureSession must reference exactly this DeviceSnapshot',
  );
  ensure(
    captureSession?.extensions?.['com.zto.uikg.captureSummary']?.frameCount === 6 &&
      captureSession?.extensions?.['com.zto.uikg.captureSummary']?.actionCount === 5,
    'CaptureSession summary must report 6 frames and 5 actions',
  );

  ensure(
    device?.platform === 'android' && device?.manufacturer === 'HUAWEI' && device?.model === 'NOH-AN01',
    'DeviceSnapshot identity must be Android HUAWEI NOH-AN01',
  );
  ensure(
    device?.display?.physicalWidthPx === 1344 && device?.display?.physicalHeightPx === 2772,
    'DeviceSnapshot physical resolution must be 1344x2772',
  );
  ensure(
    device?.display?.effectiveWidthPx === SCREEN.width &&
      device?.display?.effectiveHeightPx === SCREEN.height &&
      device?.window?.windowRectPx?.width === SCREEN.width &&
      device?.window?.windowRectPx?.height === SCREEN.height &&
      device?.window?.viewportRectPx?.width === SCREEN.width &&
      device?.window?.viewportRectPx?.height === SCREEN.height,
    'DeviceSnapshot effective/window/viewport resolution must be 1152x2376',
  );
  ensure(
    device?.captureCompleteness?.status === 'partial' &&
      Array.isArray(device?.captureCompleteness?.missingFields) &&
      device.captureCompleteness.missingFields.length > 0,
    'DeviceSnapshot must explicitly report its incomplete UI context',
  );
  ensure(
    device?.reuseGate?.status === 'blocked' &&
      device?.reuseGate?.candidateRecallAllowed === true &&
      device?.reuseGate?.pixelActionAllowed === false &&
      device?.extensions?.['com.zto.uikg.reuseLookup']?.semantics === 'candidate_only' &&
      device?.extensions?.['com.zto.uikg.reuseLookup']?.executionEligibility === 'blocked_missing_context',
    'Incomplete DeviceSnapshot must be candidate-only and blocked for executable coordinate reuse',
  );
  ensureSetEquals(
    device?.extensions?.['com.zto.uikg.reuseLookup']?.blockers ?? [],
    [
      'insets_not_captured',
      'locale_not_captured',
      'theme_not_captured',
      'font_scale_not_captured',
      'accessibility_visual_settings_not_captured',
      'ui_permissions_not_captured',
      'network_not_captured',
      'feature_flags_not_captured',
      'clock_offset_not_captured',
    ],
    'DeviceSnapshot reuse blockers are incomplete',
  );

  for (const instance of pageInstances) {
    const label = `PageInstance ${instance.id}`;
    const page = pageById.get(instance.pageRef);
    const layout = layoutById.get(instance.layoutSnapshotRef);
    const frame = frameById.get(instance.layoutSnapshotRef);
    ensure(Boolean(page), `${label} references unknown Page ${instance.pageRef}`);
    ensure(Boolean(layout), `${label} references unknown LayoutSnapshot ${instance.layoutSnapshotRef}`);
    ensure(instance.captureSessionRef === SESSION_ID, `${label} has the wrong captureSessionRef`);
    ensure(instance.deviceSnapshotRef === device?.id, `${label} has the wrong deviceSnapshotRef`);
    validateAppBuild(instance.appBuild, `${label}.appBuild`);
    ensurePageState(instance.pageRef, instance.state?.key, `${label}.state`);
    validateObservedAt(instance.observedAt, frame?.capturedAt, `${label}.observedAt`);
    ensure(isPlainObject(instance.state), `${label}.state must be an object`);
    ensure(isPlainObject(instance.state?.stateVector), `${label}.state.stateVector must be an object`);
    ensure(typeof instance.state?.canonicalState === 'string', `${label}.state.canonicalState must be a string`);
    ensure(
      typeof instance.state?.stateHash === 'string' && /^[a-f0-9]{64}$/.test(instance.state.stateHash),
      `${label}.state.stateHash must be a lowercase SHA-256 digest`,
    );
    ensure(
      instance.state?.stateHash === digest(instance.state?.canonicalState ?? ''),
      `${label}.state.stateHash is not sha256(canonicalState)`,
    );
    const modeledState = (page?.stateModel?.states ?? []).find(
      (state) => state?.key === instance.state?.key,
    );
    if (modeledState) {
      ensure(
        sameValue(instance.state?.stateVector, modeledState.stateVector),
        `${label}.state.stateVector differs from the canonical Page state`,
      );
      ensure(
        instance.state?.canonicalState === modeledState.canonicalState &&
          instance.state?.stateHash === modeledState.stateHash,
        `${label}.state canonicalState/stateHash differs from the canonical Page state`,
      );
    }
    ensure(
      typeof instance.state?.recognition?.method === 'string' &&
        instance.state.recognition.method.length > 0 &&
        validConfidence(instance.state.recognition.confidence),
      `${label}.state.recognition must contain a method and confidence in [0, 1]`,
    );
    const expectedScreenshotRefs = [
      instance.screenshotRefs?.[0],
      ...(instance.supportingObservations ?? []).map((observation) => observation.screenshotRef),
    ].filter((ref, index, values) => typeof ref === 'string' && values.indexOf(ref) === index);
    ensure(
      sameValue(instance.screenshotRefs, expectedScreenshotRefs) &&
        instance.screenshotRefs.every(
          (ref) => resourceById.get(ref)?.mediaType === 'image/png',
        ),
      `${label}.screenshotRefs must be the ordered primary/supporting evidence PNG union`,
    );
    ensure(
      Array.isArray(instance.elementInstanceRefs) &&
        new Set(instance.elementInstanceRefs).size === instance.elementInstanceRefs.length,
      `${label} has duplicate or invalid elementInstanceRefs`,
    );
    for (const ref of instance.elementInstanceRefs ?? []) {
      ensure(elementInstanceById.has(ref), `${label} references unknown ElementInstance ${ref}`);
    }
    const bindings = pageInstanceObservationBindings(instance);
    ensure(
      bindings.length >= 1 &&
        new Set(bindings.map((binding) => binding.layoutSnapshotRef)).size === bindings.length,
      `${label} must bind each primary/supporting LayoutSnapshot exactly once`,
    );
    for (const binding of bindings) {
      const boundLayout = layoutById.get(binding.layoutSnapshotRef);
      const boundFrame = frameById.get(binding.layoutSnapshotRef);
      ensure(Boolean(boundLayout), `${label} observation references unknown LayoutSnapshot`);
      ensure(
        binding.screenshotRef === boundFrame?.screenshotResourceRef &&
          resourceById.get(binding.screenshotRef)?.mediaType === 'image/png',
        `${label} observation screenshot must match its source Frame PNG`,
      );
      validateObservedAt(binding.observedAt, boundFrame?.capturedAt, `${label} observation observedAt`);
      ensure(
        boundLayout?.pageInstanceRef === instance.id && boundLayout?.pageRef === instance.pageRef,
        `${label} observation LayoutSnapshot has inconsistent Page ownership`,
      );
      if (!binding.primary) {
        ensureSetEquals(
          binding.elementInstanceRefs ?? [],
          boundLayout?.elementInstanceRefs ?? [],
          `${label} supporting observation ElementInstances differ from its LayoutSnapshot`,
        );
      }
    }
    if (layout) {
      ensure(layout.pageInstanceRef === instance.id, `${label} is not owned by its LayoutSnapshot`);
      ensure(layout.pageRef === instance.pageRef, `${label} Page differs from its LayoutSnapshot`);
    }
  }

  for (const instance of elementInstances) {
    const label = `ElementInstance ${instance.id}`;
    const element = elementById.get(instance.elementRef);
    const pageInstance = pageInstanceById.get(instance.pageInstanceRef);
    const layout = layoutById.get(instance.layoutSnapshotRef);
    ensure(Boolean(element), `${label} references unknown Element ${instance.elementRef}`);
    ensure(Boolean(pageInstance), `${label} references unknown PageInstance ${instance.pageInstanceRef}`);
    ensure(Boolean(layout), `${label} references unknown LayoutSnapshot ${instance.layoutSnapshotRef}`);
    ensure(instance.pageRef === pageInstance?.pageRef, `${label} Page differs from its PageInstance`);
    ensure(
      pageInstanceOwnsLayout(pageInstance, instance.layoutSnapshotRef),
      `${label} layout is not a primary or supporting observation of its PageInstance`,
    );
    ensure(
      typeof instance.presentationGroupRef === 'string' && instance.presentationGroupRef.length > 0,
      `${label} must reference an ElementPresentationGroup`,
    );
    ensure(instance.deviceSnapshotRef === device?.id, `${label} has the wrong deviceSnapshotRef`);
    validateAppBuild(instance.appBuild, `${label}.appBuild`);
    validateObservedAt(instance.observedAt, layout?.capturedAt, `${label}.observedAt`);
    ensure(instance.kind === element?.kind, `${label}.kind must match its canonical Element`);
    ensure(instance.visibility === 'visible', `${label}.visibility must be visible`);
    const elementKey = element?.key;
    ensure(
      isPlainObject(instance.semantics) &&
        typeof instance.semantics.role === 'string' &&
        instance.semantics.role.length > 0 &&
        ['observed', 'inferred', 'unknown'].includes(instance.semantics.roleFactStatus) &&
        ['observed', 'inferred', 'unknown'].includes(instance.semantics.nameFactStatus),
      `${label}.semantics is incomplete or invalid`,
    );
    ensure(isPlainObject(instance.fieldEvidence), `${label}.fieldEvidence must be an object`);
    ensure(
      isPlainObject(instance.content) && Object.hasOwn(instance.content, 'resolvedText'),
      `${label}.content.resolvedText is required`,
    );
    const resolvedText = instance.content?.resolvedText;
    const hasResolvedText = typeof resolvedText === 'string' && resolvedText.length > 0;
    if (resolvedText === null) {
      ensure(
        instance.content?.language === null &&
          instance.content?.source === 'not_applicable' &&
          instance.content?.factStatus === 'unknown',
        `${label} null resolvedText must use explicit unknown/not-applicable metadata`,
      );
      ensure(
        !Object.hasOwn(instance.fieldEvidence ?? {}, 'content.resolvedText'),
        `${label} must not claim resolved-text evidence when resolvedText is null`,
      );
    } else {
      ensure(
        hasResolvedText &&
          typeof instance.content?.language === 'string' &&
          instance.content.language.length > 0 &&
          typeof instance.content?.source === 'string' &&
          instance.content.source.length > 0 &&
          instance.content.source !== 'not_applicable' &&
          instance.content?.factStatus === 'observed',
        `${label} non-null resolvedText must be a sourced observed string`,
      );
      validateResolvedFieldEvidence(instance, 'content.resolvedText', resolvedText, {
        factStatus: 'observed',
      });
    }

    const semanticName = instance.semantics?.name;
    if (semanticName === null) {
      ensure(
        instance.semantics?.nameFactStatus === 'unknown' &&
          !Object.hasOwn(instance.fieldEvidence ?? {}, 'semantics.name'),
        `${label} null semantics.name must be unknown and must not claim resolved evidence`,
      );
    } else {
      ensure(
        typeof semanticName === 'string' &&
          semanticName.length > 0 &&
          ['observed', 'inferred'].includes(instance.semantics?.nameFactStatus),
        `${label} non-null semantics.name must have an observed or inferred fact status`,
      );
      const nameEvidence = validateResolvedFieldEvidence(
        instance,
        'semantics.name',
        semanticName,
        {
          factStatus: instance.semantics?.nameFactStatus,
          sourceType: instance.semantics?.nameFactStatus === 'inferred' ? 'inference' : undefined,
        },
      );
      ensure(
        instance.semantics?.nameFactStatus !== 'observed' || nameEvidence?.sourceType !== 'inference',
        `${label} must not present an inferred semantic name as an observed fact`,
      );
    }

    const roleEvidence = validateResolvedFieldEvidence(
      instance,
      'semantics.role',
      instance.semantics?.role,
      {
        factStatus: instance.semantics?.roleFactStatus,
        sourceType: instance.semantics?.roleFactStatus === 'inferred' ? 'inference' : undefined,
        priorElementRef: instance.semantics?.roleFactStatus === 'inferred' ? instance.elementRef : undefined,
      },
    );
    ensure(
      instance.semantics?.roleFactStatus !== 'observed' || roleEvidence?.sourceType !== 'inference',
      `${label} must not present a canonical role prior as an observed runtime fact`,
    );

    const geometryEvidence = validateResolvedFieldEvidence(
      instance,
      'geometry.bbox',
      instance.geometry?.bbox,
      { factStatus: 'observed', sourceType: 'vision' },
    );
    const visibleEvidence = validateResolvedFieldEvidence(instance, 'state.visible', instance.state?.visible, {
      factStatus: 'observed',
      sourceType: 'vision',
    });
    ensure(
      instance.visibility === 'visible' && instance.state?.visible === true,
      `${label} visibility and state.visible must consistently describe a visible instance`,
    );
    ensure(
      validConfidence(instance.geometry?.confidence) &&
        geometryEvidence?.confidence === instance.geometry.confidence &&
        typeof instance.geometry?.basis === 'string' &&
        instance.geometry.basis.length > 0,
      `${label} geometry confidence/basis must agree with its resolved bbox evidence`,
    );

    const confidenceInputs = [
      geometryEvidence?.confidence,
      visibleEvidence?.confidence,
      roleEvidence?.confidence,
    ].filter(
      validConfidence,
    );
    if (typeof instance.state?.selected === 'boolean') {
      const selectedObservation = validateResolvedFieldEvidence(
        instance,
        'state.selected',
        instance.state.selected,
        { factStatus: 'observed', sourceType: 'vision' },
      );
      if (validConfidence(selectedObservation?.confidence)) {
        confidenceInputs.push(selectedObservation.confidence);
      }
    } else {
      ensure(
        !Object.hasOwn(instance.fieldEvidence ?? {}, 'state.selected'),
        `${label} must not invent selected-state evidence when selected is unknown`,
      );
    }
    if (hasResolvedText) {
      const textObservation = instance.fieldEvidence?.['content.resolvedText']?.observations?.[0];
      if (validConfidence(textObservation?.confidence)) confidenceInputs.push(textObservation.confidence);
    }

    const badge = instance.content?.badge;
    if (badge !== undefined) {
      ensure(
        isPlainObject(badge) &&
          ['text', 'dot'].includes(badge.kind) &&
          typeof badge.semanticMeaning === 'string' &&
          badge.semanticMeaning.length > 0 &&
          (badge.kind === 'text'
            ? typeof badge.text === 'string' && badge.text.length > 0
            : badge.text === null),
        `${label}.content.badge has an invalid appearance shape`,
      );
      const badgeObservation = validateResolvedFieldEvidence(
        instance,
        'content.badge',
        badge,
        { factStatus: 'observed', sourceType: 'vision' },
      );
      if (validConfidence(badgeObservation?.confidence)) confidenceInputs.push(badgeObservation.confidence);
    } else {
      ensure(
        !Object.hasOwn(instance.fieldEvidence ?? {}, 'content.badge'),
        `${label} must not claim badge evidence when content.badge is absent`,
      );
    }
    ensure(validConfidence(instance.confidence), `${label}.confidence must be in [0, 1]`);
    ensure(
      confidenceInputs.length > 0 && instance.confidence === Math.min(...confidenceInputs),
      `${label}.confidence must be the conservative minimum of resolved field confidences`,
    );
    for (const field of [
      'present',
      'displayed',
      'inViewport',
      'occluded',
      'visible',
      'selected',
      'enabled',
      'hittable',
      'focused',
      'checked',
      'expanded',
      'pressed',
      'loading',
      'editable',
      'required',
      'readOnly',
      'invalid',
    ]) {
      ensure(Object.hasOwn(instance.state ?? {}, field), `${label}.state.${field} is required`);
      ensure(
        typeof instance.state?.[field] === 'boolean' || instance.state?.[field] === 'unknown',
        `${label}.state.${field} must be boolean or unknown`,
      );
    }
    ensure(
      instance.pageState?.key === pageInstance?.state?.key &&
        instance.pageState?.selectedBottomTab === pageInstance?.state?.selectedBottomTab &&
        sameValue(instance.pageState?.transientState, pageInstance?.state?.transientState),
      `${label} pageState differs from its PageInstance`,
    );
    if (typeof element?.parentElementRef === 'string') {
      ensure(
        typeof instance.parentInstanceRef === 'string' && instance.parentInstanceRef.length > 0,
        `${label} must instantiate its canonical Element parent`,
      );
    }
    const parentInstance = typeof instance.parentInstanceRef === 'string'
      ? elementInstanceById.get(instance.parentInstanceRef)
      : null;
    if (instance.parentInstanceRef !== null && instance.parentInstanceRef !== undefined) {
      ensure(Boolean(parentInstance), `${label} references unknown parent ElementInstance`);
      ensure(instance.parentInstanceRef !== instance.id, `${label} cannot parent itself`);
      ensure(
        parentInstance?.layoutSnapshotRef === instance.layoutSnapshotRef &&
          parentInstance?.pageInstanceRef === instance.pageInstanceRef,
        `${label} parent belongs to another LayoutSnapshot or PageInstance`,
      );
      ensure(
        !element?.parentElementRef || parentInstance?.elementRef === element.parentElementRef,
        `${label} parent instance does not instantiate the canonical parent Element`,
      );
      ensure(
        parentInstance?.surfaceId === instance.surfaceId,
        `${label} and its parent must belong to the same Surface`,
      );
    }
    ensure(
      instance.visualEvidence?.sourceFrameRef === instance.layoutSnapshotRef &&
        instance.visualEvidence?.fullPageScreenshotRef ===
          screenshotRefForLayout(pageInstance, instance.layoutSnapshotRef),
      `${label} visual evidence differs from its PageInstance/LayoutSnapshot`,
    );
    ensure(
      instance.visualEvidence?.sourcePixelSize?.width === SCREEN.width &&
        instance.visualEvidence?.sourcePixelSize?.height === SCREEN.height &&
        instance.visualEvidence?.coordinateSpace === 'screenshot_px' &&
        instance.visualEvidence?.coordinateMappingRef ===
          `${instance.layoutSnapshotRef}#screenshotGeometry`,
      `${label} visual evidence must use the 1152x2376 screenshot_px space`,
    );

    const bbox = instance.geometry?.bbox;
    const center = instance.geometry?.centerPoint;
    const matchingSurfaces = (layout?.surfaceStack ?? []).filter(
      (surface) => surface?.id === instance.surfaceId,
    );
    ensure(
      typeof instance.surfaceId === 'string' &&
        instance.surfaceId.length > 0 &&
        matchingSurfaces.length === 1,
      `${label}.surfaceId must resolve to exactly one Surface in its LayoutSnapshot`,
    );
    const surface = matchingSurfaces[0];
    ensure(validHalfOpenRect(bbox), `${label} bbox is not a valid half-open screenshot rectangle`);
    if (validHalfOpenRect(bbox)) {
      const expected = exactCenter(bbox);
      ensure(
        center?.x === expected.x && center?.y === expected.y,
        `${label} centerPoint must be exactly (${expected.x}, ${expected.y})`,
      );
      ensure(
        rectContains(surface?.boundsPx, bbox),
        `${label} bbox must be contained by its declared Surface`,
      );
      if (parentInstance) {
        ensure(
          rectContains(parentInstance.geometry?.bbox, bbox),
          `${label} bbox must be contained by its parent ElementInstance`,
        );
      }
    }
    ensure(
      bbox?.space === 'screenshot_px' &&
        center?.space === 'screenshot_px' &&
        center?.derivedBy === 'half_open_bbox_center',
      `${label} geometry must declare screenshot_px and half_open_bbox_center`,
    );
    ensure(
      instance.geometry?.semantics === 'representative_visual_bounds' &&
        instance.geometry?.locatorEligible === false,
      `${label} geometry must remain visual evidence, not a physical locator`,
    );
  }

});

group('First-level ZTO observation fixture', () => {
  const tabStateKeys = new Map([
    ['shared.bottom_tab.workbench', 'workbench'],
    ['shared.bottom_tab.messages', 'messages'],
    ['shared.bottom_tab.contacts', 'contacts'],
    ['shared.bottom_tab.news', 'news'],
    ['shared.bottom_tab.more', 'more'],
  ]);

  for (const instance of elementInstances) {
    const label = `ElementInstance ${instance.id}`;
    const element = elementById.get(instance.elementRef);
    const pageInstance = pageInstanceById.get(instance.pageInstanceRef);
    const elementKey = element?.key;

    if (elementKey === BOTTOM_NAVIGATION_KEY) {
      ensure(
        instance.content?.resolvedText === null &&
          instance.semantics?.name === null &&
          instance.state?.selected === 'unknown',
        `${label} first-level bottom-navigation container must remain textless and selection-neutral`,
      );
    } else {
      const resolvedText = instance.content?.resolvedText;
      ensure(
        typeof resolvedText === 'string' &&
          resolvedText.length > 0 &&
          instance.content?.language === 'zh-CN' &&
          instance.content?.source === 'curated_screenshot_visual_annotation' &&
          instance.content?.factStatus === 'observed' &&
          instance.semantics?.name === resolvedText &&
          instance.semantics?.nameFactStatus === 'observed' &&
          (element?.aliases ?? []).includes(resolvedText),
        `${label} differs from the reviewed first-level visible-text fixture`,
      );
    }

    if (tabStateKeys.has(elementKey)) {
      ensure(
        instance.state?.selected ===
          (pageInstance?.state?.selectedBottomTab === tabStateKeys.get(elementKey)),
        `${label} selected state differs from its PageInstance selectedBottomTab`,
      );
    }

    const expectedBadge = EXPECTED_BADGES.get(elementKey);
    if (expectedBadge) {
      ensure(
        sameValue(instance.content?.badge, expectedBadge.value) &&
          instance.content?.badge?.semanticMeaning === 'unknown',
        `${label}.content.badge differs from the reviewed first-level fixture`,
      );
    } else {
      ensure(
        !Object.hasOwn(instance.content ?? {}, 'badge') &&
          !Object.hasOwn(instance.fieldEvidence ?? {}, 'content.badge'),
        `${label} has a badge outside the reviewed first-level fixture`,
      );
    }
  }

  for (const [elementKey, expectedBadge] of EXPECTED_BADGES) {
    const matchingInstances = elementInstances.filter(
      (instance) => elementById.get(instance.elementRef)?.key === elementKey,
    );
    ensure(
      matchingInstances.length === expectedBadge.count,
      `${elementKey} must have ${expectedBadge.count} reviewed badge-bearing instance(s)`,
    );
  }
});

group('LayoutSnapshot instance alignment', () => {
  const orderedLayouts = [...layouts].sort(
    (left, right) => new Date(left.capturedAt).getTime() - new Date(right.capturedAt).getTime(),
  );
  ensure(
    sameValue(orderedLayouts.map((layout) => layout.instanceCount), EXPECTED_LAYOUT_COUNTS),
    `Layout instance counts must be ${EXPECTED_LAYOUT_COUNTS.join('/')}`,
  );

  const allLayoutElementRefs = [];
  const layoutElementRefsByPageInstance = new Map();
  for (const layout of orderedLayouts) {
    const label = `LayoutSnapshot ${layout.id}`;
    const pageInstance = pageInstanceById.get(layout.pageInstanceRef);
    const refs = layout.elementInstanceRefs ?? [];
    const actualInstances = elementInstances.filter((instance) => instance.layoutSnapshotRef === layout.id);
    const surfaces = layout.surfaceStack ?? [];
    const surfaceById = indexBy(surfaces, 'id');
    ensure(
      pageInstanceOwnsLayout(pageInstance, layout.id),
      `${label} is not a primary or supporting observation of its PageInstance`,
    );
    ensure(pageInstance?.pageRef === layout.pageRef, `${label} Page differs from its PageInstance`);
    ensure(layout.captureSessionRef === SESSION_ID, `${label} has the wrong captureSessionRef`);
    validateAppBuild(layout.appBuild, `${label}.appBuild`);
    ensure(layout.instanceCount === refs.length, `${label} instanceCount differs from elementInstanceRefs`);
    ensure(
      new Set(refs).size === refs.length,
      `${label}.elementInstanceRefs must not contain duplicates`,
    );
    validateUniqueIndex(surfaces, surfaceById, 'id', `${label}.surfaceStack`);
    for (const surface of surfaces) {
      ensure(
        validHalfOpenRect(surface?.boundsPx),
        `${label} Surface ${surface?.id ?? 'unknown'} has invalid screenshot bounds`,
      );
    }
    ensure(
      layout.contentHash === expectedContentHash(layout),
      `${label} contentHash is invalid`,
    );
    ensureSetEquals(
      refs,
      actualInstances.map((instance) => instance.id),
      `${label} does not reference exactly its ElementInstances`,
    );
    const aggregateRefs = new Set(pageInstance?.elementInstanceRefs ?? []);
    ensure(
      refs.every((ref) => aggregateRefs.has(ref)),
      `${label} contains ElementInstances outside its PageInstance aggregate`,
    );
    const collectedRefs = layoutElementRefsByPageInstance.get(layout.pageInstanceRef) ?? [];
    collectedRefs.push(...refs);
    layoutElementRefsByPageInstance.set(layout.pageInstanceRef, collectedRefs);
    const expectedRootRefs = actualInstances
      .filter((instance) => instance.parentInstanceRef === null || instance.parentInstanceRef === undefined)
      .map((instance) => instance.id);
    ensureSetEquals(
      layout.rootInstanceRefs ?? [],
      expectedRootRefs,
      `${label}.rootInstanceRefs must identify exactly the parentless instances`,
    );
    for (const rootRef of layout.rootInstanceRefs ?? []) {
      ensure(refs.includes(rootRef), `${label} rootInstanceRef ${rootRef} is not in elementInstanceRefs`);
    }
    for (const surface of surfaces) {
      ensure(
        expectedRootRefs.some(
          (rootRef) => elementInstanceById.get(rootRef)?.surfaceId === surface.id,
        ),
        `${label} Surface ${surface.id} has no root ElementInstance`,
      );
    }
    ensure(
      layout.pageState?.key === pageInstance?.state?.key &&
        layout.pageState?.properties?.selectedBottomTab === pageInstance?.state?.selectedBottomTab &&
        layout.transientState?.bottomSheet === pageInstance?.state?.transientState?.bottomSheet,
      `${label} state differs from its PageInstance`,
    );
    ensure(layout.stability?.settled === true, `${label} must be settled`);
    ensure(layout.captureCoverage?.complete === true, `${label} captureCoverage must be complete`);

    const screenshotGeometry = layout.screenshotGeometry;
    const layoutScreenshotRef = screenshotRefForLayout(pageInstance, layout.id);
    ensure(
      screenshotGeometry?.resourceRef === layoutScreenshotRef &&
        sameValue(screenshotGeometry?.pixelSize, SCREEN) &&
        sameValue(screenshotGeometry?.captureRectScreenPx, {
          x: 0,
          y: 0,
          ...PHYSICAL_SCREEN,
          space: 'screen_px',
        }) &&
        screenshotGeometry?.rotationDegrees === 0,
      `${label}.screenshotGeometry must bind the 1152x2376 capture to the 1344x2772 physical screen`,
    );
    const currentToScreen = (screenshotGeometry?.transforms ?? []).find(
      (transform) => transform.from === 'current_display_px' && transform.to === 'screen_px',
    );
    const screenToScreenshot = (screenshotGeometry?.transforms ?? []).find(
      (transform) => transform.from === 'screen_px' && transform.to === 'screenshot_px',
    );
    const expectedCurrentToScreen = [7 / 6, 0, 0, 0, 7 / 6, 0, 0, 0, 1];
    const expectedScreenToScreenshot = [6 / 7, 0, 0, 0, 6 / 7, 0, 0, 0, 1];
    ensure(
      expectedCurrentToScreen.every((value, index) =>
        approximatelyEqual(currentToScreen?.matrix3x3?.[index], value)) &&
        expectedScreenToScreenshot.every((value, index) =>
          approximatelyEqual(currentToScreen?.inverseMatrix3x3?.[index], value)),
      `${label} current_display_px <-> screen_px transform must use 7/6 and 6/7`,
    );
    ensure(
      expectedScreenToScreenshot.every((value, index) =>
        approximatelyEqual(screenToScreenshot?.matrix3x3?.[index], value)) &&
        expectedCurrentToScreen.every((value, index) =>
          approximatelyEqual(screenToScreenshot?.inverseMatrix3x3?.[index], value)),
      `${label} screen_px <-> screenshot_px transform must use 6/7 and 7/6`,
    );

    if (layout.transientState?.bottomSheet === 'open') {
      const overlay = (layout.surfaceStack ?? []).find((surface) => surface.id === 'surface.overlay.1');
      ensure(
        sameValue(overlay?.boundsPx, { x: 0, y: 897, width: 1152, height: 1292 }) &&
          overlay?.scrim?.visible === true &&
          sameValue(overlay?.scrim?.boundsPx, { x: 0, y: 0, width: 1152, height: 897 }) &&
          overlay?.scrim?.evidenceRef === layoutScreenshotRef,
        `${label} must model the drawer body and scrim as separate observed regions`,
      );
    }

    const sharedNavigationInstances = actualInstances.filter((instance) =>
      EXPECTED_SHARED_NAVIGATION_KEYS.has(elementById.get(instance.elementRef)?.key),
    );
    ensure(
      sharedNavigationInstances.length === EXPECTED_SHARED_NAVIGATION_KEYS.size,
      `${label} must contain exactly one bottom-navigation container and five tab instances`,
    );
    ensureSetEquals(
      sharedNavigationInstances.map((instance) => elementById.get(instance.elementRef)?.key),
      EXPECTED_SHARED_NAVIGATION_KEYS,
      `${label} shared bottom-navigation instances are incomplete`,
    );
    const navigationContainer = sharedNavigationInstances.find(
      (instance) => elementById.get(instance.elementRef)?.key === BOTTOM_NAVIGATION_KEY,
    );
    ensure(
      navigationContainer?.parentInstanceRef === null,
      `${label} bottom-navigation container must be a root ElementInstance`,
    );
    for (const tabKey of EXPECTED_BOTTOM_TAB_KEYS) {
      const tab = sharedNavigationInstances.find(
        (instance) => elementById.get(instance.elementRef)?.key === tabKey,
      );
      ensure(Boolean(tab), `${label} is missing ${tabKey}`);
      ensure(
        tab?.parentInstanceRef === navigationContainer?.id,
        `${label} ${tabKey} parentInstanceRef must reference its same-Frame bottom-navigation container`,
      );
    }

    const frame = frameById.get(layout.id);
    ensure(Boolean(frame), `${label} has no immutable source ExplorationFrame`);
    ensure(
      frame?.screenshotResourceRef === `sha256:${layout.fingerprints?.visualSha256}`,
      `${label} visual fingerprint differs from its source Frame`,
    );
    ensure(
      layout.extensions?.['com.zto.uikg.sourceFrameContentHash'] === frame?.contentHash,
      `${label} source Frame content hash is stale`,
    );
    ensure(
      layoutScreenshotRef === frame?.screenshotResourceRef,
      `${label} PageInstance screenshot differs from the source Frame`,
    );
    allLayoutElementRefs.push(...refs);
  }
  ensureSetEquals(
    allLayoutElementRefs,
    elementInstanceById.keys(),
    'LayoutSnapshots do not cover exactly all ElementInstances',
  );
  for (const pageInstance of pageInstances) {
    ensureSetEquals(
      layoutElementRefsByPageInstance.get(pageInstance.id) ?? [],
      pageInstance.elementInstanceRefs ?? [],
      `PageInstance ${pageInstance.id} ElementInstance aggregate differs from its LayoutSnapshots`,
    );
  }

  for (const trace of actionTraces) {
    const label = `ActionTrace ${trace.id}`;
    const transition = transitionById.get(trace.transitionRef);
    const sourceAction = evidenceActionById.get(trace.id);
    ensure(Boolean(transition), `${label} references unknown Transition`);
    ensure(Boolean(sourceAction), `${label} has no immutable ExplorationActionTrace`);
    ensure(trace.captureSessionRef === SESSION_ID, `${label} has the wrong captureSessionRef`);
    ensure(
      Array.isArray(trace.steps) && trace.steps.length === 1,
      `${label} must be the one-step projection of its source action`,
    );
    ensure(
      sourceAction?.sessionRef === SESSION_ID &&
        trace.result === 'success' &&
        sourceAction?.result === 'success',
      `${label} and its source action must both record a successful execution`,
    );
    ensure(
      trace.startedAt === sourceAction?.startedAt &&
        trace.endedAt === sourceAction?.endedAt &&
        trace.monotonicClock?.startNs === sourceAction?.monotonicStartNs &&
        trace.monotonicClock?.endNs === sourceAction?.monotonicEndNs,
      `${label} timing differs from its immutable source action`,
    );
    ensure(
      trace.extensions?.['com.zto.uikg.sourceTraceContentHash'] === sourceAction?.contentHash,
      `${label} source action content hash is stale`,
    );
    ensure(
      transition?.observationRefs?.includes(trace.id),
      `${label} is not listed in its generic Transition observationRefs`,
    );
    for (const step of trace.steps ?? []) {
      const stepLabel = `${label} step ${step.sequence}`;
      const beforeLayout = layoutById.get(step.beforeLayoutSnapshotRef);
      const afterLayout = layoutById.get(step.afterLayoutSnapshotRef);
      const beforePageInstance = pageInstanceById.get(beforeLayout?.pageInstanceRef);
      const afterPageInstance = pageInstanceById.get(afterLayout?.pageInstanceRef);
      const beforeFrame = frameById.get(sourceAction?.beforeFrameRef);
      const afterFrame = frameById.get(sourceAction?.afterFrameRef);
      const successOutcomes = (transition?.outcomes ?? []).filter(
        (outcome) => outcome.type === 'success',
      );
      const successOutcome = successOutcomes[0];
      ensure(Boolean(beforeLayout), `${label} has unknown before layout`);
      ensure(Boolean(afterLayout), `${label} has unknown after layout`);
      ensure(
        step.sequence === 1 &&
          step.beforeLayoutSnapshotRef === sourceAction?.beforeFrameRef &&
          step.afterLayoutSnapshotRef === sourceAction?.afterFrameRef,
        `${stepLabel} LayoutSnapshot refs differ from its immutable source action`,
      );
      ensure(
        step.startedAt === sourceAction?.startedAt &&
          step.monotonicOffsetNs === sourceAction?.monotonicStartNs &&
          approximatelyEqual(
            step.durationMs,
            ((sourceAction?.monotonicEndNs ?? 0) - (sourceAction?.monotonicStartNs ?? 0)) / 1e6,
            1e-6,
          ),
        `${stepLabel} timing differs from its immutable source action`,
      );
      ensure(
        sameValue(trace.resourceRefs, [
          beforeFrame?.screenshotResourceRef,
          afterFrame?.screenshotResourceRef,
        ]),
        `${label}.resourceRefs must bind the exact before/after source screenshots`,
      );
      ensure(
        successOutcomes.length === 1 &&
          navigationScope?.memberPageRefs?.includes(beforeLayout?.pageRef) &&
          beforePageInstance?.pageRef === beforeLayout?.pageRef &&
          transition?.sourceSelector?.navigationScopeRef === navigationScope?.id &&
          layoutSatisfiesTransitionState(afterLayout, afterPageInstance, successOutcome?.toState),
        `${stepLabel} before/after Page state does not match its Transition`,
      );
      ensure(elementById.has(step.target?.elementRef), `${label} has unknown target Element`);
      ensure(
        typeof step.target?.instanceRef === 'string' && step.target.instanceRef.length > 0,
        `${stepLabel} must reference its target ElementInstance`,
      );
      const targetInstance = elementInstanceById.get(step.target?.instanceRef);
      ensure(
        Boolean(targetInstance),
        `${stepLabel} references unknown target ElementInstance`,
      );
      ensure(
        targetInstance?.layoutSnapshotRef === step.beforeLayoutSnapshotRef,
        `${stepLabel} target instance is not in its before LayoutSnapshot`,
      );
      ensure(
        targetInstance?.elementRef === step.target?.elementRef &&
          step.target?.elementRef === transition?.trigger?.elementRef &&
          elementById.get(step.target?.elementRef)?.key === sourceAction?.targetCandidate?.key,
        `${stepLabel} target differs across ElementInstance, Transition, and source action`,
      );
      const coordinates = step.invocation?.coordinates;
      const sourcePhysicalInvocation = sourceAction?.invocation?.physical;
      ensure(
        step.invocation?.physicalGesture === 'tap' &&
          coordinates?.space === 'current_display_px' &&
          Number.isInteger(coordinates?.x) &&
          Number.isInteger(coordinates?.y),
        `${stepLabel} must declare integer tap coordinates in current_display_px`,
      );
      ensure(
        step.invocation?.semanticAction === transition?.trigger?.capability &&
          step.invocation?.semanticAction === sourceAction?.invocation?.semanticAction &&
          sameValue(step.invocation?.arguments, transition?.trigger?.arguments) &&
          sameValue(step.invocation?.arguments, sourceAction?.invocation?.arguments) &&
          sameValue(
            {
              physicalGesture: step.invocation?.physicalGesture,
              coordinates,
            },
            sourcePhysicalInvocation,
          ) &&
          sameValue(sourceAction?.targetCandidate?.point, [coordinates?.x, coordinates?.y]) &&
          sameValue(step.locatorAttempts, sourceAction?.locatorAttempts),
        `${stepLabel} invocation differs from its Transition or immutable source action`,
      );
      ensure(
        step.executionResult === 'success' && step.executionResult === sourceAction?.result,
        `${stepLabel} execution result does not prove the successful Transition outcome`,
      );
      const transforms = beforeLayout?.screenshotGeometry?.transforms ?? [];
      const currentToScreen = transforms.find(
        (transform) => transform.from === coordinates?.space && transform.to === 'screen_px',
      );
      const screenToScreenshot = transforms.find(
        (transform) => transform.from === 'screen_px' && transform.to === 'screenshot_px',
      );
      const screenPoint = coordinates ? applyMatrix3x3(currentToScreen?.matrix3x3, coordinates) : null;
      const screenshotPoint = screenPoint
        ? applyMatrix3x3(screenToScreenshot?.matrix3x3, screenPoint)
        : null;
      ensure(
        pointInHalfOpenRect(screenshotPoint, targetInstance?.geometry?.bbox),
        `${stepLabel} transformed screenshot point falls outside the target instance half-open bbox`,
      );
    }
  }
  ensureSetEquals(
    actionTraces.map((trace) => trace.id),
    evidenceActionById.keys(),
    'Runtime ActionTraces must project exactly all immutable ExplorationActionTraces',
  );
  ensureSetEquals(
    transitions.flatMap((transition) => transition.observationRefs ?? []),
    actionTraces.map((trace) => trace.id),
    'Generic Transition observationRefs must cover exactly the 5 ActionTraces',
  );
});

group('Independent drawer identity and per-Frame host context', () => {
  const drawerPage = pageByKey.get('app-drawer.root');
  const drawerPageInstances = pageInstances.filter(
    (instance) => instance.pageRef === drawerPage?.id,
  );
  ensure(drawerPageInstances.length === 1, 'Expected exactly one app-drawer.root PageInstance');
  const drawerPageInstance = drawerPageInstances[0];
  ensure(
    typeof drawerPageInstance?.presentationContextKey === 'string' &&
      !/host/i.test(drawerPageInstance.presentationContextKey) &&
      !navigationScope?.primaryPageRefs?.some(
        (pageRef) => drawerPageInstance.presentationContextKey.includes(pageRef),
      ),
    'Drawer PageInstance presentationContextKey must not encode its host Page',
  );

  const drawerLayouts = layouts.filter((layout) => layout.pageRef === drawerPage?.id);
  ensure(drawerLayouts.length > 0, 'app-drawer.root must have at least one observed LayoutSnapshot');
  for (const layout of drawerLayouts) {
    const label = `Drawer LayoutSnapshot ${layout.id}`;
    const context = layout.presentationContext;
    ensure(
      context?.activePageRef === drawerPage?.id &&
        context?.primaryPageRef === context?.hostPageRef &&
        navigationScope?.primaryPageRefs?.includes(context?.hostPageRef) &&
        context?.hostPageParticipatesInIdentity === false,
      `${label} must separate active drawer identity from its primary host Page`,
    );
    const incomingHostPageRefs = new Set();
    for (const trace of actionTraces) {
      for (const step of trace.steps ?? []) {
        if (step.afterLayoutSnapshotRef !== layout.id) continue;
        incomingHostPageRefs.add(layoutById.get(step.beforeLayoutSnapshotRef)?.pageRef);
      }
    }
    ensure(
      incomingHostPageRefs.size > 0 && incomingHostPageRefs.has(context?.hostPageRef),
      `${label} hostPageRef cannot be derived from its incoming ActionTrace`,
    );
  }
});

group('Presentation-group and page-observation screenshots', () => {
  const presentationAssets = projectionManifest?.assets?.elementPresentationImages ?? [];
  const pageAssets = projectionManifest?.assets?.pageObservationImages ?? [];
  ensure(
    presentationAssets.length === 27,
    `Expected 27 ElementPresentationGroup images, found ${presentationAssets.length}`,
  );
  ensure(pageAssets.length === 6, `Expected 6 Page observation images, found ${pageAssets.length}`);
  ensure(
    projectionManifest?.assets?.elementInstanceImages === undefined &&
      projectionManifest?.assets?.pageInstanceImages === undefined,
    'Legacy per-instance image asset collections must not be present',
  );

  const actualElementImages = listFiles(
    join(OBSIDIAN_ROOT, '资源', '元素实体'),
    (path) => /\.png$/i.test(path),
  ).map((path) => normalizePath(relative(OBSIDIAN_ROOT, path)));
  const actualPageImages = listFiles(
    join(OBSIDIAN_ROOT, '资源', '页面实体'),
    (path) => /\.png$/i.test(path),
  ).map((path) => normalizePath(relative(OBSIDIAN_ROOT, path)));
  ensureSetEquals(
    presentationAssets.map((asset) => asset.path),
    actualElementImages,
    'ElementPresentationGroup image descriptors do not match generated files',
  );
  ensureSetEquals(
    pageAssets.map((asset) => asset.path),
    actualPageImages,
    'Page observation image descriptors do not match generated files',
  );

  const seenPresentationGroups = new Set();
  const seenPresentationGroupKeys = new Set();
  const seenPresentationSignatureHashes = new Set();
  const presentedElementInstances = [];
  for (const asset of presentationAssets) {
    const label = `Presentation image ${asset.presentationGroupKey ?? asset.presentationGroupRef ?? asset.path}`;
    const representative = elementInstanceById.get(asset.representativeElementInstanceRef);
    const members = (asset.memberElementInstanceRefs ?? []).map((ref) => elementInstanceById.get(ref));
    ensure(
      typeof asset.presentationGroupRef === 'string' &&
        asset.presentationGroupRef.length > 0 &&
        !seenPresentationGroups.has(asset.presentationGroupRef),
      `${label} has a missing or duplicate presentationGroupRef`,
    );
    seenPresentationGroups.add(asset.presentationGroupRef);
    ensure(
      typeof asset.presentationGroupKey === 'string' &&
        asset.presentationGroupKey.length > 0 &&
        !seenPresentationGroupKeys.has(asset.presentationGroupKey),
      `${label} has a missing or duplicate presentationGroupKey`,
    );
    seenPresentationGroupKeys.add(asset.presentationGroupKey);
    ensure(Boolean(representative), `${label} references unknown representative ElementInstance`);
    ensure(
      Array.isArray(asset.memberElementInstanceRefs) &&
        asset.memberElementInstanceRefs.length > 0 &&
        new Set(asset.memberElementInstanceRefs).size === asset.memberElementInstanceRefs.length &&
        members.every(Boolean),
      `${label} has invalid memberElementInstanceRefs`,
    );
    ensure(
      asset.memberElementInstanceRefs.includes(asset.representativeElementInstanceRef),
      `${label} representative must be one of its members`,
    );
    ensure(
      members.every((instance) => instance?.presentationGroupRef === asset.presentationGroupRef),
      `${label} members do not point back to the presentation group`,
    );
    const signatureHashes = new Set(
      members.map((instance) => digest(canonicalJson(elementPresentationSignature(instance)))),
    );
    ensure(
      signatureHashes.size === 1,
      `${label} merges Runtime instances with different complete presentation signatures`,
    );
    const [signatureHash] = signatureHashes;
    ensure(
      typeof signatureHash === 'string' &&
        !seenPresentationSignatureHashes.has(signatureHash),
      `${label} duplicates another group's complete presentation signature`,
    );
    seenPresentationSignatureHashes.add(signatureHash);
    ensure(
      asset.presentationGroupKey === `${asset.elementKey}|signature:sha256:${signatureHash}` &&
        asset.presentationGroupRef === `presentation-group:sha256:${signatureHash}`,
      `${label} key/ref must be derived from the complete canonical presentation signature`,
    );
    const expectedMembers = elementInstances
      .filter((instance) => instance.presentationGroupRef === asset.presentationGroupRef)
      .map((instance) => instance.id);
    ensureSetEquals(
      asset.memberElementInstanceRefs,
      expectedMembers,
      `${label} does not cover exactly the Runtime members of its group`,
    );
    ensureSetEquals(
      asset.memberFrameRefs ?? [],
      members.map((instance) => instance?.layoutSnapshotRef),
      `${label} memberFrameRefs differ from its Runtime members`,
    );
    presentedElementInstances.push(...asset.memberElementInstanceRefs);

    ensure(
      asset.assetType === 'AnnotatedElementPresentationScreenshot',
      `${label} has the wrong assetType`,
    );
    ensure(asset.elementRef === representative?.elementRef, `${label} has the wrong elementRef`);
    ensure(asset.pageInstanceRef === representative?.pageInstanceRef, `${label} has the wrong pageInstanceRef`);
    ensure(asset.sourceFrameRef === representative?.layoutSnapshotRef, `${label} has the wrong sourceFrameRef`);
    ensure(
      asset.coordinateMappingRef === `${asset.sourceFrameRef}#screenshotGeometry`,
      `${label} has no explicit screenshot coordinate mapping`,
    );
    ensure(
      asset.sourceResourceRef === representative?.visualEvidence?.fullPageScreenshotRef,
      `${label} has the wrong sourceResourceRef`,
    );
    ensure(
      sameValue(asset.bbox, representative?.geometry?.bbox) &&
        sameValue(asset.centerPoint, representative?.geometry?.centerPoint),
      `${label} geometry differs from its representative ElementInstance`,
    );
    ensure(
      sameValue(asset.fullPageRect, { x: 0, y: 0, ...SCREEN, space: 'screenshot_px' }),
      `${label} must use a complete-page canvas`,
    );
    ensure(
      asset.sourcePixelSize?.width === SCREEN.width && asset.sourcePixelSize?.height === SCREEN.height,
      `${label} sourcePixelSize must be 1152x2376`,
    );

    const annotation = asset.annotation ?? {};
    ensure(
      annotation.shape === 'rectangle' &&
        annotation.stroke === '#FF0000' &&
        annotation.strokeWidthPx === 6 &&
        annotation.canvas === 'full_page' &&
        annotation.geometrySemantics === 'representative_visual_bounds' &&
        annotation.basis === representative?.geometry?.basis &&
        annotation.confidence === representative?.geometry?.confidence,
      `${label} must declare a 6px #FF0000 full-page rectangle`,
    );
    if (validHalfOpenRect(asset.bbox) && Number.isInteger(annotation.strokeWidthPx)) {
      ensure(
        sameValue(annotation.renderedAnnotationRect, expectedRenderedRect(asset.bbox)),
        `${label} rendered rectangle is not derived from its half-open bbox`,
      );
    }
    ensure(
      Number.isInteger(annotation.redPixelCountAdded) && annotation.redPixelCountAdded > 0,
      `${label} must report added red pixels`,
    );

    const imagePath = resolveProjectionPath(asset.path);
    const notePath = resolveProjectionPath(asset.notePath);
    const sourceResource = resourceById.get(asset.sourceResourceRef);
    const sourcePath = sourceResource ? resolve(EXPLORATION_ROOT, sourceResource.uri) : null;
    ensure(Boolean(imagePath) && existsSync(imagePath), `${label} PNG is missing or escapes the projection root`);
    ensure(Boolean(notePath) && existsSync(notePath), `${label} note is missing or escapes the projection root`);
    ensure(Boolean(sourcePath) && existsSync(sourcePath), `${label} immutable source PNG is missing`);
    if (!imagePath || !sourcePath || !existsSync(imagePath) || !existsSync(sourcePath)) continue;

    const header = pngHeader(imagePath);
    ensure(header.width === SCREEN.width && header.height === SCREEN.height, `${label} PNG must be 1152x2376`);
    ensure(statSync(imagePath).size === asset.byteLength, `${label} byteLength is stale`);
    ensure(sha256(imagePath) === asset.sha256, `${label} SHA-256 is stale`);
    try {
      const comparison = validateRedOverlay(
        sourcePath,
        imagePath,
        annotation.renderedAnnotationRect,
        annotation.strokeWidthPx,
      );
      ensure(
        comparison.changedToRed === annotation.redPixelCountAdded,
        `${label} changed ${comparison.changedToRed} pixels to red; manifest declares ${annotation.redPixelCountAdded}`,
      );
      ensure(
        comparison.unexpectedChanges === 0,
        `${label} changes ${comparison.unexpectedChanges} pixels outside the declared red stroke`,
      );
    } catch (error) {
      fail(`${label} pixel validation failed: ${error.message}`);
    }

    if (notePath && existsSync(notePath)) {
      const note = parseFrontmatter(yaml, notePath);
      ensure(note.data.type === 'ElementPresentationGroup', `${label} note type must be ElementPresentationGroup`);
      ensure(
        note.data.presentation_group_ref === asset.presentationGroupRef,
        `${label} note has the wrong presentation_group_ref`,
      );
      ensure(
        note.data.representative_element_instance_ref === asset.representativeElementInstanceRef,
        `${label} note has the wrong representative ElementInstance`,
      );
      ensureSetEquals(
        note.data.member_element_instance_refs ?? [],
        asset.memberElementInstanceRefs,
        `${label} note has stale member ElementInstances`,
      );
      ensure(
        sameValue(note.data.bbox, [asset.bbox.x, asset.bbox.y, asset.bbox.width, asset.bbox.height]) &&
          sameValue(note.data.center_point, [asset.centerPoint.x, asset.centerPoint.y]),
        `${label} note geometry differs from the representative Runtime instance`,
      );
      ensure(
        note.text.includes(`![[${asset.path}|640]]`),
        `${label} note does not embed its representative full-page annotation`,
      );
    }
  }
  ensureSetEquals(
    presentedElementInstances,
    elementInstanceById.keys(),
    'ElementPresentationGroups must partition exactly all 52 Runtime ElementInstances',
  );

  const seenLayouts = new Set();
  const seenPageObservationKeys = new Set();
  const primaryPageInstances = new Set();
  const supportingPageInstances = new Set();
  for (const asset of pageAssets) {
    const label = `Page observation image ${asset.pageKey ?? asset.layoutSnapshotRef ?? asset.path}`;
    const instance = pageInstanceById.get(asset.pageInstanceRef);
    const layout = layoutById.get(asset.layoutSnapshotRef);
    ensure(Boolean(instance), `${label} references unknown PageInstance`);
    ensure(Boolean(layout), `${label} references unknown LayoutSnapshot`);
    ensure(!seenLayouts.has(asset.layoutSnapshotRef), `${label} duplicates a LayoutSnapshot image`);
    seenLayouts.add(asset.layoutSnapshotRef);
    const observationKey = [
      asset.pageInstanceRef,
      asset.layoutSnapshotRef,
      asset.observationRole,
    ].join('|');
    ensure(
      !seenPageObservationKeys.has(observationKey),
      `${label} duplicates a (PageInstance, LayoutSnapshot, observationRole) descriptor`,
    );
    seenPageObservationKeys.add(observationKey);
    ensure(asset.assetType === 'PageObservationScreenshot', `${label} has the wrong assetType`);
    ensure(asset.pageRef === instance?.pageRef && layout?.pageRef === instance?.pageRef, `${label} has the wrong pageRef`);
    ensure(
      pageInstanceOwnsLayout(instance, asset.layoutSnapshotRef),
      `${label} LayoutSnapshot is not owned by its PageInstance`,
    );
    ensure(
      ['primary', 'supporting'].includes(asset.observationRole) &&
        asset.observationRole ===
          (asset.layoutSnapshotRef === instance?.layoutSnapshotRef ? 'primary' : 'supporting'),
      `${label} has the wrong observationRole`,
    );
    if (asset.observationRole === 'primary') primaryPageInstances.add(asset.pageInstanceRef);
    else supportingPageInstances.add(asset.pageInstanceRef);
    ensure(
      asset.coordinateMappingRef === `${asset.layoutSnapshotRef}#screenshotGeometry`,
      `${label} has no explicit screenshot coordinate mapping`,
    );
    ensure(
      asset.sourceResourceRef === screenshotRefForLayout(instance, asset.layoutSnapshotRef),
      `${label} has the wrong sourceResourceRef`,
    );
    ensure(
      asset.sourcePixelSize?.width === SCREEN.width && asset.sourcePixelSize?.height === SCREEN.height,
      `${label} sourcePixelSize must be 1152x2376`,
    );

    const imagePath = resolveProjectionPath(asset.path);
    const notePath = resolveProjectionPath(asset.notePath);
    const source = resourceById.get(asset.sourceResourceRef);
    ensure(Boolean(imagePath) && existsSync(imagePath), `${label} PNG is missing or escapes the projection root`);
    ensure(Boolean(notePath) && existsSync(notePath), `${label} note is missing or escapes the projection root`);
    if (imagePath && existsSync(imagePath)) {
      const header = pngHeader(imagePath);
      ensure(header.width === SCREEN.width && header.height === SCREEN.height, `${label} PNG must be 1152x2376`);
      ensure(statSync(imagePath).size === asset.byteLength, `${label} byteLength is stale`);
      ensure(sha256(imagePath) === asset.sha256, `${label} SHA-256 is stale`);
      ensure(asset.sha256 === source?.sha256, `${label} must be the unmodified immutable source screenshot`);
    }
    if (notePath && existsSync(notePath)) {
      const note = parseFrontmatter(yaml, notePath);
      ensure(note.data.type === 'PageInstance', `${label} note type must be PageInstance`);
      ensure(note.data.uikg_id === instance?.id, `${label} note has the wrong uikg_id`);
      ensure(
        note.data.app_package === EXPECTED_BUILD.packageId &&
          note.data.app_version === EXPECTED_BUILD.versionName &&
          String(note.data.app_version_code) === EXPECTED_BUILD.versionCode,
        `${label} note has stale build properties`,
      );
      ensure(
        note.text.includes(`![[${asset.path}|640]]`),
        `${label} PageInstance note does not embed this primary/supporting screenshot`,
      );
    }
  }
  ensureSetEquals(seenLayouts, layoutById.keys(), 'Every LayoutSnapshot must have exactly one page observation image');
  ensureSetEquals(
    primaryPageInstances,
    pageInstanceById.keys(),
    'Every PageInstance must have exactly one primary page observation image',
  );
  ensure(
    supportingPageInstances.size === 1 &&
      supportingPageInstances.has(
        pageInstances.find((instance) => instance.pageRef === pageByKey.get('messages.root')?.id)?.id,
      ),
    'Only the messages PageInstance may have the one supporting page observation image',
  );
});
group('Query-time NavigationTopology', () => {
  const legacyNavigationRoot = join(OBSIDIAN_ROOT, '导航关系');
  ensure(
    !existsSync(legacyNavigationRoot),
    'Legacy destination-by-destination navigation cards must not be materialized',
  );

  const topologyRoot = join(OBSIDIAN_ROOT, '导航路网');
  const topologyFiles = listFiles(topologyRoot, (path) => /\.md$/i.test(path));
  ensure(
    topologyFiles.length === 1,
    `Expected 1 NavigationTopology card, found ${topologyFiles.length}`,
  );
  ensure(
    basename(topologyFiles[0] ?? '') === EXPECTED_NAVIGATION_TOPOLOGY_FILE,
    'NavigationTopology card has the wrong filename',
  );

  const topologyFile = topologyFiles[0];
  if (!topologyFile) return;
  const { data, text } = parseFrontmatter(yaml, topologyFile);
  ensure(
    data.type === 'NavigationTopology' && data.projectionType === 'NavigationTopology',
    `${graphRelative(topologyFile)} must be a NavigationTopology projection`,
  );
  ensure(data.applicationRef === applications[0]?.id, `${graphRelative(topologyFile)} applicationRef is invalid`);
  ensure(
    data.navigation_scope_ref === navigationScope?.id,
    `${graphRelative(topologyFile)} navigation_scope_ref is invalid`,
  );
  ensure(
    data.node_count === pages.length && data.edge_count === transitions.length,
    `${graphRelative(topologyFile)} node/edge counts differ from the canonical graph`,
  );
  ensure(
    data.route_materialization === 'query_time' && data.read_only === true,
    `${graphRelative(topologyFile)} must materialize routes only at query time`,
  );
  ensure(
    resolveReferencedFile(topologyFile, data.canonical_source) ===
      join(APP_ROOT, 'transitions', 'first-level-navigation.yaml'),
    `${graphRelative(topologyFile)} canonical_source is invalid`,
  );
  let materializedRouteField = null;
  walk(data, (_value, path) => {
    if (['sourceRoutes', 'shortestPaths', 'conventionalPaths', 'unreachableFrom'].includes(path.at(-1))) {
      materializedRouteField = path.join('.');
    }
  });
  ensure(
    materializedRouteField === null,
    `${graphRelative(topologyFile)} must not persist all-pairs route field ${materializedRouteField}`,
  );
  ensure(
    text.includes('query_navigation_paths.mjs'),
    `${graphRelative(topologyFile)} must identify the query-time route entry point`,
  );

  const successfulOutcome = (transition) =>
    (transition.outcomes ?? []).find((outcome) => outcome.type === 'success');
  const commonUsageSampleCount = transitions.reduce(
    (count, transition) => count + (transition.routing?.commonUsage?.sampleCount ?? 0),
    0,
  );
  const executionObservationCount = transitions.reduce(
    (count, transition) => count + (transition.observationRefs?.length ?? 0),
    0,
  );
  const commonProfile = navigationScope?.routingProfiles?.common ?? {};
  ensure(commonUsageSampleCount === 0, 'Common-route user-navigation usage must currently be zero');
  ensure(
    executionObservationCount === actionTraces.length,
    'Execution observations must be counted separately from common-route usage',
  );
  ensure(
    commonUsageSampleCount < (commonProfile.minimumObservationCount ?? Number.POSITIVE_INFINITY) &&
      commonProfile.insufficientDataFallback === 'shortest',
    'The under-sampled common profile must explicitly fall back to shortest',
  );

  const edgeWeight = (transition, profile) => {
    const actionCost = transition.routing?.actionCost;
    if (profile !== 'common') return actionCost;
    const alpha = commonProfile.smoothingAlpha ?? 1;
    const usageWeight = commonProfile.usageWeight ?? 1;
    const observations = transition.routing?.commonUsage?.sampleCount ?? 0;
    const probability =
      (observations + alpha) /
      (commonUsageSampleCount + alpha * transitions.length);
    return actionCost + usageWeight * -Math.log(probability);
  };
  const effectiveProfile = (requestedProfile) =>
    requestedProfile === 'common' &&
    commonUsageSampleCount < (commonProfile.minimumObservationCount ?? Number.POSITIVE_INFINITY)
      ? commonProfile.insufficientDataFallback
      : requestedProfile;
  const shortestRoute = (sourcePageRef, destinationPageRef, requestedProfile) => {
    const profile = effectiveProfile(requestedProfile);
    const distances = new Map([[sourcePageRef, 0]]);
    const hops = new Map([[sourcePageRef, 0]]);
    const previous = new Map();
    const pending = [{ pageRef: sourcePageRef, cost: 0, hops: 0 }];
    while (pending.length > 0) {
      pending.sort(
        (left, right) =>
          left.cost - right.cost ||
          left.hops - right.hops ||
          left.pageRef.localeCompare(right.pageRef),
      );
      const current = pending.shift();
      if (current.cost !== distances.get(current.pageRef)) continue;
      if (current.pageRef === destinationPageRef) break;
      for (const transition of transitions) {
        if (
          transition.sourceSelector?.kind !== 'navigation_scope' ||
          transition.sourceSelector?.navigationScopeRef !== navigationScope?.id
        ) {
          continue;
        }
        const outcome = successfulOutcome(transition);
        const nextPageRef = outcome?.toState?.pageRef;
        if (!pageById.has(nextPageRef) || nextPageRef === current.pageRef) continue;
        const candidateCost = current.cost + edgeWeight(transition, profile);
        const candidateHops = current.hops + 1;
        const knownCost = distances.get(nextPageRef) ?? Number.POSITIVE_INFINITY;
        const knownHops = hops.get(nextPageRef) ?? Number.POSITIVE_INFINITY;
        if (
          candidateCost < knownCost ||
          (approximatelyEqual(candidateCost, knownCost) && candidateHops < knownHops)
        ) {
          distances.set(nextPageRef, candidateCost);
          hops.set(nextPageRef, candidateHops);
          previous.set(nextPageRef, { from: current.pageRef, transition });
          pending.push({ pageRef: nextPageRef, cost: candidateCost, hops: candidateHops });
        }
      }
    }
    if (!distances.has(destinationPageRef)) return null;
    const transitionRefs = [];
    let cursor = destinationPageRef;
    while (cursor !== sourcePageRef) {
      const edge = previous.get(cursor);
      if (!edge) return null;
      transitionRefs.push(edge.transition.id);
      cursor = edge.from;
    }
    transitionRefs.reverse();
    return {
      requestedProfile,
      effectiveProfile: profile,
      cost: distances.get(destinationPageRef),
      transitionRefs,
    };
  };

  for (const sourcePage of pages) {
    for (const destinationPage of pages) {
      const shortest = shortestRoute(sourcePage.id, destinationPage.id, 'shortest');
      const common = shortestRoute(sourcePage.id, destinationPage.id, 'common');
      const expectedLength = sourcePage.id === destinationPage.id ? 0 : 1;
      ensure(
        shortest?.transitionRefs?.length === expectedLength,
        `Dynamic shortest route ${sourcePage.key} -> ${destinationPage.key} is invalid`,
      );
      if (sourcePage.id !== destinationPage.id) {
        ensure(
          common?.effectiveProfile === 'shortest' &&
            sameValue(common?.transitionRefs, shortest?.transitionRefs),
          `Dynamic common route ${sourcePage.key} -> ${destinationPage.key} must fall back to shortest`,
        );
      }
    }
  }

  for (const page of pages) {
    const notePath = join(OBSIDIAN_ROOT, '页面', `${PAGE_TITLES[page.key]}.md`);
    ensure(existsSync(notePath), `Page projection is missing for ${page.key}`);
    if (!existsSync(notePath)) continue;
    ensure(
      readFileSync(notePath, 'utf8').includes('[[导航路网/一级底部导航路网'),
      `Page card ${PAGE_TITLES[page.key]} does not link to the NavigationTopology`,
    );
  }
});
function validateDeliveryManifest(manifest, manifestPath, artifactRoot, expectedType) {
  ensure(manifest?.manifestType === expectedType, `${graphRelative(manifestPath)} has the wrong manifestType`);
  ensure(manifest?.schemaVersion === SCHEMA_VERSION, `${graphRelative(manifestPath)} has the wrong schemaVersion`);
  ensure(manifest?.manifestVersion === MANIFEST_VERSION, `${graphRelative(manifestPath)} has the wrong manifestVersion`);
  ensure(manifest?.graphRevision === GRAPH_REVISION, `${graphRelative(manifestPath)} has a stale graphRevision`);
  ensure(
    manifest?.hashAlgorithm === 'sha256(sorted-entry-and-resource-descriptors-v1)',
    `${graphRelative(manifestPath)} has the wrong hashAlgorithm`,
  );

  const actualYamlFiles = listFiles(
    artifactRoot,
    (path) => /\.ya?ml$/i.test(path) && path !== manifestPath,
  );
  const actualRelativePaths = actualYamlFiles.map((path) => normalizePath(relative(artifactRoot, path)));
  const entries = manifest?.entries ?? [];
  ensureSetEquals(
    entries.map((entry) => entry.path),
    actualRelativePaths,
    `${graphRelative(manifestPath)} entries do not cover exactly the YAML artifacts`,
  );
  for (const entry of entries) {
    const path = resolve(artifactRoot, entry.path ?? '');
    const inside = path.startsWith(`${artifactRoot}${sep}`);
    if (!ensure(inside, `${graphRelative(manifestPath)} entry escapes artifact root: ${entry.path}`)) continue;
    if (!ensure(existsSync(path), `${graphRelative(manifestPath)} entry is missing: ${entry.path}`)) continue;
    ensure(entry.mediaType === 'application/yaml', `${entry.path} has the wrong mediaType`);
    ensure(statSync(path).size === entry.byteLength, `${entry.path} byteLength is stale`);
    ensure(sha256(path) === entry.sha256, `${entry.path} SHA-256 is stale`);
    ensure(
      readYamlDocuments(yaml, path).length === entry.entityCount,
      `${entry.path} entityCount is stale`,
    );
  }

  const declaredResources = new Map(
    (manifest?.resources ?? []).map((resource) => [`sha256:${resource.sha256}`, resource]),
  );
  ensureSetEquals(
    declaredResources.keys(),
    resourceById.keys(),
    `${graphRelative(manifestPath)} resources differ from immutable evidence`,
  );
  for (const [id, evidence] of resourceById) {
    const declared = declaredResources.get(id);
    if (!declared) continue;
    ensure(
      declared.byteLength === evidence.byteLength && declared.mediaType === evidence.mediaType,
      `${graphRelative(manifestPath)} has stale resource metadata for ${id}`,
    );
  }
  ensure(
    manifest?.rootHash === descriptorRootHash(manifest),
    `${graphRelative(manifestPath)} rootHash is stale`,
  );
}

group('Canonical, runtime, and projection manifests', () => {
  validateDeliveryManifest(
    canonicalManifest,
    CANONICAL_MANIFEST_PATH,
    APP_ROOT,
    'CanonicalGraphManifest',
  );
  validateDeliveryManifest(
    runtimeManifest,
    RUNTIME_MANIFEST_PATH,
    RUNTIME_ROOT,
    'RuntimeCaptureManifest',
  );
  ensure(canonicalManifest?.applicationRef === applications[0]?.id, 'Canonical manifest has the wrong applicationRef');
  ensure(runtimeManifest?.applicationRef === applications[0]?.id, 'Runtime manifest has the wrong applicationRef');
  ensure(runtimeManifest?.captureSessionRef === SESSION_ID, 'Runtime manifest has the wrong captureSessionRef');
  validateAppBuild(runtimeManifest?.appBuild, 'Runtime manifest appBuild');
  ensure(
    (canonicalManifest?.entries ?? []).every(
      (entry) =>
        !entry.path.startsWith('entities/') &&
        !entry.path.startsWith('releases/') &&
        !entry.path.includes('/variants/'),
    ),
    'Canonical manifest contains legacy entities/releases/variants entries',
  );
  ensure(
    (canonicalManifest?.entries ?? []).some((entry) => entry.path.startsWith('elements/')),
    'Canonical manifest does not contain elements/ entries',
  );
  ensure(
    (runtimeManifest?.entries ?? []).some((entry) => entry.path === 'page-instances.yaml') &&
      (runtimeManifest?.entries ?? []).some((entry) => entry.path === 'element-instances.yaml'),
    'Runtime manifest must contain page-instances.yaml and element-instances.yaml',
  );
  ensure(
    runtimeManifest?.sourceEvidenceManifestRef === evidenceManifest?.rootHash,
    'Runtime manifest sourceEvidenceManifestRef is stale',
  );

  ensure(projectionManifest?.manifestType === 'ObsidianProjectionManifest', 'Projection manifest has the wrong manifestType');
  ensure(projectionManifest?.source?.graphRevision === GRAPH_REVISION, 'Projection manifest has a stale graphRevision');
  ensure(projectionManifest?.source?.rootHash === canonicalManifest?.rootHash, 'Projection manifest has a stale Canonical rootHash');
  ensure(
    resolveReferencedFile(PROJECTION_MANIFEST_PATH, projectionManifest?.source?.canonicalManifest) === CANONICAL_MANIFEST_PATH,
    'Projection manifest canonicalManifest source is invalid',
  );
  ensure(
    resolveReferencedFile(PROJECTION_MANIFEST_PATH, projectionManifest?.source?.runtimeManifest) === RUNTIME_MANIFEST_PATH,
    'Projection manifest runtimeManifest source is invalid',
  );
  ensureSetEquals(
    projectionManifest?.scope?.pageKeys ?? [],
    pageByKey.keys(),
    'Projection manifest scope must contain all five Page keys',
  );
  ensureSetEquals(
    projectionManifest?.scope?.primaryPageKeys ?? [],
    pages.filter((page) => page.key !== 'app-drawer.root').map((page) => page.key),
    'Projection manifest primaryPageKeys are stale',
  );
  ensureSetEquals(
    projectionManifest?.scope?.overlayPageKeys ?? [],
    ['app-drawer.root'],
    'Projection manifest overlayPageKeys must contain the independent drawer Page',
  );
  ensureSetEquals(
    projectionManifest?.scope?.navigationScopeRefs ?? [],
    navigationScopeById.keys(),
    'Projection manifest navigationScopeRefs are stale',
  );
  ensure(
    projectionManifest?.scope?.transientSurfaceKeys === undefined,
    'Projection manifest must not model the drawer as a transient surface key',
  );
});

group('Obsidian projection and Vault layout', () => {
  const vaultConfig = join(KNOWLEDGE_GRAPH_ROOT, '.obsidian');
  const forbiddenNestedVault = join(KNOWLEDGE_GRAPH_ROOT, 'obsidian', '.obsidian');
  ensure(existsSync(vaultConfig) && statSync(vaultConfig).isDirectory(), 'knowledge_graph/.obsidian Vault config is missing');
  ensure(existsSync(join(vaultConfig, 'app.json')), 'knowledge_graph/.obsidian/app.json is missing');
  ensure(!existsSync(forbiddenNestedVault), 'obsidian/.obsidian must not exist');
  // workspace.json is mutable editor session state, not a graph or projection artifact.
  ensure(
    resolve(dirname(PROJECTION_MANIFEST_PATH), projectionManifest?.projection?.vaultRoot ?? '') === KNOWLEDGE_GRAPH_ROOT,
    'Projection manifest vaultRoot must resolve to knowledge_graph/',
  );
  ensure(
    resolve(
      KNOWLEDGE_GRAPH_ROOT,
      projectionManifest?.projection?.vaultRelativeEntryPoint ?? '',
    ) === join(OBSIDIAN_ROOT, '中通宝盒-知识图谱首页.md'),
    'Projection manifest has the wrong Vault-relative entry point',
  );

  const requiredDirectories = [
    '元素',
    '元素实体',
    '页面',
    '页面实体',
    '导航路网',
    '待确认知识',
    '探索报告',
    '设备',
    '资源/元素实体',
    '资源/页面实体',
  ];
  for (const directory of requiredDirectories) {
    ensure(existsSync(join(OBSIDIAN_ROOT, directory)), `Required Chinese projection directory is missing: ${directory}`);
  }
  ensure(!existsSync(join(OBSIDIAN_ROOT, '导航关系')), 'Legacy 导航关系 directory must not exist');

  markdownFiles = listFiles(OBSIDIAN_ROOT, (path) => /\.md$/i.test(path));
  ensure(markdownFiles.length > 0, 'Obsidian projection contains no Markdown notes');
  for (const file of markdownFiles) {
    ensure(/[\p{Script=Han}]/u.test(basename(file)), `${graphRelative(file)} needs a Chinese filename`);
    const parsed = parseFrontmatter(yaml, file);
    frontmatterByFile.set(file, parsed);
    ensure(parsed.data.read_only === true, `${graphRelative(file)} must be marked read_only`);
    for (const key of ['canonical_source', 'runtime_source']) {
      if (parsed.data[key] !== undefined) {
        ensure(
          Boolean(resolveReferencedFile(file, parsed.data[key])),
          `${graphRelative(file)} has an invalid ${key}`,
        );
      }
    }
  }

  const declaredMarkdown = [];
  walk(projectionManifest?.files ?? {}, (value) => {
    if (typeof value === 'string') declaredMarkdown.push(value);
  });
  const actualMarkdown = markdownFiles.map((path) => normalizePath(relative(OBSIDIAN_ROOT, path)));
  ensure(
    declaredMarkdown.length === new Set(declaredMarkdown).size,
    'Projection manifest must assign each Markdown note to exactly one file category',
  );
  ensureSetEquals(
    declaredMarkdown,
    actualMarkdown,
    'Projection manifest files do not cover exactly the generated Markdown notes',
  );
  ensure(
    declaredMarkdown.every(
      (path) => path.split('/').every((segment) => !segment.startsWith('.')),
    ),
    'Projection manifest contains an Obsidian-invisible dot-prefixed path',
  );

  const fileKeyByType = new Map([
    ['UIKG-Projection-Index', 'index'],
    ['Application', 'applications'],
    ['Page', 'pages'],
    ['PageInstance', 'pageInstances'],
    ['Element', 'elements'],
    ['ElementPresentationGroup', 'elementPresentationGroups'],
    ['NavigationTopology', 'navigationTopologies'],
    ['Observation', 'observations'],
    ['ExplorationCoverage', 'coverage'],
    ['DeviceSnapshot', 'devices'],
  ]);
  const expectedFiles = Object.fromEntries(
    [
      'index',
      'applications',
      'pages',
      'pageInstances',
      'elements',
      'elementPresentationGroups',
      'navigationTopologies',
      'observations',
      'coverage',
      'devices',
    ].map((key) => [key, []]),
  );
  const projectedTypeCounts = new Map();
  const unsupportedProjectionNotes = [];
  for (const [file, { data }] of frontmatterByFile) {
    projectedTypeCounts.set(data.type, (projectedTypeCounts.get(data.type) ?? 0) + 1);
    const key = fileKeyByType.get(data.type);
    if (key) expectedFiles[key].push(normalizePath(relative(OBSIDIAN_ROOT, file)));
    else unsupportedProjectionNotes.push(graphRelative(file));
  }
  ensureSetEquals(
    Object.keys(projectionManifest?.files ?? {}),
    Object.keys(expectedFiles),
    'Projection manifest file categories are incomplete',
  );
  for (const [key, expected] of Object.entries(expectedFiles)) {
    ensureSetEquals(
      projectionManifest?.files?.[key] ?? [],
      expected,
      `Projection file category ${key} is stale`,
    );
  }
  ensure(
    unsupportedProjectionNotes.length === 0,
    `Projection contains unsupported or legacy note types: ${unsupportedProjectionNotes.join(', ')}`,
  );

  const expectedCounts = {
    markdownNotes: markdownFiles.length,
    applications: projectedTypeCounts.get('Application') ?? 0,
    pages: projectedTypeCounts.get('Page') ?? 0,
    pageInstances: projectedTypeCounts.get('PageInstance') ?? 0,
    elements: projectedTypeCounts.get('Element') ?? 0,
    elementPresentationGroups: projectedTypeCounts.get('ElementPresentationGroup') ?? 0,
    transitions: transitions.length,
    navigationScopes: navigationScopes.length,
    navigationTopologies: projectedTypeCounts.get('NavigationTopology') ?? 0,
    observations: projectedTypeCounts.get('Observation') ?? 0,
    coverageRecords: projectedTypeCounts.get('ExplorationCoverage') ?? 0,
    deviceSnapshots: projectedTypeCounts.get('DeviceSnapshot') ?? 0,
    runtimeElementInstances: elementInstances.length,
    elementPresentationImages:
      projectionManifest?.assets?.elementPresentationImages?.length ?? 0,
    pageObservationImages:
      projectionManifest?.assets?.pageObservationImages?.length ?? 0,
  };
  ensureSetEquals(
    Object.keys(projectionManifest?.counts ?? {}),
    Object.keys(expectedCounts),
    'Projection manifest count fields are incomplete or contain legacy values',
  );
  for (const [key, expected] of Object.entries(expectedCounts)) {
    ensure(
      projectionManifest?.counts?.[key] === expected,
      `Projection count ${key} must be ${expected}, found ${projectionManifest?.counts?.[key]}`,
    );
  }

  for (const [type, expected] of [
    ['UIKG-Projection-Index', 1],
    ['Application', 1],
    ['Page', pages.length],
    ['PageInstance', pageInstances.length],
    ['Element', elements.length],
    ['ElementInstance', 0],
    ['ElementPresentationGroup', 27],
    ['NavigationProjection', 0],
    ['NavigationTopology', 1],
    ['Observation', observations.length],
    ['ExplorationCoverage', coverageRecords.length],
    ['DeviceSnapshot', devices.length],
  ]) {
    ensure((projectedTypeCounts.get(type) ?? 0) === expected, `Expected ${expected} ${type} notes`);
  }
  ensure(
    !(projectionManifest?.files?.pageInstances ?? []).some((path) => path.includes('消息-探索结束')),
    'The obsolete 消息-探索结束 PageInstance note must not exist',
  );

  const declaredMarkdownSet = new Set(declaredMarkdown);
  for (const asset of projectionManifest?.assets?.elementPresentationImages ?? []) {
    ensure(
      declaredMarkdownSet.has(asset.notePath) &&
        (projectionManifest?.files?.elementPresentationGroups ?? []).includes(asset.notePath),
      `ElementPresentation image ${asset.path} has an undeclared presentation-group note`,
    );
  }
  for (const asset of projectionManifest?.assets?.pageObservationImages ?? []) {
    ensure(
      declaredMarkdownSet.has(asset.notePath) &&
        (projectionManifest?.files?.pageInstances ?? []).includes(asset.notePath),
      `Page observation image ${asset.path} has an undeclared PageInstance note`,
    );
  }
});
group('Immutable exploration evidence integrity', () => {
  ensure(evidenceManifest?.manifestType === 'ExplorationEvidenceManifest', 'Evidence manifest has the wrong type');
  ensure(evidenceManifest?.sessionRef === SESSION_ID, 'Evidence manifest has the wrong sessionRef');
  ensure(evidenceSession?.id === SESSION_ID, 'Evidence session has the wrong id');
  ensure(evidenceSession?.status === 'completed', 'Evidence session must be completed');
  validateUniqueIndex(evidenceResources, resourceById, 'id', 'ExplorationResource');
  validateUniqueIndex(evidenceFrames, frameById, 'id', 'ExplorationFrame');
  validateUniqueIndex(evidenceActions, evidenceActionById, 'id', 'ExplorationActionTrace');

  const evidenceRecords = [
    evidenceManifest,
    evidenceSession,
    ...evidenceFrames,
    ...evidenceActions,
    ...evidenceObservations,
    ...evidenceResources,
  ];
  for (const record of evidenceRecords) {
    const label = `${record?.recordType ?? record?.manifestType ?? 'evidence'}:${record?.id ?? record?.sessionRef ?? 'unknown'}`;
    ensure(typeof record?.contentHash === 'string', `${label} has no contentHash`);
    ensure(record?.contentHash === expectedContentHash(record), `${label} contentHash is invalid`);
  }
  ensure(
    evidenceManifest?.rootHash === `sha256:${digest(canonicalJson(evidenceManifest?.entries ?? []))}`,
    'Evidence manifest rootHash is invalid',
  );

  for (const entry of evidenceManifest?.entries ?? []) {
    const path = resolve(EXPLORATION_ROOT, entry.path ?? '');
    if (!ensure(path.startsWith(`${EXPLORATION_ROOT}${sep}`), `Evidence entry escapes package: ${entry.path}`)) continue;
    if (!ensure(existsSync(path), `Evidence entry is missing: ${entry.path}`)) continue;
    ensure(statSync(path).size === entry.byteLength, `Evidence entry byteLength is invalid: ${entry.path}`);
    ensure(sha256(path) === entry.sha256, `Evidence entry SHA-256 is invalid: ${entry.path}`);
  }

  const manifestResourceById = new Map(
    (evidenceManifest?.resources ?? []).map((resource) => [resource.id, resource]),
  );
  ensureSetEquals(manifestResourceById.keys(), resourceById.keys(), 'Evidence manifest and resource index differ');
  for (const [id, resource] of resourceById) {
    const path = resolve(EXPLORATION_ROOT, resource.uri ?? '');
    const declared = manifestResourceById.get(id);
    if (!ensure(path.startsWith(`${EXPLORATION_ROOT}${sep}`), `Evidence resource escapes package: ${id}`)) continue;
    if (!ensure(existsSync(path), `Evidence resource is missing: ${id}`)) continue;
    ensure(statSync(path).size === resource.byteLength, `Evidence resource byteLength is invalid: ${id}`);
    ensure(sha256(path) === resource.sha256, `Evidence resource SHA-256 is invalid: ${id}`);
    ensure(id === `sha256:${resource.sha256}`, `Evidence resource id is invalid: ${id}`);
    ensure(
      declared?.sha256 === resource.sha256 &&
        declared?.byteLength === resource.byteLength &&
        declared?.mediaType === resource.mediaType,
      `Evidence manifest metadata is invalid: ${id}`,
    );
    const descriptor = `${resource.mediaType ?? ''} ${resource.uri ?? ''} ${resource.metadata?.captureSource ?? ''}`;
    ensure(
      !/(?:\.xml\b|uiautomator|poco|accessibility[._ -]?tree|ui[._ -]?tree)/i.test(descriptor),
      `Forbidden UI/Poco tree evidence is present: ${id}`,
    );
  }

  ensure(evidenceFrames.length === 6, `Expected 6 immutable Frames, found ${evidenceFrames.length}`);
  ensure(evidenceActions.length === 5, `Expected 5 immutable action traces, found ${evidenceActions.length}`);
  ensure(
    evidenceSession?.bootstrap?.startedFromWakefulness === 'Asleep' &&
      evidenceSession?.bootstrap?.deviceLockedAfterUnlock === false &&
      evidenceSession?.bootstrap?.coldStart === true &&
      (evidenceSession?.bootstrap?.launchOutputSummary ?? []).some((line) => /LaunchState:\s*COLD\b/.test(line)),
    'Evidence session must preserve the verified cold-start/unlock sequence',
  );
  for (const frame of evidenceFrames) {
    ensure(
      frame.activeApplication?.packageId === EXPECTED_BUILD.packageId &&
        frame.activeApplication?.activity === EXPECTED_ACTIVITY,
      `ExplorationFrame ${frame.id} has the wrong foreground component`,
    );
    ensure(
      frame.screen?.screenshotPixelSize?.width === SCREEN.width &&
        frame.screen?.screenshotPixelSize?.height === SCREEN.height,
      `ExplorationFrame ${frame.id} must be 1152x2376`,
    );
    ensure(frame.stability?.settled === true, `ExplorationFrame ${frame.id} is not settled`);
    for (const ref of frame.resourceRefs ?? []) {
      ensure(resourceById.has(ref), `ExplorationFrame ${frame.id} references unknown resource ${ref}`);
    }
  }
});

group('Declared first-level exploration boundaries', () => {
  const coverage = coverageRecords[0];
  validateAppBuild(coverage?.appBuild, 'ExplorationCoverage.appBuild');
  ensure(coverage?.scope?.navigationDepth === 1, 'Coverage navigationDepth must be 1');
  ensure(coverage?.scope?.viewportOnly === true, 'Coverage must be viewport-only');
  ensure(coverage?.quality?.completeForDeclaredScope === true, 'Coverage must be complete for its declared scope');
  ensure(coverage?.instanceCounts?.pages === 5, 'Coverage must report 5 PageInstances');
  ensure(coverage?.instanceCounts?.elements === 52, 'Coverage must report 52 ElementInstances');
  ensureSetEquals(
    coverage?.observed?.pageRefs ?? [],
    pageById.keys(),
    'Coverage observed.pageRefs must contain all five canonical Pages',
  );
  ensureSetEquals(
    coverage?.observed?.pageInstanceRefs ?? [],
    pageInstanceById.keys(),
    'Coverage observed.pageInstanceRefs must contain all five PageInstances',
  );
  ensure(
    coverage?.elementCounts?.workbenchInternal === 0 && coverage?.elementCounts?.newsInternal === 0,
    'Workbench and news internal Elements must remain unexplored',
  );
  ensure(coverage?.elementCounts?.appDrawerEntries === 15, 'Coverage must report 15 drawer entry Elements');

  const workbench = pageByKey.get('workbench.root');
  const news = pageByKey.get('news.root');
  const drawerPage = pageByKey.get('app-drawer.root');
  const drawer = elementByKey.get('shared.app_drawer');
  const boundaryByPage = new Map(
    (coverage?.boundaries ?? [])
      .filter((boundary) => boundary.pageRef)
      .map((boundary) => [boundary.pageRef, boundary]),
  );
  ensure(
    boundaryByPage.get(workbench?.id)?.internalActionsAttempted === 0,
    'Workbench boundary must have zero internal actions',
  );
  ensure(
    boundaryByPage.get(news?.id)?.internalActionsAttempted === 0,
    'News boundary must have zero internal actions',
  );
  const drawerBoundary = (coverage?.boundaries ?? []).find(
    (boundary) => boundary.pageRef === drawerPage?.id,
  );
  const drawerEntryIds = elements
    .filter((element) => element.parentElementRef === drawer?.id)
    .map((element) => element.id);
  ensure(drawerBoundary?.visibleEntryCount === 15, 'Drawer boundary must report 15 visible entries');
  ensure(drawerBoundary?.entryActivationsAttempted === 0, 'Drawer entries must not have been activated');
  ensureSetEquals(
    drawerBoundary?.visibleEntryElementRefs ?? [],
    drawerEntryIds,
    'Drawer boundary does not identify exactly the 15 entry Elements',
  );
  ensure(
    coverage?.documentEntry?.observed === true &&
      coverage?.documentEntry?.activated === false &&
      coverage?.documentEntry?.landingObserved === false &&
      coverage?.documentEntry?.targetPageRef === null,
    'Documents must remain an observed, unactivated entry with no materialized destination',
  );
});

group('Obsidian wikilinks', () => {
  const byBasename = new Map();
  for (const file of markdownFiles) {
    const key = basename(file).replace(/\.md$/i, '');
    const values = byBasename.get(key) ?? [];
    values.push(file);
    byBasename.set(key, values);
  }

  let linkCount = 0;
  for (const file of markdownFiles) {
    const text = frontmatterByFile.get(file)?.text ?? readFileSync(file, 'utf8');
    for (const match of text.matchAll(/!?\[\[([^\]]+)\]\]/g)) {
      linkCount += 1;
      const target = match[1].split('|', 1)[0].split('#', 1)[0].trim();
      if (!target) continue;
      let decoded = target;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        // Literal percent characters are valid in Obsidian filenames.
      }
      const targetWithExtension = extname(decoded) ? decoded : `${decoded}.md`;
      const candidates = [
        resolve(dirname(file), targetWithExtension),
        resolve(OBSIDIAN_ROOT, targetWithExtension.replace(/^[/\\]+/, '')),
      ];
      const key = basename(decoded).replace(/\.md$/i, '');
      const resolved =
        candidates.some((candidate) => existsSync(candidate)) ||
        (byBasename.get(key)?.length ?? 0) > 0;
      ensure(resolved, `${graphRelative(file)} has dangling wikilink [[${match[1]}]]`);
    }
  }
  ensure(linkCount > 0, 'Obsidian projection contains no wikilinks');
});

if (failures.length > 0) {
  console.error(`\nUIKG 2.0 validation failed with ${failures.length} issue(s):`);
  let previousGroup = null;
  for (const failure of failures) {
    if (failure.group !== previousGroup) {
      console.error(`\n  ${failure.group}`);
      previousGroup = failure.group;
    }
    console.error(`    - ${failure.message}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `\nUIKG 2.0 validation passed: ${groupResults.length} groups, ` +
      `${pages.length} Pages, ${pageInstances.length} PageInstances, ` +
      `${elements.length} Elements, ${elementInstances.length} ElementInstances, ` +
      `${transitions.length} Transitions, ${markdownFiles.length} Markdown notes.`,
  );
}
