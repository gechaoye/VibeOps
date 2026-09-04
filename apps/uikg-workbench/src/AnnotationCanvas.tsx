import { useEffect, useMemo, useRef, useState } from 'react';
import { clampBox, reviewStatusLabels } from './model';
import type { BBox, DraftElement } from './types';

interface AnnotationCanvasProps {
  imageUrl: string;
  deviceViewport?: { width: number; height: number };
  runtimeStructure?: Record<string, unknown> | null;
  useDeviceViewport: boolean;
  elements: DraftElement[];
  selectedId: string | null;
  selectedAbstractInstanceIndex: number | null;
  selectedAbstractFieldKey: string | null;
  selectedAbstractFieldInstanceIndex: number | null;
  drawing: boolean;
  showRejected: boolean;
  showGridGuides: boolean;
  onSelect: (id: string | null) => void;
  onSelectAbstractInstance: (index: number | null) => void;
  onSelectAbstractField: (fieldKey: string | null) => void;
  onSelectAbstractFieldInstance: (index: number | null) => void;
  onAdd: (box: BBox) => void;
  onBoxChange: (id: string, box: BBox) => void;
  onAbstractInstanceBoxChange: (id: string, index: number, box: BBox) => void;
  onAbstractFieldBoxChange: (id: string, fieldKey: string, index: number, box: BBox) => void;
  onBoxChangeEnd: () => void;
}

type Gesture =
  | { type: 'draw'; startX: number; startY: number; currentX: number; currentY: number }
  | { type: 'move'; id: string; startX: number; startY: number; initial: BBox; overlay: boolean }
  | { type: 'resize'; id: string; handle: string; startX: number; startY: number; initial: BBox; overlay: boolean }
  | { type: 'abstract-instance-move'; id: string; index: number; startX: number; startY: number; initial: BBox; overlay: boolean }
  | { type: 'abstract-instance-resize'; id: string; index: number; handle: string; startX: number; startY: number; initial: BBox; overlay: boolean }
  | { type: 'abstract-move'; id: string; fieldKey: string; index: number; startX: number; startY: number; initial: BBox; overlay: boolean }
  | { type: 'abstract-resize'; id: string; fieldKey: string; index: number; handle: string; startX: number; startY: number; initial: BBox; overlay: boolean };

type Preview =
  | { type: 'element'; id: string; box: BBox }
  | { type: 'abstract-instance'; id: string; index: number; box: BBox }
  | { type: 'abstract'; id: string; fieldKey: string; index: number; box: BBox };

function point(event: React.PointerEvent, target: HTMLElement, clamp = true) {
  const rect = target.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  return clamp ? { x: Math.min(Math.max(x, 0), 1), y: Math.min(Math.max(y, 0), 1) } : { x, y };
}

function resizedBox(initial: BBox, handle: string, dx: number, dy: number): BBox {
  let { x, y, width, height } = initial;
  if (handle.includes('w')) { x += dx; width -= dx; }
  if (handle.includes('e')) width += dx;
  if (handle.includes('n')) { y += dy; height -= dy; }
  if (handle.includes('s')) height += dy;
  return clampBox({ x, y, width, height });
}

function elementAtPoint(elements: DraftElement[], selectedId: string | null, x: number, y: number, preferredId: string | null = null) {
  const hits = elements
    .map((element) => {
      const regions = element.abstraction?.instanceRegions?.filter(Boolean) || [];
      const hitRegion = (regions.length ? regions : [element.bbox]).find((region) => (
        x >= region.x && x <= region.x + region.width && y >= region.y && y <= region.y + region.height
      ));
      return hitRegion ? { element, area: hitRegion.width * hitRegion.height } : null;
    })
    .filter((entry): entry is { element: DraftElement; area: number } => Boolean(entry))
    .sort((left, right) => left.area - right.area);
  if (hits.length === 0) return null;
  const preferred = preferredId && hits.find(({ element }) => element.id === preferredId);
  if (preferred) return preferred.element;
  const selectedIndex = hits.findIndex(({ element }) => element.id === selectedId);
  return hits[(selectedIndex + 1) % hits.length].element;
}

function runtimeFixedBoxes(runtimeStructure: Record<string, unknown> | null | undefined, width: number, height: number): BBox[] | null {
  if (!runtimeStructure || !width || !height) return null;
  const hierarchy = (runtimeStructure.hierarchy || runtimeStructure) as Record<string, any>;
  const hasFixedMetadata = Array.isArray(hierarchy.fixedNodes)
    || Array.isArray((runtimeStructure.dom as Record<string, any> | undefined)?.fixedNodes);
  if (!hasFixedMetadata) return null;
  const flatten = (node: any, output: any[] = []) => {
    if (!node) return output;
    output.push(node);
    for (const child of node.children || []) flatten(child, output);
    return output;
  };
  const scrollable = flatten(hierarchy.root).filter((node) => node?.scrollable && node.bounds).sort((left, right) => (
    (Number(right.bounds.right) - Number(right.bounds.left)) * (Number(right.bounds.bottom) - Number(right.bounds.top))
    - (Number(left.bounds.right) - Number(left.bounds.left)) * (Number(left.bounds.bottom) - Number(left.bounds.top))
  ));
  const nodes = [
    ...(Array.isArray(hierarchy.fixedNodes) ? hierarchy.fixedNodes : []),
    ...(Array.isArray((runtimeStructure.dom as Record<string, any> | undefined)?.fixedNodes)
      ? (runtimeStructure.dom as Record<string, any>).fixedNodes
      : []),
  ];
  // Follow ancestry rather than long-image coordinates. Merged descendants
  // below the fold can lie outside the original scroll rectangle numerically,
  // but remain scrolling content because they descend from ScrollView.
  const concreteOutsideScroll: any[] = [];
  const collectOutsideScroll = (node: any, insideScrollable = false) => {
    if (!node) return;
    const nestedInScrollable = insideScrollable || node.scrollable === true;
    if (node.bounds && !nestedInScrollable && node.scrollable !== true) {
      const className = String(node.class || '');
      const structural = /(?:Layout|ViewGroup|ScrollView|RecyclerView|WebView|FrameLayout|LinearLayout|RelativeLayout|ConstraintLayout|CoordinatorLayout)$/i.test(className);
      const concrete = Boolean(node.text || node.contentDescription || node.clickable || node.checkable || node.focusable
        || /(?:TextView|ImageView|Button|EditText|Switch|CheckBox|RadioButton)$/i.test(className));
      const area = Math.max(0, Number(node.bounds.right) - Number(node.bounds.left))
        * Math.max(0, Number(node.bounds.bottom) - Number(node.bounds.top));
      if (concrete && !(structural && area > 0.7 * 1_000_000)) concreteOutsideScroll.push(node);
    }
    for (const child of node.children || []) collectOutsideScroll(child, nestedInScrollable);
  };
  const structuralRoots = hierarchy.fullPage
    ? (hierarchy.root?.children || []).filter((node: any) => flatten(node).some((candidate) => candidate?.scrollable === true))
    : [hierarchy.root];
  for (const root of structuralRoots.length ? structuralRoots : [hierarchy.root]) collectOutsideScroll(root);
  return [...nodes, ...concreteOutsideScroll]
    .filter((node) => node?.bounds && !scrollable.some((container) => (
      node.bounds.left >= container.bounds.left
      && node.bounds.top >= container.bounds.top
      && node.bounds.right <= container.bounds.right
      && node.bounds.bottom <= container.bounds.bottom
    )))
    .map((node) => ({
      x: Math.max(0, Number(node.bounds.left)) / width,
      y: Math.max(0, Number(node.bounds.top)) / height,
      width: Math.max(0, Number(node.bounds.right) - Number(node.bounds.left)) / width,
      height: Math.max(0, Number(node.bounds.bottom) - Number(node.bounds.top)) / height,
    }))
    .filter((box) => box.width > 0 && box.height > 0);
}

function regionOverlap(left: BBox, right: BBox) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height / Math.max(0.000001, left.width * left.height);
}

function regionsRepresentSameElement(left: BBox, right: BBox) {
  return regionOverlap(left, right) >= 0.6 && regionOverlap(right, left) >= 0.6;
}

const fixedVisualFieldTypes = new Set([
  'avatar', 'avatar-group', 'image', 'banner', 'thumbnail', 'preview', 'carousel',
  'image-viewer', 'file-preview', 'video',
]);

function regionMatchesFixedBox(region: BBox, fixedBoxes: BBox[]) {
  return fixedBoxes.some((box) => regionsRepresentSameElement(region, box));
}

function abstractInstanceHasFixedVisualField(element: DraftElement, instanceIndex: number, fixedBoxes: BBox[]) {
  return element.abstraction?.kind === 'dynamic-template'
    && element.abstraction.fields.some((field) => {
      if (!fixedVisualFieldTypes.has(field.elementType)) return false;
      const region = field.instanceRegions[instanceIndex];
      if (!region) return false;
      return regionMatchesFixedBox(region, fixedBoxes);
    });
}

function largestScrollableBounds(runtimeStructure: Record<string, unknown> | null | undefined) {
  const hierarchy = (runtimeStructure?.hierarchy || runtimeStructure) as Record<string, any> | undefined;
  const flatten = (node: any, output: any[] = []) => {
    if (!node) return output;
    output.push(node);
    for (const child of node.children || []) flatten(child, output);
    return output;
  };
  return flatten(hierarchy?.root)
    .filter((node) => node?.scrollable && node.bounds)
    .sort((left, right) => (
      (Number(right.bounds.right) - Number(right.bounds.left)) * (Number(right.bounds.bottom) - Number(right.bounds.top))
      - (Number(left.bounds.right) - Number(left.bounds.left)) * (Number(left.bounds.bottom) - Number(left.bounds.top))
    ))[0]?.bounds || null;
}

export function AnnotationCanvas({ imageUrl, deviceViewport, runtimeStructure, useDeviceViewport, elements, selectedId, selectedAbstractInstanceIndex, selectedAbstractFieldKey, selectedAbstractFieldInstanceIndex, drawing, showRejected, showGridGuides, onSelect, onSelectAbstractInstance, onSelectAbstractField, onSelectAbstractFieldInstance, onAdd, onBoxChange, onAbstractInstanceBoxChange, onAbstractFieldBoxChange, onBoxChangeEnd }: AnnotationCanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollLayerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const previewRef = useRef<Preview | null>(null);
  const previewFrameRef = useRef<number | null>(null);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [availableSize, setAvailableSize] = useState({ width: 0, height: 0 });

  useEffect(() => () => {
    if (previewFrameRef.current !== null) cancelAnimationFrame(previewFrameRef.current);
  }, []);

  const schedulePreview = (next: Preview | null) => {
    previewRef.current = next;
    if (previewFrameRef.current !== null) return;
    previewFrameRef.current = requestAnimationFrame(() => {
      previewFrameRef.current = null;
      setPreview(previewRef.current);
    });
  };

  const clearPreview = () => {
    previewRef.current = null;
    if (previewFrameRef.current !== null) {
      cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    setPreview(null);
  };

  useEffect(() => {
    const container = viewportRef.current?.parentElement;
    if (!container) return;
    const updateSize = (width: number, height: number) => {
      setAvailableSize((current) => current.width === width && current.height === height ? current : { width, height });
    };
    const observer = new ResizeObserver(([entry]) => {
      updateSize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(container);
    const rect = container.getBoundingClientRect();
    const styles = window.getComputedStyle(container);
    updateSize(
      Math.max(0, rect.width - Number.parseFloat(styles.paddingLeft) - Number.parseFloat(styles.paddingRight)),
      Math.max(0, rect.height - Number.parseFloat(styles.paddingTop) - Number.parseFloat(styles.paddingBottom)),
    );
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => {
    if (!imageSize.width || !imageSize.height || !availableSize.width || !availableSize.height) return null;
    const isLongPage = Boolean(deviceViewport?.width && deviceViewport?.height
      && imageSize.height > deviceViewport.height * 1.05
      && Math.abs(imageSize.width / deviceViewport.width - 1) < 0.08);
    const viewportMode = isLongPage && useDeviceViewport;
    const reference = viewportMode ? deviceViewport! : imageSize;
    const scale = Math.min(availableSize.width / reference.width, availableSize.height / reference.height);
    return {
      isLongPage,
      viewportMode,
      viewport: { width: reference.width * scale, height: reference.height * scale },
      stage: { width: imageSize.width * scale, height: imageSize.height * scale },
    };
  }, [availableSize, deviceViewport, imageSize, useDeviceViewport]);

  const scrollRegion = useMemo(() => {
    if (!layout?.viewportMode || !deviceViewport || !imageSize.width || !imageSize.height) return null;
    const bounds = largestScrollableBounds(runtimeStructure);
    if (!bounds) return null;
    const scale = layout.stage.width / imageSize.width;
    const top = Math.max(0, Number(bounds.top) * scale);
    const height = Math.max(1, (Number(bounds.bottom) - Number(bounds.top)) * scale);
    const bottom = Math.max(0, (Number(deviceViewport.height) - Number(bounds.bottom)) * scale);
    const contentHeight = Math.max(height, layout.stage.height - top - bottom);
    return { top, height, bottom, contentHeight };
  }, [deviceViewport, imageSize, layout, runtimeStructure]);

  useEffect(() => {
    if (scrollLayerRef.current) scrollLayerRef.current.scrollTop = 0;
  }, [imageUrl, useDeviceViewport]);

  const onPointerMove = (event: React.PointerEvent) => {
    if (!gesture || !stageRef.current) return;
    const current = gesture.type !== 'draw' && gesture.overlay && viewportRef.current && layout
      ? (() => {
          const rect = viewportRef.current!.getBoundingClientRect();
          return { x: (event.clientX - rect.left) / layout.stage.width, y: (event.clientY - rect.top) / layout.stage.height };
        })()
      : point(event, stageRef.current, false);
    if (gesture.type === 'draw') {
      setGesture({ ...gesture, currentX: current.x, currentY: current.y });
      return;
    }
    const dx = current.x - gesture.startX;
    const dy = current.y - gesture.startY;
    if (gesture.type === 'move') {
      schedulePreview({ type: 'element', id: gesture.id, box: clampBox({ ...gesture.initial, x: gesture.initial.x + dx, y: gesture.initial.y + dy }) });
    } else if (gesture.type === 'resize') {
      schedulePreview({ type: 'element', id: gesture.id, box: resizedBox(gesture.initial, gesture.handle, dx, dy) });
    } else if (gesture.type === 'abstract-instance-move') {
      schedulePreview({ type: 'abstract-instance', id: gesture.id, index: gesture.index, box: clampBox({ ...gesture.initial, x: gesture.initial.x + dx, y: gesture.initial.y + dy }) });
    } else if (gesture.type === 'abstract-instance-resize') {
      schedulePreview({ type: 'abstract-instance', id: gesture.id, index: gesture.index, box: resizedBox(gesture.initial, gesture.handle, dx, dy) });
    } else if (gesture.type === 'abstract-move') {
      schedulePreview({ type: 'abstract', id: gesture.id, fieldKey: gesture.fieldKey, index: gesture.index, box: clampBox({ ...gesture.initial, x: gesture.initial.x + dx, y: gesture.initial.y + dy }) });
    } else {
      schedulePreview({ type: 'abstract', id: gesture.id, fieldKey: gesture.fieldKey, index: gesture.index, box: resizedBox(gesture.initial, gesture.handle, dx, dy) });
    }
  };

  const onPointerUp = () => {
    if (gesture?.type === 'draw') {
      const x = Math.min(gesture.startX, gesture.currentX);
      const y = Math.min(gesture.startY, gesture.currentY);
      const width = Math.abs(gesture.currentX - gesture.startX);
      const height = Math.abs(gesture.currentY - gesture.startY);
      if (width > 0.015 && height > 0.015) onAdd({ x, y, width, height });
    } else if (gesture) {
      const next = previewRef.current;
      if (next) {
        const changed = Object.keys(gesture.initial).some((key) => {
          const field = key as keyof BBox;
          return gesture.initial[field] !== next.box[field];
        });
        if (changed) {
          if (next.type === 'element') onBoxChange(next.id, next.box);
          else if (next.type === 'abstract-instance') onAbstractInstanceBoxChange(next.id, next.index, next.box);
          else onAbstractFieldBoxChange(next.id, next.fieldKey, next.index, next.box);
        }
      }
      onBoxChangeEnd();
    }
    clearPreview();
    setGesture(null);
  };

  const onPointerCancel = () => {
    if (gesture && gesture.type !== 'draw') onBoxChangeEnd();
    clearPreview();
    setGesture(null);
  };

  const drawBox = gesture?.type === 'draw'
    ? {
        x: Math.min(gesture.startX, gesture.currentX),
        y: Math.min(gesture.startY, gesture.currentY),
        width: Math.abs(gesture.currentX - gesture.startX),
        height: Math.abs(gesture.currentY - gesture.startY),
      }
    : null;
  const visibleElements = useMemo(() => elements.filter((element) => showRejected || element.reviewStatus !== 'rejected'), [elements, showRejected]);
  const fixedBoxes = useMemo(() => runtimeFixedBoxes(runtimeStructure, imageSize.width, imageSize.height), [runtimeStructure, imageSize.height, imageSize.width]);
  const isElementFixed = (element: DraftElement) => {
    // Once a runtime hierarchy is available it is authoritative. This also
    // prevents stale fixed-position flags from an older recognition result
    // from pinning scrollable meeting-mode/settings content.
    const explicitlyFixed = element.riskSignals?.includes('fixed-position');
    if (!fixedBoxes) return explicitlyFixed;
    const regions = (element.abstraction?.instanceRegions?.length
      ? element.abstraction.instanceRegions
      : [element.bbox]).filter(Boolean);
    if (regions.length === 0) return false;
    if (regions.every((region) => regionMatchesFixedBox(region, fixedBoxes))) return true;
    // A dynamic template can combine a fixed visual slot (for example an
    // avatar image) with adjacent content such as a user name. Its complete
    // instance region is intentionally larger than the runtime image node,
    // so match each instance through its stable visual field as a fallback.
    return regions.every((_, index) => abstractInstanceHasFixedVisualField(element, index, fixedBoxes));
  };
  const fixedElements = useMemo(() => visibleElements.filter(isElementFixed), [fixedBoxes, visibleElements]);
  const scrollingElements = useMemo(() => visibleElements.filter((element) => !isElementFixed(element)), [fixedBoxes, visibleElements]);
  // Coordinates outside the scroll container still belong to the full-page
  // image. Promoting them to the fixed layer makes below-the-fold boxes render
  // outside the scroll context and detach them from their content. Only nodes
  // explicitly identified as fixed by runtime evidence belong in the overlay.
  const viewportMode = Boolean(layout?.viewportMode);
  const contentElements = viewportMode ? scrollingElements : visibleElements;
  const movableElements = visibleElements;
  const overlayElements = viewportMode ? fixedElements : [];
  // Abstract templates are represented by their instance regions; their inherited
  // parent/list bbox must never become a single selection rectangle.
  const renderedElements = useMemo(() => [...contentElements.filter((element) => (!element.abstraction || element.abstraction.instanceRegions.length === 0))]
    .sort((left, right) => Number(left.id === selectedId) - Number(right.id === selectedId)), [contentElements, selectedId]);
  const selectedElement = useMemo(() => visibleElements.find((element) => element.id === selectedId) || null, [selectedId, visibleElements]);
  const selectedInheritsListRegion = useMemo(() => Boolean(selectedElement?.abstraction?.kind === 'repeated-template' && visibleElements.some((candidate) => candidate.id === selectedElement.parentId && ['list', 'grouped-list', 'swipe-list', 'expandable-list'].includes(candidate.elementType))), [selectedElement, visibleElements]);
  const selectedElementIsOverlay = Boolean(selectedElement && overlayElements.some((element) => element.id === selectedElement.id));
  const boxForElement = (element: DraftElement) => preview?.type === 'element' && preview.id === element.id ? preview.box : element.bbox;
  const boxForAbstractInstance = (element: DraftElement, index: number, region: BBox) => (
    preview?.type === 'abstract-instance' && preview.id === element.id && preview.index === index ? preview.box : region
  );
  const boxForAbstractField = (element: DraftElement, fieldKey: string, index: number, region: BBox) => (
    preview?.type === 'abstract' && preview.id === element.id && preview.fieldKey === fieldKey && preview.index === index ? preview.box : region
  );
  const fixedRegionStyle = (region: BBox) => {
    if (!layout || !imageSize.width || !imageSize.height) return {};
    const scale = layout.stage.width / imageSize.width;
    return {
      left: `${region.x * layout.stage.width}px`,
      // Fixed runtime bounds are normalized against the full captured image,
      // but their on-screen position is still expressed in image pixels.
      top: `${region.y * imageSize.height * scale}px`,
      width: `${region.width * layout.stage.width}px`,
      height: `${region.height * imageSize.height * scale}px`,
    };
  };
  const fixedInstances = overlayElements.flatMap((element) => (
    element.abstraction?.instanceRegions
      ?.map((region, index) => ({ element, region, index })) || []
  )).filter(({ region }) => {
    if (!layout || !imageSize.height) return false;
    const scale = layout.stage.width / imageSize.width;
    const top = region.y * imageSize.height * scale;
    const bottom = (region.y + region.height) * imageSize.height * scale;
    return bottom > 0 && top < layout.viewport.height;
  });
  const isOutsideScrollRegion = (box: BBox) => {
    if (!layout || !scrollRegion) return false;
    const top = box.y * layout.stage.height;
    const bottom = (box.y + box.height) * layout.stage.height;
    const scrollBottom = scrollRegion.top + scrollRegion.height;
    // Only promote boxes that are wholly inside the fixed top/bottom bands.
    // A box crossing the scroll boundary must remain in the scroll layer;
    // cloning it above the layer would cover its child/instance bboxes.
    return (top >= 0 && bottom <= scrollRegion.top)
      || (top >= scrollBottom && top < layout.viewport.height);
  };
  const edgeElements = viewportMode
    ? contentElements.filter((element) => !element.abstraction && isOutsideScrollRegion(element.bbox))
    : [];
  const edgeInstances = viewportMode
    ? contentElements.flatMap((element) => element.abstraction?.instanceRegions.map((region, index) => ({ element, region, index })) || [])
      .filter(({ region }) => isOutsideScrollRegion(region))
    : [];
  const imagePoint = (event: React.PointerEvent<HTMLElement>, overlay: boolean) => (
    overlay && viewportRef.current && layout
      ? (() => {
          const rect = viewportRef.current!.getBoundingClientRect();
          return { x: (event.clientX - rect.left) / layout.stage.width, y: (event.clientY - rect.top) / layout.stage.height };
        })()
      : stageRef.current ? point(event, stageRef.current, false) : { x: 0, y: 0 }
  );
  const selectElementAtPointer = (event: React.PointerEvent<HTMLElement>, fallbackId: string | null = null, preferredId: string | null = null) => {
    if (!stageRef.current) return null;
    const overlay = Boolean(event.currentTarget.closest('.annotation-fixed-layer'));
    const start = imagePoint(event, overlay);
    const hit = elementAtPoint(movableElements, selectedId, start.x, start.y, preferredId);
    const selected = hit || (fallbackId ? movableElements.find((element) => element.id === fallbackId) || null : null);
    if (!selected) return null;
    onSelect(selected.id);
    onSelectAbstractInstance(null);
    onSelectAbstractField(null);
    onSelectAbstractFieldInstance(null);
    return { selected, overlay, start };
  };
  const beginElementGesture = (event: React.PointerEvent<HTMLElement>, preferredId: string | null = null) => {
    if (drawing || !stageRef.current) return;
    event.stopPropagation();
    const result = selectElementAtPointer(event, null, preferredId);
    if (!result) return;
    const { selected, overlay, start } = result;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (!selected.abstraction) {
      setGesture({ type: 'move', id: selected.id, startX: start.x, startY: start.y, initial: { ...selected.bbox }, overlay });
    }
  };
  return (
    <div
      ref={viewportRef}
      className={`annotation-canvas-viewport ${layout?.viewportMode ? 'annotation-device-viewport' : ''}`}
      style={layout?.viewport}
      data-long-page={layout?.isLongPage ? 'true' : 'false'}
      data-viewport-mask={layout?.viewportMode ? 'true' : 'false'}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
    <div
      className="annotation-scroll-layer"
      ref={scrollLayerRef}
      style={scrollRegion ? { position: 'absolute', top: `${scrollRegion.top}px`, left: 0, width: '100%', height: `${scrollRegion.height}px` } : undefined}
    >
      <div className="annotation-scroll-content" style={scrollRegion ? { width: `${layout?.stage.width || 0}px`, height: `${scrollRegion.contentHeight}px` } : undefined}>
      <div
        ref={stageRef}
        className={`annotation-stage ${drawing ? 'annotation-stage-drawing' : ''}`}
        style={scrollRegion ? { ...layout?.stage, position: 'absolute', top: `${-scrollRegion.top}px`, left: 0 } : layout?.stage}
        onPointerDown={(event) => {
          const isBackground = event.target === event.currentTarget || event.target instanceof HTMLImageElement;
          if (!stageRef.current || !isBackground) return;
          if (!drawing) {
            onSelect(null);
            onSelectAbstractInstance(null);
            onSelectAbstractField(null);
            onSelectAbstractFieldInstance(null);
            return;
          }
          const start = point(event, stageRef.current);
          event.currentTarget.setPointerCapture(event.pointerId);
          setGesture({ type: 'draw', startX: start.x, startY: start.y, currentX: start.x, currentY: start.y });
          onSelect(null);
        }}
      >
      <img
        src={imageUrl}
        alt="冻结设备画面"
        draggable={false}
        onLoad={(event) => setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
      />
      {showGridGuides && selectedElement && !selectedInheritsListRegion && (
        <div
          className="annotation-grid"
          aria-hidden="true"
          style={{
            gridTemplateColumns: `repeat(${selectedElement.gridColumns}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${selectedElement.gridRows}, minmax(0, 1fr))`,
          }}
        >
          {Array.from({ length: selectedElement.gridColumns * selectedElement.gridRows }, (_, index) => (
            <span key={index} className={`annotation-grid-cell ${index + 1 === selectedElement.gridRegion ? 'annotation-grid-cell-active' : ''}`}>
              <span className="annotation-grid-label">{index + 1}</span>
            </span>
          ))}
        </div>
      )}
      {contentElements.flatMap((element) => element.abstraction?.instanceRegions.map((region, index) => ({ element, region, index })) || []).map(({ element, region, index }) => {
        const box = boxForAbstractInstance(element, index, region);
        const selected = element.id === selectedId && (selectedAbstractInstanceIndex === index || selectedAbstractInstanceIndex === null);
        return (
        <div
          key={`${element.id}-instance-${index}`}
          className={`bbox bbox-abstract bbox-abstract-instance ${selected ? 'bbox-abstract-instance-selected' : ''}`}
          style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` }}
          title={`${element.label} · 第 ${index + 1} 项实例`}
          aria-label={`${element.label} 实例 ${index + 1} bbox`}
          onPointerDown={(event) => {
            if (drawing || !stageRef.current) return;
            event.stopPropagation();
            const result = selectElementAtPointer(event, element.id, element.id);
            if (!result) return;
            const start = result.start;
            event.currentTarget.setPointerCapture(event.pointerId);
            onSelectAbstractInstance(index);
            setGesture({ type: 'abstract-instance-move', id: element.id, index, startX: start.x, startY: start.y, initial: { ...region }, overlay: false });
          }}
        >
          <span className="bbox-label">{element.label} · 实例 {index + 1}</span>
          <span className="bbox-center" />
          {selected && selectedAbstractInstanceIndex === index && ['nw', 'ne', 'sw', 'se'].map((handle) => (
            <button
              key={handle}
              type="button"
              className={`bbox-handle bbox-handle-${handle}`}
              aria-label={`调整${element.label}实例 ${index + 1} 边框 ${handle}`}
              onPointerDown={(event) => {
                event.stopPropagation();
                if (!stageRef.current) return;
                const start = point(event, stageRef.current);
                event.currentTarget.setPointerCapture(event.pointerId);
                setGesture({ type: 'abstract-instance-resize', id: element.id, index, handle, startX: start.x, startY: start.y, initial: { ...region }, overlay: false });
              }}
            />
          ))}
        </div>
        );
      })}
      {selectedElement?.abstraction?.fields.find((field) => field.key === selectedAbstractFieldKey)?.instanceRegions.map((region, index) => {
        if (!region) return null;
        const field = selectedElement.abstraction?.fields.find((candidate) => candidate.key === selectedAbstractFieldKey);
        const selected = selectedAbstractFieldInstanceIndex === index;
        return (
          <div
            key={`${selectedElement.id}-field-${selectedAbstractFieldKey}-${index}`}
            className={`bbox-abstract-field-instance ${selected ? 'bbox-abstract-field-instance-selected' : ''}`}
            style={(() => {
              const box = boxForAbstractField(selectedElement, selectedAbstractFieldKey!, index, region);
              return { left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` };
            })()}
            title={`${field?.label || '共相字段'} · 第 ${index + 1} 项实例`}
            aria-label={`${field?.label || '共相字段'} 第 ${index + 1} 项实例 bbox`}
            onPointerDown={(event) => {
              if (drawing || !stageRef.current || !field) return;
              event.stopPropagation();
              const start = point(event, stageRef.current);
              event.currentTarget.setPointerCapture(event.pointerId);
              onSelectAbstractInstance(null);
              onSelectAbstractFieldInstance(index);
              setGesture({ type: 'abstract-move', id: selectedElement.id, fieldKey: field.key, index, startX: start.x, startY: start.y, initial: { ...region }, overlay: false });
            }}
          >
            <span className="bbox-label">{field?.label || '共相字段'} · 实例 {index + 1}</span>
            <span className="bbox-center" />
            {selected && field && ['nw', 'ne', 'sw', 'se'].map((handle) => (
              <button
                key={handle}
                type="button"
                className={`bbox-handle bbox-handle-${handle}`}
                aria-label={`调整${field.label}实例 ${index + 1} 边框 ${handle}`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  if (!stageRef.current) return;
                  const start = point(event, stageRef.current);
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setGesture({ type: 'abstract-resize', id: selectedElement.id, fieldKey: field.key, index, handle, startX: start.x, startY: start.y, initial: { ...region }, overlay: false });
                }}
              />
            ))}
          </div>
        );
      })}
      {renderedElements.map((element) => {
        const selected = element.id === selectedId;
        return (
          <div
            key={element.id}
            className={`bbox bbox-${element.reviewStatus} ${element.abstraction ? 'bbox-abstract' : ''} ${element.childrenIds.length > 0 ? 'bbox-container' : ''} ${selected ? 'bbox-selected' : ''}`}
            style={(() => {
              const box = boxForElement(element);
              return { left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` };
            })()}
            onPointerDown={(event) => {
              beginElementGesture(event, element.id);
            }}
            title={`${element.abstraction ? element.abstraction.kind === 'dynamic-template' ? '动态元素共相' : '列表项元素共相' : element.label} · ${reviewStatusLabels[element.reviewStatus]}`}
          >
            <span className="bbox-label">{element.abstraction ? element.abstraction.kind === 'dynamic-template' ? `${element.label} · 动态元素共相` : `${element.label} · ${element.abstraction.instanceCount} 个实例` : element.label}</span>
            <span className="bbox-center" />
            {selected && !element.abstraction && !selectedInheritsListRegion && (
              <span className={`bbox-detail ${element.bbox.y > 0.72 ? 'bbox-detail-above' : ''}`}>
                <strong>{element.meaning.description || element.visualDescription || '含义待确认'}</strong>
                <span>可信度 {Math.round(element.confidence * 100)}%</span>
                <span>宫格 {element.gridColumns} × {element.gridRows} · 区域 {element.gridRegion}</span>
                <span>中心点 ({Math.round((element.bbox.x + element.bbox.width / 2) * imageSize.width)}, {Math.round((element.bbox.y + element.bbox.height / 2) * imageSize.height)})</span>
              </span>
            )}
            {selected && !element.abstraction && ['nw', 'ne', 'sw', 'se'].map((handle) => (
              <button
                key={handle}
                type="button"
                className={`bbox-handle bbox-handle-${handle}`}
                aria-label={`调整边框 ${handle}`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  if (!stageRef.current) return;
                  const start = point(event, stageRef.current);
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setGesture({ type: 'resize', id: element.id, handle, startX: start.x, startY: start.y, initial: { ...element.bbox }, overlay: false });
                }}
              />
            ))}
          </div>
        );
      })}
      {drawBox && <div className="bbox bbox-new" style={{ left: `${drawBox.x * 100}%`, top: `${drawBox.y * 100}%`, width: `${drawBox.width * 100}%`, height: `${drawBox.height * 100}%` }} />}
      </div>
      </div>
    </div>
    <div
      className="annotation-fixed-layer"
      aria-label="固定视口元素"
    >
      {scrollRegion && (
        <>
          <div className="annotation-fixed-pixels annotation-fixed-pixels-top" aria-hidden="true" style={{ height: `${scrollRegion.top}px`, backgroundImage: `url(${JSON.stringify(imageUrl)})`, backgroundSize: `${layout?.stage.width}px ${layout?.stage.height}px`, backgroundPosition: '0 0' }} />
          <div className="annotation-fixed-pixels annotation-fixed-pixels-bottom" aria-hidden="true" style={{ height: `${scrollRegion.bottom}px`, backgroundImage: `url(${JSON.stringify(imageUrl)})`, backgroundSize: `${layout?.stage.width}px ${layout?.stage.height}px`, backgroundPosition: `0 ${-(scrollRegion.top + scrollRegion.contentHeight)}px` }} />
        </>
      )}
      {edgeInstances.map(({ element, region, index }) => {
        const box = boxForAbstractInstance(element, index, region);
        const selected = element.id === selectedId && (selectedAbstractInstanceIndex === index || selectedAbstractInstanceIndex === null);
        return (
          <div
            key={`${element.id}-edge-instance-${index}`}
            className={`bbox bbox-abstract bbox-abstract-instance bbox-edge-instance ${selected ? 'bbox-abstract-instance-selected' : ''}`}
            style={fixedRegionStyle(box)}
            title={`${element.label} · 第 ${index + 1} 项实例`}
            aria-label={`${element.label} 实例 ${index + 1} bbox`}
            onPointerDown={(event) => {
              if (drawing || !stageRef.current) return;
              event.stopPropagation();
              const result = selectElementAtPointer(event, element.id, element.id);
              if (!result) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              onSelectAbstractInstance(index);
              setGesture({ type: 'abstract-instance-move', id: element.id, index, startX: result.start.x, startY: result.start.y, initial: { ...region }, overlay: true });
            }}
          >
            <span className="bbox-label">{element.label} · 实例 {index + 1}</span>
            <span className="bbox-center" />
            {selected && selectedAbstractInstanceIndex === index && ['nw', 'ne', 'sw', 'se'].map((handle) => (
              <button
                key={handle}
                type="button"
                className={`bbox-handle bbox-handle-${handle}`}
                aria-label={`调整${element.label}实例 ${index + 1} 边框 ${handle}`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  const start = imagePoint(event, true);
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setGesture({ type: 'abstract-instance-resize', id: element.id, index, handle, startX: start.x, startY: start.y, initial: { ...region }, overlay: true });
                }}
              />
            ))}
          </div>
        );
      })}
      {edgeElements.map((element) => {
        const selected = element.id === selectedId;
        return (
          <div
            key={`${element.id}-edge`}
            className={`bbox bbox-${element.reviewStatus} bbox-edge ${element.childrenIds.length > 0 ? 'bbox-container' : ''} ${selected ? 'bbox-selected' : ''}`}
            style={fixedRegionStyle(boxForElement(element))}
            onPointerDown={(event) => beginElementGesture(event, element.id)}
            title={`${element.label} · ${reviewStatusLabels[element.reviewStatus]}`}
          >
            <span className="bbox-label">{element.label}</span>
            <span className="bbox-center" />
          {selected && ['nw', 'ne', 'sw', 'se'].map((handle) => (
              <button
                key={handle}
                type="button"
                className={`bbox-handle bbox-handle-${handle}`}
                aria-label={`调整边框 ${handle}`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  const start = imagePoint(event, true);
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setGesture({ type: 'resize', id: element.id, handle, startX: start.x, startY: start.y, initial: { ...element.bbox }, overlay: true });
                }}
              />
            ))}
          </div>
        );
      })}
      {fixedInstances.map(({ element, region, index }) => {
        const box = boxForAbstractInstance(element, index, region);
        const selected = element.id === selectedId && (selectedAbstractInstanceIndex === index || selectedAbstractInstanceIndex === null);
        return (
          <div
            key={`${element.id}-fixed-instance-${index}`}
            className={`bbox bbox-abstract bbox-abstract-instance bbox-fixed-instance ${selected ? 'bbox-abstract-instance-selected' : ''}`}
            style={fixedRegionStyle(box)}
            title={`${element.label} · 固定实例`}
            aria-label={`${element.label} 固定实例 bbox`}
            onPointerDown={(event) => {
              if (drawing || !stageRef.current) return;
              event.stopPropagation();
              const result = selectElementAtPointer(event, element.id, element.id);
              if (!result) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              onSelectAbstractInstance(index);
              setGesture({ type: 'abstract-instance-move', id: element.id, index, startX: result.start.x, startY: result.start.y, initial: { ...region }, overlay: true });
            }}
          >
            <span className="bbox-label">{element.label} · 实例 {index + 1}</span>
            <span className="bbox-center" />
            {selected && selectedAbstractInstanceIndex === index && ['nw', 'ne', 'sw', 'se'].map((handle) => (
              <button
                key={handle}
                type="button"
                className={`bbox-handle bbox-handle-${handle}`}
                aria-label={`调整${element.label}实例 ${index + 1} 边框 ${handle}`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  const start = imagePoint(event, true);
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setGesture({ type: 'abstract-instance-resize', id: element.id, index, handle, startX: start.x, startY: start.y, initial: { ...region }, overlay: true });
                }}
              />
            ))}
          </div>
        );
      })}
      {overlayElements.filter((element) => !element.abstraction || element.abstraction.instanceRegions.length === 0).map((element) => {
        const selected = element.id === selectedId;
        return (
          <div
            key={`${element.id}-overlay`}
            className={`bbox bbox-${element.reviewStatus} bbox-fixed-overlay ${element.childrenIds.length > 0 ? 'bbox-container' : ''} ${selected ? 'bbox-selected' : ''}`}
            style={fixedRegionStyle(boxForElement(element))}
            onPointerDown={(event) => {
              beginElementGesture(event, element.id);
            }}
            title={`${element.label} · ${reviewStatusLabels[element.reviewStatus]}`}
          >
            <span className="bbox-label">{element.label}</span>
            <span className="bbox-center" />
            {selected && ['nw', 'ne', 'sw', 'se'].map((handle) => (
              <button
                key={handle}
                type="button"
                className={`bbox-handle bbox-handle-${handle}`}
                aria-label={`调整边框 ${handle}`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  if (!stageRef.current) return;
                  const start = imagePoint(event, true);
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setGesture({ type: 'resize', id: element.id, handle, startX: start.x, startY: start.y, initial: { ...element.bbox }, overlay: true });
                }}
              />
            ))}
          </div>
        );
      })}
      {selectedElementIsOverlay && selectedElement?.abstraction?.fields.find((field) => field.key === selectedAbstractFieldKey)?.instanceRegions.map((region, index) => {
        if (!region || !selectedElement || !selectedAbstractFieldKey) return null;
        const field = selectedElement.abstraction?.fields.find((candidate) => candidate.key === selectedAbstractFieldKey);
        const selected = selectedAbstractFieldInstanceIndex === index;
        return (
          <div
            key={`${selectedElement.id}-edge-field-${selectedAbstractFieldKey}-${index}`}
            className={`bbox-abstract-field-instance bbox-fixed-field ${selected ? 'bbox-abstract-field-instance-selected' : ''}`}
            style={fixedRegionStyle(boxForAbstractField(selectedElement, selectedAbstractFieldKey, index, region))}
            title={`${field?.label || '共相字段'} · 第 ${index + 1} 项实例`}
            aria-label={`${field?.label || '共相字段'} 第 ${index + 1} 项实例 bbox`}
                onPointerDown={(event) => {
                  if (drawing || !stageRef.current || !field) return;
                  event.stopPropagation();
                  const start = imagePoint(event, true);
                  event.currentTarget.setPointerCapture(event.pointerId);
              onSelectAbstractInstance(null);
              onSelectAbstractFieldInstance(index);
              setGesture({ type: 'abstract-move', id: selectedElement.id, fieldKey: field.key, index, startX: start.x, startY: start.y, initial: { ...region }, overlay: true });
            }}
          >
            <span className="bbox-label">{field?.label || '共相字段'} · 实例 {index + 1}</span>
            <span className="bbox-center" />
            {selected && field && ['nw', 'ne', 'sw', 'se'].map((handle) => (
              <button
                key={handle}
                type="button"
                className={`bbox-handle bbox-handle-${handle}`}
                aria-label={`调整${field.label}实例 ${index + 1} 边框 ${handle}`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  const start = imagePoint(event, true);
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setGesture({ type: 'abstract-resize', id: selectedElement.id, fieldKey: field.key, index, handle, startX: start.x, startY: start.y, initial: { ...region }, overlay: true });
                }}
              />
            ))}
          </div>
        );
      })}
    </div>
    </div>
  );
}
