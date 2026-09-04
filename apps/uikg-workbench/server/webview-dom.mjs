import net from 'node:net';

function textResult(value) {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return String(value ?? '');
}

function webViewBounds(root, output = []) {
  if (!root) return output;
  if (/WebView/i.test(root.class || '') && root.bounds) output.push(root.bounds);
  for (const child of root.children || []) webViewBounds(child, output);
  return output;
}

function devtoolsSockets(value) {
  const sockets = [];
  for (const line of textResult(value).split('\n')) {
    const match = line.match(/@(\S*(?:webview|chrome)_devtools_remote\S*)/i);
    if (match) sockets.push(match[1]);
  }
  return [...new Set(sockets)];
}

function targetDescription(target) {
  try { return JSON.parse(target.description || '{}'); } catch { return {}; }
}

function targetScore(target, bounds) {
  const description = targetDescription(target);
  if (target.type !== 'page' || !target.webSocketDebuggerUrl) return -1;
  const width = bounds.right - bounds.left;
  const widthDelta = Math.abs(Number(description.width || 0) - width);
  const topDelta = Math.abs(Number(description.screenY || 0) - bounds.top);
  const visibleBonus = description.visible === true ? 10_000 : 0;
  return visibleBonus + 1_000 - widthDelta - topDelta * 2;
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

async function cdpEvaluate(webSocketDebuggerUrl, expression) {
  if (typeof globalThis.WebSocket !== 'function') throw new Error('当前 Node.js 不支持 WebSocket');
  return withTimeout(new Promise((resolve, reject) => {
    const socket = new globalThis.WebSocket(webSocketDebuggerUrl);
    const id = 1;
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    });
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.id !== id) return;
        socket.close();
        if (message.error) reject(new Error(message.error.message || 'DOM evaluate failed'));
        else resolve(message.result?.result?.value || null);
      } catch (error) {
        socket.close();
        reject(error);
      }
    });
    socket.addEventListener('error', () => reject(new Error('WebView DevTools 连接失败')));
  }), 4000, 'WebView DOM 采集超时');
}

const DOM_SNAPSHOT_EXPRESSION = `(() => {
  const viewport = window.visualViewport;
  const visible = (rect, style) => rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0;
  const ownText = (element) => Array.from(element.childNodes || []).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent || '').join(' ').trim();
  const interactive = (element, style) => /^(A|BUTTON|INPUT|TEXTAREA|SELECT|OPTION)$/.test(element.tagName)
    || element.hasAttribute('role')
    || element.hasAttribute('onclick')
    || element.hasAttribute('contenteditable')
    || element.isContentEditable
    || element.tabIndex >= 0
    || style?.cursor === 'pointer';
  const nodes = [];
  for (const element of document.querySelectorAll('body *')) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (!visible(rect, style)) continue;
    // contenteditable descendants (for example the browser-inserted <p>
    // inside a rich editor) are not separate controls. Keep the nearest
    // contenteditable root so one visual input maps to one runtime rectangle.
    const editableRoot = element.isContentEditable
      ? element.closest('[contenteditable]:not([contenteditable="false"])')
      : null;
    if (element.isContentEditable && editableRoot && editableRoot !== element) continue;
    const directText = ownText(element);
    const isInteractive = interactive(element, style);
    const text = directText || element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('alt') || element.getAttribute('title') || (isInteractive ? String(element.value || '').trim() : '');
    if (!text && !isInteractive) continue;
    if (!directText && !isInteractive && element.children.length > 0) continue;
    nodes.push({
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') || '',
      type: element.getAttribute('type') || '',
      id: element.id || '',
      editable: Boolean(element.isContentEditable || element.hasAttribute('contenteditable')),
      text: String(text || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
      interactive: isInteractive,
      disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
      // Keep CSS positioning as a first-class runtime fact. Fixed/sticky
      // controls must stay in the device viewport while page content moves.
      position: style.position || 'static',
      fixed: style.position === 'fixed' || style.position === 'sticky',
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
    // Keep the complete visible/interactive DOM snapshot. Payload trimming is
    // handled at the prompt boundary, after the full-page segments are merged.
  }
  return {
    url: location.href,
    title: document.title,
    viewport: {
      width: viewport ? viewport.width : innerWidth,
      height: viewport ? viewport.height : innerHeight,
      offsetLeft: viewport ? viewport.offsetLeft : 0,
      offsetTop: viewport ? viewport.offsetTop : 0,
      scale: viewport ? viewport.scale : 1,
      devicePixelRatio,
    },
    nodes,
  };
})()`;

export function mapDomSnapshot(snapshot, bounds, displayViewport) {
  if (!snapshot?.viewport?.width || !snapshot?.viewport?.height || !bounds) return null;
  // getBoundingClientRect() is expressed in CSS pixels. The WebView display
  // height is not a reliable CSS scale source: it can exclude browser chrome
  // or represent only the visible portion of a larger CSS viewport. Use the
  // page-reported DPR/visual scale for both axes and keep the measured bounds
  // only as the origin and horizontal extent.
  const dpr = Number(snapshot.viewport.devicePixelRatio);
  const visualScale = Number(snapshot.viewport.scale);
  const measuredScaleX = (bounds.right - bounds.left) / snapshot.viewport.width;
  const cssToDisplayScale = dpr > 0
    ? dpr * (visualScale > 0 ? visualScale : 1)
    : (measuredScaleX > 0 ? measuredScaleX : 1);
  const scaleX = measuredScaleX > 0 ? measuredScaleX : cssToDisplayScale;
  const scaleY = cssToDisplayScale;
  return {
    ...snapshot,
    coordinateSpace: 'display_px',
    displayViewport,
    webViewBounds: bounds,
    nodes: (snapshot.nodes || []).map((node) => ({
      ...node,
      bounds: {
        left: bounds.left + (node.rect.x - (snapshot.viewport.offsetLeft || 0)) * scaleX,
        top: bounds.top + (node.rect.y - (snapshot.viewport.offsetTop || 0)) * scaleY,
        right: bounds.left + (node.rect.x + node.rect.width - (snapshot.viewport.offsetLeft || 0)) * scaleX,
        bottom: bounds.top + (node.rect.y + node.rect.height - (snapshot.viewport.offsetTop || 0)) * scaleY,
      },
    })),
  };
}

export async function captureDomSnapshotFromCdp(cdp, bounds, displayViewport) {
  if (!cdp || typeof cdp.call !== 'function') return null;
  const result = await cdp.call('Runtime.evaluate', {
    expression: DOM_SNAPSHOT_EXPRESSION,
    returnByValue: true,
    awaitPromise: true,
  });
  const snapshot = result.result?.value ?? null;
  return mapDomSnapshot(snapshot, bounds, displayViewport);
}

function domNodeKey(node) {
  const bounds = node?.bounds || {};
  const identity = node?.id || node?.text || '';
  return `${node?.tag || ''}|${node?.role || ''}|${identity}|${Math.round(Number(bounds.left) || 0)}|${Math.round(Number(bounds.top) || 0)}|${Math.round(Number(bounds.right) || 0)}|${Math.round(Number(bounds.bottom) || 0)}`;
}

function domNodeIdentity(node) {
  return `${node?.tag || ''}|${node?.role || ''}|${node?.id || ''}|${node?.text || ''}`;
}

function overlapRatio(left, right) {
  if (!left || !right) return 0;
  const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  const intersection = width * height;
  const leftArea = Math.max(0, left.right - left.left) * Math.max(0, left.bottom - left.top);
  const rightArea = Math.max(0, right.right - right.left) * Math.max(0, right.bottom - right.top);
  return intersection / Math.max(1, Math.min(leftArea, rightArea));
}

function sameDomNode(left, right) {
  const identity = domNodeIdentity(left);
  const stableIdentity = left?.id || left?.text || left?.role || right?.id || right?.text || right?.role;
  return Boolean(stableIdentity)
    && identity === domNodeIdentity(right)
    && overlapRatio(left?.bounds, right?.bounds) >= 0.65;
}

function snapshotDisplayScale(document, fallback = 1) {
  const viewport = document?.viewport || {};
  const dpr = Number(viewport.devicePixelRatio);
  const visualScale = Number(viewport.scale);
  if (dpr > 0) return dpr * (visualScale > 0 ? visualScale : 1);
  const width = Number(viewport.width);
  const displayWidth = Number(document?.webViewBounds?.right) - Number(document?.webViewBounds?.left);
  if (width > 0 && displayWidth > 0) return displayWidth / width;
  return Number(fallback) > 0 ? Number(fallback) : 1;
}

export function mergeDomSnapshots(baseDom, snapshots, { webViewBounds, viewport, devicePixelRatio = 1 } = {}) {
  if (!viewport?.width || !viewport?.height) return baseDom;
  const firstSnapshot = (snapshots || []).find((snapshot) => snapshot?.dom?.nodes);
  const seed = baseDom || (firstSnapshot ? {
    status: 'complete',
    documents: [{ ...structuredClone(firstSnapshot.dom), nodes: [] }],
  } : null);
  if (!seed) return baseDom;
  const documents = (seed.documents || []).map((document) => ({
    ...structuredClone(document),
    coordinateSpace: 'display_px',
    displayViewport: { width: viewport.width, height: viewport.height },
  }));
  const selected = documents[0];
  if (!selected) return baseDom;
  const seen = new Set((selected.nodes || []).map(domNodeKey));
  const seenNodes = [...(selected.nodes || [])];
  selected.nodes ||= [];
  const fixedNodes = new Map((selected.nodes || [])
    .filter((node) => node.fixed)
    .map((node) => [domNodeIdentity(node), { ...node, fixed: true }]));
  const webViewTop = Number(webViewBounds?.top || 0);
  const webViewBottom = Number(webViewBounds?.bottom || viewport.height);
  for (const snapshot of snapshots || []) {
    const document = snapshot?.dom;
    if (!document?.nodes) continue;
    const scaleY = snapshotDisplayScale(document, devicePixelRatio);
    const offset = Number(snapshot.scrollTop || 0) * scaleY;
    for (const node of document.nodes) {
      const bounds = node.bounds;
      if (!bounds || bounds.bottom <= webViewTop || bounds.top >= webViewBottom) continue;
      const shifted = {
        ...node,
        bounds: node.fixed
          ? { ...bounds }
          : { ...bounds, top: bounds.top + offset, bottom: bounds.bottom + offset },
      };
      if (node.fixed) fixedNodes.set(domNodeIdentity(node), { ...shifted, fixed: true });
      if (seenNodes.some((existing) => sameDomNode(existing, shifted))) continue;
      const key = domNodeKey(shifted);
      if (seen.has(key)) continue;
      seen.add(key);
      seenNodes.push(shifted);
      selected.nodes.push(shifted);
    }
  }
  selected.nodeCount = selected.nodes.length;
  selected.fullPage = true;
  return {
    ...seed,
    documents,
    fullPage: true,
    selectedDocumentIndex: 0,
    fixedNodes: [...fixedNodes.values()],
  };
}

export async function captureWebViewDom(agent, hierarchy) {
  const device = agent?.interface;
  const root = hierarchy?.root;
  const viewBounds = webViewBounds(root).sort((left, right) => (right.right - right.left) * (right.bottom - right.top) - (left.right - left.left) * (left.bottom - left.top));
  if (!device || typeof device.getAdb !== 'function' || viewBounds.length === 0) return { status: 'unavailable', documents: [] };
  const adb = await device.getAdb();
  let sockets;
  try {
    sockets = devtoolsSockets(await adb.shell(['cat', '/proc/net/unix']));
  } catch {
    return { status: 'unavailable', documents: [] };
  }
  if (sockets.length === 0) return { status: 'debugging-disabled', documents: [] };
  const documents = [];
  const errors = [];
  for (const socketName of sockets.slice(0, 6)) {
    const port = await availablePort();
    if (!port) continue;
    try {
      await adb.forwardAbstractPort(port, socketName);
      const targets = await withTimeout(fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()), 2500, 'WebView target 枚举超时');
      const bounds = viewBounds[0];
      const target = targets
        .filter((item) => item.type === 'page' && item.webSocketDebuggerUrl)
        .sort((left, right) => targetScore(right, bounds) - targetScore(left, bounds))[0];
      if (!target) continue;
      const localUrl = String(target.webSocketDebuggerUrl).replace(/^ws:\/\/[^/]+/, `ws://127.0.0.1:${port}`);
      const snapshot = await cdpEvaluate(localUrl, DOM_SNAPSHOT_EXPRESSION);
      const mapped = mapDomSnapshot(snapshot, bounds, hierarchy.viewport);
      if (mapped) documents.push({ ...mapped, _targetScore: targetScore(target, bounds) });
    } catch (error) {
      errors.push(String(error?.message || error));
    } finally {
      try { await adb.removePortForward(port); } catch {}
    }
  }
  documents.sort((left, right) => (right._targetScore || 0) - (left._targetScore || 0));
  const selected = documents[0] ? [{ ...documents[0], _targetScore: undefined }] : [];
  if (selected[0]) delete selected[0]._targetScore;
  return {
    status: selected.length > 0 ? 'complete' : 'unavailable',
    documents: selected,
    ...(errors.length > 0 ? { errors } : {}),
  };
}
