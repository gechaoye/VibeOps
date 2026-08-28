const XML_ENTITY = /&(?:amp|lt|gt|quot|apos|#x[0-9a-f]+|#\d+);/gi;

function decodeXml(value) {
  return String(value || '').replace(XML_ENTITY, (entity) => {
    const body = entity.slice(1, -1);
    if (body === 'amp') return '&';
    if (body === 'lt') return '<';
    if (body === 'gt') return '>';
    if (body === 'quot') return '"';
    if (body === 'apos') return "'";
    const code = body.startsWith('#x') ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
  });
}

function attributes(source) {
  const result = {};
  const pattern = /([A-Za-z_:][\w:.-]*)\s*=\s*"([\s\S]*?)"/g;
  let match;
  while ((match = pattern.exec(source))) result[match[1]] = decodeXml(match[2]);
  return result;
}

function parseBounds(value) {
  const match = String(value || '').match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/);
  if (!match) return null;
  const [, left, top, right, bottom] = match.map(Number);
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

function parseUiAutomatorXml(xml) {
  const root = { children: [] };
  const stack = [root];
  const tokenPattern = /<!--[\s\S]*?-->|<\?[^>]*\?>|<([\w:.-]+)([^>]*?)(\/?)>|<\/([\w:.-]+)>/g;
  let match;
  while ((match = tokenPattern.exec(String(xml || '')))) {
    if (match[1]) {
      const attrs = attributes(match[2]);
      const node = { ...attrs, children: [] };
      stack.at(-1).children.push(node);
      if (!match[3]) stack.push(node);
    } else if (match[4] && stack.length > 1) {
      stack.pop();
    }
  }
  return root.children[0] || null;
}

function normalizeNode(raw, depth, viewport, packageName) {
  const bounds = parseBounds(raw.bounds);
  const nodePackage = raw.package || packageName || '';
  const children = (raw.children || [])
    .map((child) => normalizeNode(child, depth + 1, viewport, packageName))
    .filter(Boolean);
  if (!bounds) return children.length ? { class: raw.class || '', package: nodePackage, children } : null;
  const intersects = bounds.right > 0 && bounds.bottom > 0 && bounds.left < viewport.width && bounds.top < viewport.height;
  if (!intersects || nodePackage === 'com.android.systemui') return children.length ? { class: raw.class || '', package: nodePackage, children } : null;
  return {
    class: raw.class || '',
    package: nodePackage,
    resourceId: raw['resource-id'] || '',
    text: raw.text || '',
    contentDescription: raw['content-desc'] || '',
    clickable: raw.clickable === 'true',
    enabled: raw.enabled !== 'false',
    checkable: raw.checkable === 'true',
    checked: raw.checked === 'true',
    scrollable: raw.scrollable === 'true',
    focusable: raw.focusable === 'true',
    bounds,
    children,
    depth,
  };
}

function flatten(node, output = []) {
  if (!node) return output;
  output.push(node);
  for (const child of node.children || []) flatten(child, output);
  return output;
}

function implementationType(root, packageName = '') {
  const values = flatten(root).map((node) => `${node.class} ${node.package}`).join(' ');
  if (/ReactRootView|ReactViewGroup|com\.facebook\.react/i.test(values)) return 'rn';
  if (/WebView|BHWebActivity|WebViewActivity|h5cache/i.test(values) || /WebView|BHWebActivity|h5cache/i.test(packageName)) return 'h5';
  if (root) return 'native';
  return 'unknown';
}

async function focusedActivity(adb) {
  try {
    const output = textResult(await adb.shell(['dumpsys', 'window']));
    const match = output.match(/mCurrentFocus=.*?\s([\w.]+)\/([\w.$]+)/);
    return match ? { packageName: match[1], activity: match[2] } : null;
  } catch {
    return null;
  }
}

function implementationFromActivity(type, activity) {
  if (/ZRNActivity|React/i.test(activity || '')) return 'rn';
  if (/BHWebActivity|WebView|H5/i.test(activity || '')) return 'h5';
  return type;
}

function textResult(value) {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return String(value ?? '');
}

function displaySizeFromDumpsys(value) {
  const text = textResult(value);
  const overrideLine = text.match(/mOverrideDisplayInfo=([^\n]+)/)?.[1] || '';
  const baseLine = text.match(/mBaseDisplayInfo=([^\n]+)/)?.[1] || '';
  const override = overrideLine.match(/\breal\s+(\d+)\s*x\s*(\d+)/);
  const base = baseLine.match(/\breal\s+(\d+)\s*x\s*(\d+)/);
  const device = text.match(/DisplayDeviceInfo\{[^\n]*?,\s*(\d+)\s*x\s*(\d+),\s*modeId\s+(\d+)/);
  const match = override || base || device;
  if (!match) return null;
  return {
    width: Number(match[1]),
    height: Number(match[2]),
    modeId: Number((override ? overrideLine : baseLine).match(/\bmode\s+(\d+)/)?.[1] || device?.[3]) || null,
  };
}

function densityFromWm(value) {
  const text = textResult(value);
  const override = text.match(/Override density:\s*(\d+)/i);
  const physical = text.match(/Physical density:\s*(\d+)/i);
  return Number(override?.[1] || physical?.[1]) || null;
}

function rotationFromDumpsys(value) {
  const match = textResult(value).match(/SurfaceOrientation:\s*(\d+)/i);
  return Number(match?.[1]) || 0;
}

export async function captureDisplayMetrics(agent) {
  const device = agent?.interface;
  if (!device || typeof device.getAdb !== 'function') return null;
  try {
    const adb = await device.getAdb();
    const [display, density, input] = await Promise.all([
      adb.shell(['dumpsys', 'display']),
      adb.shell(['wm', 'density']),
      adb.shell(['dumpsys', 'input']),
    ]);
    const size = displaySizeFromDumpsys(display);
    if (!size?.width || !size?.height) return null;
    return {
      coordinateSpace: 'display_px',
      width: size.width,
      height: size.height,
      modeId: size.modeId,
      density: densityFromWm(density),
      rotation: rotationFromDumpsys(input),
      capturedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function sameDisplay(left, right) {
  if (!left || !right) return null;
  return left.width === right.width
    && left.height === right.height
    && left.rotation === right.rotation
    && (!left.modeId || !right.modeId || left.modeId === right.modeId);
}

function screenshotTransform(display, screenshot) {
  if (!display?.width || !display?.height || !screenshot?.width || !screenshot?.height) return null;
  return {
    from: 'display_px',
    to: 'screenshot_px',
    scaleX: screenshot.width / display.width,
    scaleY: screenshot.height / display.height,
    offsetX: 0,
    offsetY: 0,
  };
}

export async function captureRuntimeHierarchy(agent, screenshotViewport, displayBefore = null) {
  const device = agent?.interface;
  if (!device || typeof device.getAdb !== 'function') return null;
  try {
    const adb = await device.getAdb();
    const focused = await focusedActivity(adb);
    await adb.shell(['uiautomator', 'dump', '/sdcard/vibeops-window.xml']);
    const xml = textResult(await adb.shell(['cat', '/sdcard/vibeops-window.xml']));
    const rawRoot = parseUiAutomatorXml(xml);
    const flatRaw = flatten(rawRoot);
    const packageName = flatRaw.find((node) => node.package)?.package || '';
    const displayAfter = await captureDisplayMetrics(agent);
    const viewport = displayAfter?.width && displayAfter?.height
      ? { width: displayAfter.width, height: displayAfter.height }
      : screenshotViewport;
    const root = normalizeNode(rawRoot, 0, viewport, packageName);
    const nodes = flatten(root).filter((node) => node.bounds);
    const displayStable = sameDisplay(displayBefore, displayAfter);
    const screenshotAspect = screenshotViewport?.width / screenshotViewport?.height;
    const displayAspect = viewport?.width / viewport?.height;
    const aspectStable = Number.isFinite(screenshotAspect) && Number.isFinite(displayAspect)
      ? Math.abs(screenshotAspect - displayAspect) <= 0.002
      : null;
    return {
      source: 'uiautomator',
      hierarchySource: 'uiautomator',
      implementationType: implementationFromActivity(implementationType(root, packageName), focused?.activity),
      packageName: focused?.packageName || packageName,
      activity: focused?.activity || '',
      coordinateSpace: 'display_px',
      origin: 'full_display',
      viewport: { width: viewport.width, height: viewport.height },
      screenshotViewport: { width: screenshotViewport.width, height: screenshotViewport.height },
      displayBefore,
      displayAfter,
      captureConsistency: {
        stable: displayStable !== false && aspectStable !== false,
        displayStable,
        aspectStable,
      },
      transforms: [screenshotTransform(viewport, screenshotViewport)].filter(Boolean),
      nodeCount: nodes.length,
      root,
    };
  } catch (error) {
    return { source: 'uiautomator', hierarchySource: 'none', implementationType: 'unknown', error: String(error?.message || error) };
  }
}

function hierarchyRoot(runtimeStructure) {
  return runtimeStructure?.hierarchy?.root || runtimeStructure?.root || null;
}

function normalizedBounds(bounds, viewport) {
  if (!bounds || !viewport?.width || !viewport?.height) return null;
  const x = Math.max(0, bounds.left) / viewport.width;
  const y = Math.max(0, bounds.top) / viewport.height;
  const right = Math.min(viewport.width, bounds.right) / viewport.width;
  const bottom = Math.min(viewport.height, bounds.bottom) / viewport.height;
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

function semanticTexts(element) {
  return [...new Set([
    ...(element.meaning?.evidence?.visibleTexts || []),
    element.label,
  ].map((value) => String(value || '').trim()).filter((value) => value.length >= 2))];
}

function resourceIds(element) {
  const values = element?.meaning?.evidence?.visualCues || [];
  const ids = [];
  for (const value of values) {
    const match = String(value || '').match(/resource-id\s*=\s*([^\s,，;；]+)/iu);
    if (match) ids.push(match[1]);
  }
  return [...new Set(ids)];
}

function canGroundByText(element) {
  // A container's evidence often contains text from one of its descendants.
  // Matching that text would collapse the container onto the child node.
  return ![
    'navigation-bar',
    'sidebar',
    'drawer',
    'list',
    'grouped-list',
    'swipe-list',
    'expandable-list',
    'card',
    'panel',
    'section',
    'form',
    'table',
    'status-bar',
  ].includes(element.elementType);
}

function typePattern(elementType) {
  if (elementType === 'checkbox') return /CheckBox/i;
  if (elementType === 'switch') return /Switch/i;
  if (elementType === 'radio') return /RadioButton/i;
  if (['input', 'text-area', 'rich-text-input'].includes(elementType)) return /EditText/i;
  if (['text-button', 'icon-button'].includes(elementType)) return /Button|ImageButton/i;
  return null;
}

function groupKey(candidateKey) {
  const match = String(candidateKey || '').match(/^(.+?)[._-](\d+)[._-][^.]+/);
  return match ? `${match[1]}:${match[2]}` : null;
}

export function groundRecognitionGeometry(recognitionResult, runtimeStructure) {
  const root = hierarchyRoot(runtimeStructure);
  const hierarchy = runtimeStructure?.hierarchy || runtimeStructure;
  const viewport = hierarchy?.viewport;
  if (!root || hierarchy?.coordinateSpace !== 'display_px' || !viewport?.width || !viewport?.height) return recognitionResult;
  const result = structuredClone(recognitionResult);
  const nodes = flatten(root).filter((node) => node.bounds);
  const used = new Set();
  const anchoredGroups = new Map();

  const applyNode = (element, node) => {
    const box = normalizedBounds(node.bounds, viewport);
    if (!box) return false;
    element.approximateRegion = box;
    element.geometryKind = 'boundary';
    element.geometryConfidence = Math.max(Number(element.geometryConfidence) || 0, 0.98);
    element.riskSignals = [...new Set([...(element.riskSignals || []), 'geometry-grounded-by-runtime'])];
    used.add(node);
    const key = groupKey(element.candidateKey);
    if (key) anchoredGroups.set(key, box.y + box.height / 2);
    return true;
  };

  for (const element of result.elements || []) {
    const ids = resourceIds(element);
    if (!ids.length) continue;
    const matches = nodes.filter((node) => !used.has(node) && ids.includes(node.resourceId));
    if (matches.length === 1) applyNode(element, matches[0]);
  }

  for (const element of result.elements || []) {
    if ((element.riskSignals || []).includes('geometry-grounded-by-runtime') || !canGroundByText(element)) continue;
    const terms = semanticTexts(element);
    if (!terms.length) continue;
    const matches = nodes.filter((node) => !used.has(node) && terms.some((term) => node.text === term || node.contentDescription === term));
    if (matches.length === 1) applyNode(element, matches[0]);
  }

  for (const element of result.elements || []) {
    if ((element.riskSignals || []).includes('geometry-grounded-by-runtime')) continue;
    const pattern = typePattern(element.elementType);
    if (!pattern) continue;
    const expectedY = anchoredGroups.get(groupKey(element.candidateKey))
      ?? (element.approximateRegion.y + element.approximateRegion.height / 2);
    const matches = nodes.filter((node) => !used.has(node) && pattern.test(node.class || ''));
    matches.sort((left, right) => {
      const leftY = (left.bounds.top + left.bounds.bottom) / 2 / viewport.height;
      const rightY = (right.bounds.top + right.bounds.bottom) / 2 / viewport.height;
      return Math.abs(leftY - expectedY) - Math.abs(rightY - expectedY);
    });
    if (matches[0]) applyNode(element, matches[0]);
  }
  return result;
}
