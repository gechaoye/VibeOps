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
  selectedAbstractFieldKey: string | null;
  selectedAbstractFieldInstanceIndex: number | null;
  drawing: boolean;
  showRejected: boolean;
  showGridGuides: boolean;
  onSelect: (id: string | null) => void;
  onSelectAbstractField: (fieldKey: string | null) => void;
  onSelectAbstractFieldInstance: (index: number | null) => void;
  onAdd: (box: BBox) => void;
  onBoxChange: (id: string, box: BBox) => void;
  onAbstractFieldBoxChange: (id: string, fieldKey: string, index: number, box: BBox) => void;
  onBoxChangeEnd: () => void;
}

type Gesture =
  | { type: 'draw'; startX: number; startY: number; currentX: number; currentY: number }
  | { type: 'move'; id: string; startX: number; startY: number; initial: BBox }
  | { type: 'resize'; id: string; handle: string; startX: number; startY: number; initial: BBox }
  | { type: 'abstract-move'; id: string; fieldKey: string; index: number; startX: number; startY: number; initial: BBox }
  | { type: 'abstract-resize'; id: string; fieldKey: string; index: number; handle: string; startX: number; startY: number; initial: BBox };

function point(event: React.PointerEvent, target: HTMLElement) {
  const rect = target.getBoundingClientRect();
  return {
    x: Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1),
    y: Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1),
  };
}

function resizedBox(initial: BBox, handle: string, dx: number, dy: number): BBox {
  let { x, y, width, height } = initial;
  if (handle.includes('w')) { x += dx; width -= dx; }
  if (handle.includes('e')) width += dx;
  if (handle.includes('n')) { y += dy; height -= dy; }
  if (handle.includes('s')) height += dy;
  return clampBox({ x, y, width, height });
}

function elementAtPoint(elements: DraftElement[], selectedId: string | null, x: number, y: number) {
  const hits = elements
    .filter((element) => x >= element.bbox.x && x <= element.bbox.x + element.bbox.width && y >= element.bbox.y && y <= element.bbox.y + element.bbox.height)
    .sort((left, right) => left.bbox.width * left.bbox.height - right.bbox.width * right.bbox.height);
  if (hits.length === 0) return null;
  const selectedIndex = hits.findIndex((element) => element.id === selectedId);
  return hits[(selectedIndex + 1) % hits.length];
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

export function AnnotationCanvas({ imageUrl, deviceViewport, runtimeStructure, useDeviceViewport, elements, selectedId, selectedAbstractFieldKey, selectedAbstractFieldInstanceIndex, drawing, showRejected, showGridGuides, onSelect, onSelectAbstractField, onSelectAbstractFieldInstance, onAdd, onBoxChange, onAbstractFieldBoxChange, onBoxChangeEnd }: AnnotationCanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollLayerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [availableSize, setAvailableSize] = useState({ width: 0, height: 0 });

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
    const current = point(event, stageRef.current);
    if (gesture.type === 'draw') {
      setGesture({ ...gesture, currentX: current.x, currentY: current.y });
      return;
    }
    const dx = current.x - gesture.startX;
    const dy = current.y - gesture.startY;
    if (gesture.type === 'move') {
      onBoxChange(gesture.id, clampBox({ ...gesture.initial, x: gesture.initial.x + dx, y: gesture.initial.y + dy }));
    } else if (gesture.type === 'resize') {
      onBoxChange(gesture.id, resizedBox(gesture.initial, gesture.handle, dx, dy));
    } else if (gesture.type === 'abstract-move') {
      onAbstractFieldBoxChange(gesture.id, gesture.fieldKey, gesture.index, clampBox({ ...gesture.initial, x: gesture.initial.x + dx, y: gesture.initial.y + dy }));
    } else {
      onAbstractFieldBoxChange(gesture.id, gesture.fieldKey, gesture.index, resizedBox(gesture.initial, gesture.handle, dx, dy));
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
      onBoxChangeEnd();
    }
    setGesture(null);
  };

  const onPointerCancel = () => {
    if (gesture && gesture.type !== 'draw') onBoxChangeEnd();
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
  const visibleElements = elements.filter((element) => showRejected || element.reviewStatus !== 'rejected');
  const fixedBoxes = runtimeFixedBoxes(runtimeStructure, imageSize.width, imageSize.height);
  const isElementFixed = (element: DraftElement) => {
    // Once a runtime hierarchy is available it is authoritative. This also
    // prevents stale fixed-position flags from an older recognition result
    // from pinning scrollable meeting-mode/settings content.
    const explicitlyFixed = element.riskSignals?.includes('fixed-position');
    if (!fixedBoxes) return explicitlyFixed;
    const regions = (element.abstraction?.instanceRegions?.length
      ? element.abstraction.instanceRegions
      : [element.bbox]).filter(Boolean);
    return regions.length > 0 && regions.every((region) => fixedBoxes.some((box) => regionsRepresentSameElement(region, box)));
  };
  const fixedElements = visibleElements.filter(isElementFixed);
  const scrollingElements = visibleElements.filter((element) => !isElementFixed(element));
  // Abstract templates are represented by their instance regions; their inherited
  // parent/list bbox must never become a single selection rectangle.
  const renderedElements = [...scrollingElements.filter((element) => !element.abstraction || element.abstraction.instanceRegions.length === 0)]
    .sort((left, right) => Number(left.id === selectedId) - Number(right.id === selectedId));
  const selectedElement = visibleElements.find((element) => element.id === selectedId) || null;
  const selectedInheritsListRegion = Boolean(selectedElement?.abstraction?.kind === 'repeated-template' && visibleElements.some((candidate) => candidate.id === selectedElement.parentId && ['list', 'grouped-list', 'swipe-list', 'expandable-list'].includes(candidate.elementType)));
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
  const fixedInstances = fixedElements.flatMap((element) => (
    element.abstraction?.instanceRegions
      ?.map((region, index) => ({ element, region, index })) || []
  )).filter(({ region }) => {
    if (!layout || !imageSize.height) return false;
    const scale = layout.stage.width / imageSize.width;
    const top = region.y * imageSize.height * scale;
    const bottom = (region.y + region.height) * imageSize.height * scale;
    return bottom > 0 && top < layout.viewport.height;
  });
  return (
    <div
      ref={viewportRef}
      className={`annotation-canvas-viewport ${layout?.viewportMode ? 'annotation-device-viewport' : ''}`}
      style={layout?.viewport}
      data-long-page={layout?.isLongPage ? 'true' : 'false'}
      data-viewport-mask={layout?.viewportMode ? 'true' : 'false'}
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
            onSelectAbstractField(null);
            onSelectAbstractFieldInstance(null);
            return;
          }
          const start = point(event, stageRef.current);
          event.currentTarget.setPointerCapture(event.pointerId);
          setGesture({ type: 'draw', startX: start.x, startY: start.y, currentX: start.x, currentY: start.y });
          onSelect(null);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
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
      {scrollingElements.flatMap((element) => element.abstraction?.instanceRegions.map((region, index) => ({ element, region, index })) || []).map(({ element, region, index }) => (
        <div
          key={`${element.id}-instance-${index}`}
          className={`bbox bbox-abstract bbox-abstract-instance ${element.id === selectedId ? 'bbox-abstract-instance-selected' : ''}`}
          style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }}
          title={`${element.label} · 第 ${index + 1} 项实例`}
          onPointerDown={(event) => { event.stopPropagation(); onSelect(element.id); onSelectAbstractField(null); }}
        />
      ))}
      {selectedElement?.abstraction?.fields.find((field) => field.key === selectedAbstractFieldKey)?.instanceRegions.map((region, index) => {
        if (!region) return null;
        const field = selectedElement.abstraction?.fields.find((candidate) => candidate.key === selectedAbstractFieldKey);
        const selected = selectedAbstractFieldInstanceIndex === index;
        return (
          <div
            key={`${selectedElement.id}-field-${selectedAbstractFieldKey}-${index}`}
            className={`bbox-abstract-field-instance ${selected ? 'bbox-abstract-field-instance-selected' : ''}`}
            style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }}
            title={`${field?.label || '共相字段'} · 第 ${index + 1} 项实例`}
            aria-label={`${field?.label || '共相字段'} 第 ${index + 1} 项实例 bbox`}
            onPointerDown={(event) => {
              if (drawing || !stageRef.current || !field) return;
              event.stopPropagation();
              const start = point(event, stageRef.current);
              event.currentTarget.setPointerCapture(event.pointerId);
              onSelectAbstractFieldInstance(index);
              setGesture({ type: 'abstract-move', id: selectedElement.id, fieldKey: field.key, index, startX: start.x, startY: start.y, initial: { ...region } });
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
                  setGesture({ type: 'abstract-resize', id: selectedElement.id, fieldKey: field.key, index, handle, startX: start.x, startY: start.y, initial: { ...region } });
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
            className={`bbox bbox-${element.reviewStatus} ${element.abstraction ? 'bbox-abstract' : ''} ${selected ? 'bbox-selected' : ''}`}
            style={{ left: `${element.bbox.x * 100}%`, top: `${element.bbox.y * 100}%`, width: `${element.bbox.width * 100}%`, height: `${element.bbox.height * 100}%` }}
            onPointerDown={(event) => {
              if (drawing) return;
              event.stopPropagation();
              if (!stageRef.current) return;
              const start = point(event, stageRef.current);
              const hit = elementAtPoint(scrollingElements, selectedId, start.x, start.y);
              if (!hit) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              onSelect(hit.id);
              onSelectAbstractField(null);
              onSelectAbstractFieldInstance(null);
              if (!hit.abstraction) {
                setGesture({ type: 'move', id: hit.id, startX: start.x, startY: start.y, initial: { ...hit.bbox } });
              }
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
                  setGesture({ type: 'resize', id: element.id, handle, startX: start.x, startY: start.y, initial: { ...element.bbox } });
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
      {fixedInstances.map(({ element, region, index }) => (
        <div key={`${element.id}-fixed-instance-${index}`} className={`bbox bbox-abstract bbox-abstract-instance ${element.id === selectedId ? 'bbox-abstract-instance-selected' : ''}`} style={fixedRegionStyle(region)} title={`${element.label} · 固定实例`} onPointerDown={(event) => { event.stopPropagation(); onSelect(element.id); onSelectAbstractField(null); }} />
      ))}
      {fixedElements.filter((element) => !element.abstraction || element.abstraction.instanceRegions.length === 0).map((element) => {
        const selected = element.id === selectedId;
        return <div key={`${element.id}-fixed`} className={`bbox bbox-${element.reviewStatus} ${selected ? 'bbox-selected' : ''}`} style={fixedRegionStyle(element.bbox)} title={`${element.label} · 固定元素`} onPointerDown={(event) => { event.stopPropagation(); onSelect(element.id); onSelectAbstractField(null); onSelectAbstractFieldInstance(null); }}><span className="bbox-label">{element.label}</span><span className="bbox-center" /></div>;
      })}
    </div>
    </div>
  );
}
