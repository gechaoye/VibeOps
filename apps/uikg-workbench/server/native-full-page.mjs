import sharp from 'sharp';

function flatten(root, output = []) {
  if (!root) return output;
  output.push(root);
  for (const child of root.children || []) flatten(child, output);
  return output;
}

function area(bounds) {
  return Math.max(0, Number(bounds?.right) - Number(bounds?.left))
    * Math.max(0, Number(bounds?.bottom) - Number(bounds?.top));
}

function largestScrollableNode(hierarchy) {
  return flatten(hierarchy?.root)
    .filter((node) => node?.scrollable && node?.bounds)
    .sort((left, right) => area(right.bounds) - area(left.bounds))[0] || null;
}

function imageFromBuffer(buffer) {
  return sharp(buffer).metadata().then((metadata) => ({
    buffer,
    width: metadata.width,
    height: metadata.height,
  }));
}

function scaledRect(bounds, source, viewport) {
  const scaleX = source.width / viewport.width;
  const scaleY = source.height / viewport.height;
  const left = Math.max(0, Math.floor(bounds.left * scaleX));
  const top = Math.max(0, Math.floor(bounds.top * scaleY));
  const right = Math.min(source.width, Math.ceil(bounds.right * scaleX));
  const bottom = Math.min(source.height, Math.ceil(bounds.bottom * scaleY));
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

async function crop(buffer, rect) {
  return sharp(buffer).extract(rect).png().toBuffer();
}

async function rawCrop(buffer, rect) {
  return sharp(buffer).extract(rect).raw().toBuffer({ resolveWithObject: true });
}

function averageDifference(left, right, width, height, channels = 4) {
  const xStep = Math.max(8, Math.floor(width / 64));
  const yStep = Math.max(2, Math.floor(height / 160));
  let total = 0;
  let count = 0;
  for (let y = 0; y < height; y += yStep) {
    for (let x = 0; x < width; x += xStep) {
      const index = (y * width + x) * channels;
      total += Math.abs(left[index] - right[index]);
      total += Math.abs(left[index + 1] - right[index + 1]);
      total += Math.abs(left[index + 2] - right[index + 2]);
      count += 3;
    }
  }
  return count ? total / count : 255;
}

function hierarchyNodes(snapshot) {
  return flatten(snapshot?.hierarchy?.root).filter((node) => node?.bounds);
}

function nodeIdentity(node) {
  return [node?.resourceId, node?.contentDescription, node?.text, node?.class]
    .map((value) => String(value || '').trim())
    .join('|');
}

function estimateScrollDelta(previous, current, scrollBounds) {
  if (!previous || !current) return 0;
  const previousNodes = hierarchyNodes(previous);
  const currentByIdentity = new Map();
  for (const node of hierarchyNodes(current)) {
    const identity = nodeIdentity(node);
    if (identity.replaceAll('|', '') && !currentByIdentity.has(identity)) currentByIdentity.set(identity, node);
  }
  const deltas = [];
  for (const node of previousNodes) {
    const identity = nodeIdentity(node);
    const next = currentByIdentity.get(identity);
    if (!next || !node.bounds || !next.bounds) continue;
    const inside = node.bounds.top >= scrollBounds.top - 4 && node.bounds.bottom <= scrollBounds.bottom + 4;
    if (!inside) continue;
    const delta = Number(next.bounds.top) - Number(node.bounds.top);
    if (Math.abs(delta) >= 8 && Math.abs(delta) <= (scrollBounds.bottom - scrollBounds.top) * 1.2) deltas.push(delta);
  }
  if (deltas.length < 2) return 0;
  deltas.sort((left, right) => left - right);
  return deltas[Math.floor(deltas.length / 2)];
}

function safeAppendTop(snapshot, expectedTop, scaled, scrollBounds, viewport) {
  const candidates = hierarchyNodes(snapshot)
    .filter((node) => node.text || node.contentDescription || node.resourceId)
    .map((node) => {
      const height = Number(node.bounds.bottom) - Number(node.bounds.top);
      const top = (Number(node.bounds.top) - Number(scrollBounds.top)) * (scaled.height / (Number(scrollBounds.bottom) - Number(scrollBounds.top)));
      return { top, height };
    })
    .filter(({ top, height }) => top > 4 && top < scaled.height - 4 && height >= 8 && height <= Math.max(240, viewport.height * 0.18))
    .sort((left, right) => Math.abs(left.top - expectedTop) - Math.abs(right.top - expectedTop));
  const nearest = candidates[0];
  if (nearest && Math.abs(nearest.top - expectedTop) <= 96) return Math.round(nearest.top);
  return Math.round(expectedTop);
}

async function cropDifference(leftBuffer, rightBuffer, rect) {
  const [left, right] = await Promise.all([rawCrop(leftBuffer, rect), rawCrop(rightBuffer, rect)]);
  const width = Math.min(left.info.width, right.info.width);
  const height = Math.min(left.info.height, right.info.height);
  if (width <= 0 || height <= 0) return 255;
  return averageDifference(left.data, right.data, width, height, left.info.channels || 4);
}

async function findOverlap(previousBuffer, currentBuffer, rect) {
  const [previous, current] = await Promise.all([rawCrop(previousBuffer, rect), rawCrop(currentBuffer, rect)]);
  const width = Math.min(previous.info.width, current.info.width);
  const height = Math.min(previous.info.height, current.info.height);
  if (width <= 0 || height <= 0) return 0;
  const channels = previous.info.channels || 4;
  const previousRows = previous.data;
  const currentRows = current.data;
  const minOverlap = Math.floor(height * 0.35);
  const maxOverlap = Math.floor(height * 0.94);
  let best = { overlap: 0, score: Number.POSITIVE_INFINITY };
  for (let overlap = minOverlap; overlap <= maxOverlap; overlap += Math.max(2, Math.floor(height / 90))) {
    const rows = overlap;
    const previousSlice = Buffer.alloc(rows * width * channels);
    const currentSlice = Buffer.alloc(rows * width * channels);
    previous.data.copy(previousSlice, 0, (height - overlap) * width * channels, height * width * channels);
    current.data.copy(currentSlice, 0, 0, rows * width * channels);
    const score = averageDifference(previousSlice, currentSlice, width, rows, channels);
    if (score < best.score) best = { overlap, score };
  }
  // Device screenshots can differ slightly between frames (text antialiasing,
  // cursor blink, animated controls). Keep the best geometric match unless it
  // is clearly unrelated; a conservative fallback is handled by the caller.
  return best.score <= 82 ? best.overlap : 0;
}

async function findScrollShift(previousBuffer, currentBuffer, rect, expectedShift) {
  const [previous, current] = await Promise.all([rawCrop(previousBuffer, rect), rawCrop(currentBuffer, rect)]);
  const width = Math.min(previous.info.width, current.info.width);
  const height = Math.min(previous.info.height, current.info.height);
  const channels = previous.info.channels || 4;
  const expected = Math.max(1, Math.min(height - 1, Math.round(expectedShift)));
  const radius = Math.max(40, Math.min(140, Math.floor(height * 0.16)));
  let best = { shift: expected, score: Number.POSITIVE_INFINITY };
  for (let shift = Math.max(1, expected - radius); shift <= Math.min(height - 1, expected + radius); shift += 2) {
    const rows = height - shift;
    const previousSlice = Buffer.alloc(rows * width * channels);
    const currentSlice = Buffer.alloc(rows * width * channels);
    previous.data.copy(previousSlice, 0, shift * width * channels, height * width * channels);
    current.data.copy(currentSlice, 0, 0, rows * width * channels);
    const score = averageDifference(previousSlice, currentSlice, width, rows, channels);
    if (score < best.score) best = { shift, score };
  }
  return best.score <= 96 ? best.shift : expected;
}

async function composeFullPage({ nativeBuffer, chunks, scrollRect, viewport }) {
  const contentHeight = Math.max(...chunks.map((chunk) => chunk.topOffset + (chunk.fullPage ? scrollRect.height : chunk.appendHeight)));
  const topHeight = Math.max(0, scrollRect.top);
  const bottomTop = Math.min(viewport.height, scrollRect.top + scrollRect.height);
  const bottomHeight = Math.max(0, viewport.height - bottomTop);
  const outputHeight = topHeight + contentHeight + bottomHeight;
  const composites = [];
  if (topHeight > 0) {
    composites.push({
      input: await sharp(nativeBuffer).extract({ left: 0, top: 0, width: viewport.width, height: topHeight }).png().toBuffer(),
      left: 0,
      top: 0,
    });
  }
  for (const chunk of chunks) {
    composites.push({ input: chunk.cropBuffer, left: scrollRect.left, top: topHeight + chunk.topOffset });
  }
  if (bottomHeight > 0) {
    composites.push({
      input: await sharp(nativeBuffer).extract({ left: 0, top: bottomTop, width: viewport.width, height: bottomHeight }).png().toBuffer(),
      left: 0,
      top: topHeight + contentHeight,
    });
  }
  return sharp({
    create: {
      width: viewport.width,
      height: outputHeight,
      channels: 4,
      background: '#ffffff',
    },
  }).composite(composites).png().toBuffer();
}

async function swipe(adb, device, rect, direction) {
  const x = Math.round((rect.left + rect.right) / 2);
  // Keep each viewport overlap comfortably above 50%. Android applies a
  // variable fling distance to long swipes, so a near full-height gesture can
  // skip content between screenshots.
  const margin = Math.max(24, Math.round((rect.bottom - rect.top) * 0.42));
  const startY = direction === 'up' ? rect.bottom - margin : rect.top + margin;
  const endY = direction === 'up' ? rect.top + margin : rect.bottom - margin;
  const displayArg = typeof device.getDisplayArg === 'function' ? device.getDisplayArg() : '';
  await adb.shell(`input${displayArg} swipe ${x} ${Math.round(startY)} ${x} ${Math.round(endY)} 420`);
}

export async function captureNativeFullPage(agent, hierarchy, nativeImage, options = {}) {
  const device = agent?.interface;
  const viewport = hierarchy?.viewport;
  const node = largestScrollableNode(hierarchy);
  if (!device || typeof device.getAdb !== 'function' || !viewport?.width || !viewport?.height || !node) {
    return { status: 'unavailable', reason: '当前页面没有可用的原生滚动容器或设备视口信息' };
  }
  const scrollRect = node.bounds;
  const source = { width: nativeImage.width, height: nativeImage.height };
  const scaled = scaledRect(scrollRect, source, viewport);
  if (!scaled || scaled.height < 20) return { status: 'unavailable', reason: '原生滚动容器边界无效' };
  const adb = await device.getAdb();
  const captureViewport = async () => {
    if (typeof device.screenshotBase64 === 'function') {
      const value = await device.screenshotBase64();
      const match = String(value || '').match(/^data:image\/[^;]+;base64,(.+)$/s);
      if (match) return imageFromBuffer(Buffer.from(match[1], 'base64'));
    }
    if (adb.subprocess?.noneProtocol?.spawnWait) {
      const output = await adb.subprocess.noneProtocol.spawnWait(['screencap', '-p']);
      return imageFromBuffer(Buffer.from(output));
    }
    if (typeof agent.unfreezePageContext === 'function' && typeof agent.freezePageContext === 'function') {
      await agent.unfreezePageContext();
      await waitForFrame();
      await agent.freezePageContext();
      const context = await agent._snapshotContext();
      const match = String(context?.screenshot?.base64 || '').match(/^data:image\/[^;]+;base64,(.+)$/s);
      if (match) return imageFromBuffer(Buffer.from(match[1], 'base64'));
    }
    if (typeof options.captureScreen === 'function') return options.captureScreen();
    throw new Error('当前设备不支持实时截图');
  };
  // UIAutomator is captured after the bitmap. Leave enough time for Android's
  // post-swipe inertia to settle so both observations describe the same
  // content position. Tests may override this delay with a deterministic 0.
  const settleDelayMs = Math.max(0, Number(options.settleDelayMs ?? 520));
  const waitForFrame = () => new Promise((resolve) => setTimeout(resolve, settleDelayMs));
  // The frozen image is the authoritative origin. Keep a fresh copy as the
  // restore target because the live device may have changed between freeze
  // and the first gesture.
  const origin = await captureViewport().catch(() => nativeImage);
  const initialCrop = await crop(origin.buffer, scaled);
  const chunks = [{ cropBuffer: initialCrop, appendHeight: scaled.height, topOffset: 0, scrollOffset: 0, fullPage: true }];
  const structureSnapshots = [];
  let current = origin;
  let currentCrop = initialCrop;
  let previousSnapshot = null;

  const captureStructure = async (scrollTop) => {
    if (typeof options.captureChunk !== 'function') return null;
    const snapshot = await options.captureChunk({ scrollTop, scroller: node, scrollBounds: scrollRect, viewport });
    if (snapshot) structureSnapshots.push({ scrollTop, ...snapshot });
    return snapshot;
  };

  // Normalize the capture origin to the top of the native scroll container.
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await swipe(adb, device, scrollRect, 'down');
    await waitForFrame();
    const next = await captureViewport();
    const nextCrop = await crop(next.buffer, scaled);
    const difference = await cropDifference(current.buffer, next.buffer, scaled);
    if (difference < 2) break;
    current = next;
    currentCrop = nextCrop;
  }
  chunks.length = 0;
  chunks.push({ cropBuffer: currentCrop, appendHeight: scaled.height, topOffset: 0, scrollOffset: 0, fullPage: true });
  previousSnapshot = await captureStructure(0);

  let offset = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await swipe(adb, device, scrollRect, 'up');
    await waitForFrame();
    const next = await captureViewport();
    const nextCrop = await crop(next.buffer, scaled);
    const difference = await cropDifference(current.buffer, next.buffer, scaled);
    if (difference < 2) break;
    const nextSnapshot = await captureStructure(offset);
    const treeDelta = estimateScrollDelta(previousSnapshot, nextSnapshot, scrollRect);
    const overlap = await findOverlap(current.buffer, next.buffer, scaled);
    // If visual matching is inconclusive, append at most half a viewport. The
    // shorter gesture is designed to move less than this, so this may duplicate
    // a small band but cannot skip an unseen band of content.
    const imageAppendHeight = Math.max(1, scaled.height - (overlap || Math.floor(scaled.height * 0.55)));
    const treeAppendHeight = Math.abs(treeDelta);
    const rawAppendHeight = treeAppendHeight > 0
      ? Math.min(scaled.height - 1, Math.max(1, Math.round(treeAppendHeight * (source.height / viewport.height))))
      : imageAppendHeight;
    const useFullPageChunk = treeAppendHeight > 0;
    const alignedAppendHeight = useFullPageChunk
      ? await findScrollShift(current.buffer, next.buffer, scaled, rawAppendHeight)
      : rawAppendHeight;
    const expectedTop = scaled.height - alignedAppendHeight;
    const appendTop = useFullPageChunk ? 0 : safeAppendTop(nextSnapshot, expectedTop, scaled, scrollRect, viewport);
    const appendHeight = useFullPageChunk
      ? alignedAppendHeight
      : Math.max(1, scaled.height - appendTop);
    offset += appendHeight;
    // The snapshot was captured after the swipe that produced this chunk.
    // Assign the newly measured offset to that same snapshot before the next
    // gesture; leaving the previous value here shifts every off-screen node
    // one chunk behind the stitched image.
    const currentSnapshot = structureSnapshots.at(-1);
    if (currentSnapshot) currentSnapshot.scrollTop = offset;
    const nextCropBuffer = await crop(next.buffer, scaled);
    const appendBuffer = useFullPageChunk
      ? nextCropBuffer
      : await sharp(nextCropBuffer)
        .extract({ left: 0, top: appendTop, width: scaled.width, height: appendHeight })
        .png()
        .toBuffer();
    chunks.push({ cropBuffer: appendBuffer, appendHeight, topOffset: offset, scrollOffset: offset, fullPage: useFullPageChunk });
    current = next;
    currentCrop = nextCrop;
    previousSnapshot = nextSnapshot;
  }

  // Leave the device at the bottom after the final segment. The caller asked
  // for the completed capture to remain at the end of the scrollable page;
  // do not issue a restore gesture here.
  const buffer = await composeFullPage({ nativeBuffer: nativeImage.buffer, chunks, scrollRect: scaled, viewport: source });
  const metadata = await sharp(buffer).metadata();
  return {
    status: chunks.length > 1 ? 'complete' : 'not-scrollable',
    reason: chunks.length > 1 ? null : '原生滚动容器内容未超过一屏',
    image: { buffer, mimeType: 'image/png', extension: 'png', width: metadata.width, height: metadata.height },
    capture: {
      kind: 'native-full-page',
      method: 'uiautomator-scroll-screenshot-stitch',
      deviceViewport: source,
      scrollBounds: scaled,
      scrollContainer: { class: node.class, resourceId: node.resourceId || '', bounds: scrollRect },
      chunkCount: chunks.length,
      contentHeight: chunks.reduce((total, chunk) => total + chunk.appendHeight, 0),
      settleDelayMs,
    },
    structureSnapshots,
  };
}
