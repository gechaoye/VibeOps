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
  const interactive = (element) => /^(A|BUTTON|INPUT|TEXTAREA|SELECT|OPTION)$/.test(element.tagName) || element.hasAttribute('role') || element.hasAttribute('onclick') || element.tabIndex >= 0;
  const nodes = [];
  for (const element of document.querySelectorAll('body *')) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (!visible(rect, style)) continue;
    const directText = ownText(element);
    const text = directText || element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('alt') || element.getAttribute('title') || (interactive(element) ? String(element.value || '').trim() : '');
    if (!text && !interactive(element)) continue;
    if (!directText && !interactive(element) && element.children.length > 0) continue;
    nodes.push({
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') || '',
      type: element.getAttribute('type') || '',
      id: element.id || '',
      text: String(text || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
      interactive: interactive(element),
      disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
    if (nodes.length >= 1200) break;
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

function mapDomSnapshot(snapshot, bounds, displayViewport) {
  if (!snapshot?.viewport?.width || !snapshot?.viewport?.height || !bounds) return null;
  const scaleX = (bounds.right - bounds.left) / snapshot.viewport.width;
  const scaleY = (bounds.bottom - bounds.top) / snapshot.viewport.height;
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
      for (const target of targets.filter((item) => item.type === 'page' && item.webSocketDebuggerUrl).slice(0, viewBounds.length)) {
        const localUrl = String(target.webSocketDebuggerUrl).replace(/^ws:\/\/[^/]+/, `ws://127.0.0.1:${port}`);
        const snapshot = await cdpEvaluate(localUrl, DOM_SNAPSHOT_EXPRESSION);
        const mapped = mapDomSnapshot(snapshot, viewBounds[documents.length] || viewBounds[0], hierarchy.viewport);
        if (mapped) documents.push(mapped);
      }
    } catch (error) {
      errors.push(String(error?.message || error));
    } finally {
      try { await adb.removePortForward(port); } catch {}
    }
  }
  return {
    status: documents.length > 0 ? 'complete' : 'unavailable',
    documents,
    ...(errors.length > 0 ? { errors } : {}),
  };
}
