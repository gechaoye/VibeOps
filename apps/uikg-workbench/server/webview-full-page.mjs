import net from 'node:net';
import sharp from 'sharp';

function textResult(value) {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return String(value ?? '');
}

function flatten(root, output = []) {
  if (!root) return output;
  output.push(root);
  for (const child of root.children || []) flatten(child, output);
  return output;
}

function largestWebViewBounds(hierarchy) {
  return flatten(hierarchy?.root)
    .filter((node) => /WebView/i.test(node.class || '') && node.bounds)
    .map((node) => node.bounds)
    .sort((left, right) => (right.right - right.left) * (right.bottom - right.top) - (left.right - left.left) * (left.bottom - left.top))[0] || null;
}

function devtoolsSockets(value) {
  return [...new Set(textResult(value).split('\n').flatMap((line) => {
    const match = line.match(/@(\S*(?:webview|chrome)_devtools_remote\S*)/i);
    return match ? [match[1]] : [];
  }))];
}

async function packageDebuggable(adb, packageName) {
  if (!packageName) return null;
  try {
    const output = textResult(await adb.shell(['dumpsys', 'package', packageName]));
    if (!output.trim()) return null;
    const pkgFlags = output.match(/\bpkgFlags=\[([^\]]*)\]/i)?.[1];
    if (pkgFlags && /\bDEBUGGABLE\b/i.test(pkgFlags)) return true;
    const flags = output.match(/\bflags=0x([0-9a-f]+)/i)?.[1];
    if (flags) return (Number.parseInt(flags, 16) & 0x2) !== 0;
    if (pkgFlags) return false;
    return null;
  } catch {
    return null;
  }
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

function targetDescription(target) {
  try { return JSON.parse(target.description || '{}'); } catch { return {}; }
}

function targetScore(target, bounds) {
  const description = targetDescription(target);
  if (target.type !== 'page' || !target.webSocketDebuggerUrl || description.visible !== true) return -1;
  const widthDelta = Math.abs(Number(description.width || 0) - (bounds.right - bounds.left));
  const topDelta = Math.abs(Number(description.screenY || 0) - bounds.top);
  return 10_000 - widthDelta - topDelta * 2;
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

async function connectCdp(webSocketDebuggerUrl) {
  const socket = new globalThis.WebSocket(webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  await withTimeout(new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('WebView DevTools 连接失败')), { once: true });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message || 'CDP 请求失败'));
      else request.resolve(message.result);
    });
  }), 5000, 'WebView DevTools 连接超时');
  return {
    call(method, params = {}) {
      return withTimeout(new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      }), 8000, `${method} 执行超时`);
    },
    close() { socket.close(); },
  };
}

const SCROLLER_EXPRESSION = `(() => {
  const candidates = [document.scrollingElement, ...document.querySelectorAll('*')].filter(Boolean);
  const element = candidates
    .filter((candidate) => candidate.scrollHeight > candidate.clientHeight + 2)
    .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight))[0];
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  window.__vibeopsFullPageScroller = element;
  return {
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    originalScrollTop: element.scrollTop,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    devicePixelRatio,
    url: location.href,
    title: document.title,
  };
})()`;

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.result?.subtype === 'error') throw new Error(result.result.description || '页面脚本执行失败');
  return result.result?.value ?? null;
}

function scrollPositions(scrollHeight, clientHeight) {
  const maximum = Math.max(0, scrollHeight - clientHeight);
  if (maximum === 0) return [0];
  const step = Math.max(1, clientHeight - Math.min(48, Math.floor(clientHeight / 8)));
  const positions = [];
  for (let position = 0; position < maximum; position += step) positions.push(position);
  positions.push(maximum);
  return [...new Set(positions)];
}

export async function stitchHybridFullPage({ nativeBuffer, chunks, webViewBounds, deviceViewport, scrollHeightCss, devicePixelRatio }) {
  const headerHeight = Math.max(0, Math.round(webViewBounds.top));
  const footerTop = Math.min(deviceViewport.height, Math.round(webViewBounds.bottom));
  const footerHeight = Math.max(0, deviceViewport.height - footerTop);
  const contentHeight = Math.round(scrollHeightCss * devicePixelRatio);
  const firstChunk = chunks[0];
  const scrollerTop = firstChunk ? Math.max(0, Math.round((firstChunk.rect?.y || 0) * devicePixelRatio)) : 0;
  const webViewHeight = Math.max(0, Math.round((webViewBounds.bottom - webViewBounds.top)));
  const scrollerHeight = firstChunk ? Math.max(0, Math.round(firstChunk.clientHeight * devicePixelRatio)) : 0;
  // CDP captures the whole target viewport. The scroll container can be shorter
  // because the page owns a fixed action bar below it; preserve that bar once
  // from the final chunk instead of replacing it with the native screen footer.
  const bottomChromeHeight = Math.max(0, webViewHeight - scrollerTop - scrollerHeight);
  const outputHeight = headerHeight + contentHeight + bottomChromeHeight + footerHeight;
  const composites = [];
  if (headerHeight > 0) {
    composites.push({ input: await sharp(nativeBuffer).extract({ left: 0, top: 0, width: deviceViewport.width, height: headerHeight }).png().toBuffer(), left: 0, top: 0 });
  }
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const nextTop = index + 1 < chunks.length ? chunks[index + 1].scrollTop : scrollHeightCss;
    const cssHeight = Math.min(chunk.clientHeight, nextTop - chunk.scrollTop);
    const pixelHeight = Math.max(1, Math.round(cssHeight * devicePixelRatio));
    const source = sharp(chunk.buffer);
    const metadata = await source.metadata();
    const left = Math.max(0, Math.round(chunk.rect.x * devicePixelRatio));
    const top = Math.max(0, Math.round(chunk.rect.y * devicePixelRatio));
    const width = Math.min(deviceViewport.width - webViewBounds.left, (metadata.width || deviceViewport.width) - left);
    const height = Math.min(pixelHeight, (metadata.height || pixelHeight) - top);
    if (width > 0 && height > 0) {
      const input = await source.extract({ left, top, width, height }).png().toBuffer();
      composites.push({ input, left: Math.round(webViewBounds.left), top: headerHeight + Math.round(chunk.scrollTop * devicePixelRatio) });
    }
    if (index === chunks.length - 1 && bottomChromeHeight > 0) {
      const chromeTop = Math.max(0, top + scrollerHeight);
      const chromeHeight = Math.min(bottomChromeHeight, (metadata.height || 0) - chromeTop);
      if (width > 0 && chromeHeight > 0) {
        const input = await sharp(chunk.buffer).extract({ left, top: chromeTop, width, height: chromeHeight }).png().toBuffer();
        composites.push({ input, left: Math.round(webViewBounds.left), top: headerHeight + contentHeight });
      }
    }
  }
  if (footerHeight > 0) {
    composites.push({
      input: await sharp(nativeBuffer).extract({ left: 0, top: footerTop, width: deviceViewport.width, height: footerHeight }).png().toBuffer(),
      left: 0,
      top: headerHeight + contentHeight + bottomChromeHeight,
    });
  }
  return sharp({ create: { width: deviceViewport.width, height: outputHeight, channels: 4, background: '#ffffff' } })
    .composite(composites)
    .png()
    .toBuffer();
}

export async function captureWebViewFullPage(agent, hierarchy, nativeImage, options = {}) {
  const device = agent?.interface;
  const webViewBounds = largestWebViewBounds(hierarchy);
  const deviceViewport = hierarchy?.viewport;
  if (!device || typeof device.getAdb !== 'function' || !webViewBounds || !deviceViewport?.width || !deviceViewport?.height) {
    return { status: 'unavailable', reason: '当前页面没有可用的 WebView 或设备视口信息' };
  }
  const adb = await device.getAdb();
  const debuggable = await packageDebuggable(adb, hierarchy?.packageName);
  if (debuggable === false) {
    return { status: 'unavailable', reason: '当前应用不是 debug 包，WebView 未开启调试；请安装 debug 包后再导出整页' };
  }
  const sockets = devtoolsSockets(await adb.shell(['cat', '/proc/net/unix']));
  if (sockets.length === 0) return { status: 'unavailable', reason: 'WebView 未开启调试，已保留当前整屏截图' };
  const candidates = [];
  for (const socketName of sockets.slice(0, 8)) {
    const port = await availablePort();
    if (!port) continue;
    try {
      await adb.forwardAbstractPort(port, socketName);
      const targets = await withTimeout(fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()), 3000, 'WebView target 枚举超时');
      for (const target of targets) candidates.push({ socketName, port, target, score: targetScore(target, webViewBounds) });
      const selected = candidates.filter((item) => item.port === port).sort((left, right) => right.score - left.score)[0];
      if (!selected || selected.score < 0) continue;
      const localUrl = String(selected.target.webSocketDebuggerUrl).replace(/^ws:\/\/[^/]+/, `ws://127.0.0.1:${port}`);
      const cdp = await connectCdp(localUrl);
      let scroller;
      try {
        await cdp.call('Page.enable');
        await cdp.call('Runtime.enable');
        scroller = await evaluate(cdp, SCROLLER_EXPRESSION);
        if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 2) {
          return { status: 'not-scrollable', reason: 'WebView 当前内容未超过一屏' };
        }
        const positions = scrollPositions(scroller.scrollHeight, scroller.clientHeight);
        const chunks = [];
        const structureSnapshots = [];
        for (const requested of positions) {
          const scrollTop = await evaluate(cdp, `(() => { const element = window.__vibeopsFullPageScroller; element.scrollTop = ${requested}; return element.scrollTop; })()`);
          await new Promise((resolve) => setTimeout(resolve, 180));
          const shot = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true });
          chunks.push({ buffer: Buffer.from(shot.data, 'base64'), scrollTop, clientHeight: scroller.clientHeight, rect: scroller.rect });
          if (typeof options.captureChunk === 'function') {
            try {
              const snapshot = await options.captureChunk({
                cdp,
                scrollTop,
                scroller,
                webViewBounds,
                deviceViewport,
              });
              if (snapshot) structureSnapshots.push({ scrollTop, ...snapshot });
            } catch (error) {
              structureSnapshots.push({ scrollTop, error: String(error?.message || error) });
            }
          }
        }
        const buffer = await stitchHybridFullPage({
          nativeBuffer: nativeImage.buffer,
          chunks,
          webViewBounds,
          deviceViewport,
          scrollHeightCss: scroller.scrollHeight,
          devicePixelRatio: scroller.devicePixelRatio,
        });
        const metadata = await sharp(buffer).metadata();
        return {
          status: 'complete',
          image: { buffer, mimeType: 'image/png', extension: 'png', width: metadata.width, height: metadata.height },
          capture: {
            kind: 'hybrid-full-page',
            method: 'native-header-footer-plus-cdp-scroll-stitch',
            deviceViewport,
            webViewBounds,
            page: { url: scroller.url, title: scroller.title },
            scrollContainer: { scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, clientWidth: scroller.clientWidth },
            devicePixelRatio: scroller.devicePixelRatio,
            chunkCount: chunks.length,
          },
          structureSnapshots,
        };
      } finally {
        if (scroller) {
          await evaluate(cdp, `(() => { const element = window.__vibeopsFullPageScroller; if (element) element.scrollTop = ${scroller.originalScrollTop}; delete window.__vibeopsFullPageScroller; return true; })()`).catch(() => {});
        }
        cdp.close();
      }
    } catch (error) {
      candidates.push({ error: String(error?.message || error), score: -1 });
    } finally {
      try { await adb.removePortForward(port); } catch {}
    }
  }
  const reason = candidates.find((item) => item.error)?.error || '没有找到当前可见 WebView 的调试页面';
  return { status: 'unavailable', reason };
}
