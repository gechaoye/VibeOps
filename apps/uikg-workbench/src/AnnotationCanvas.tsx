import { useEffect, useMemo, useRef, useState } from 'react';
import { clampBox, reviewStatusLabels } from './model';
import type { BBox, DraftElement } from './types';

interface AnnotationCanvasProps {
  imageUrl: string;
  elements: DraftElement[];
  selectedId: string | null;
  selectedAbstractFieldKey: string | null;
  drawing: boolean;
  showRejected: boolean;
  showGridGuides: boolean;
  onSelect: (id: string | null) => void;
  onSelectAbstractField: (fieldKey: string | null) => void;
  onAdd: (box: BBox) => void;
  onBoxChange: (id: string, box: BBox) => void;
  onBoxChangeEnd: () => void;
}

type Gesture =
  | { type: 'draw'; startX: number; startY: number; currentX: number; currentY: number }
  | { type: 'move'; id: string; startX: number; startY: number; initial: BBox }
  | { type: 'resize'; id: string; handle: string; startX: number; startY: number; initial: BBox };

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

export function AnnotationCanvas({ imageUrl, elements, selectedId, selectedAbstractFieldKey, drawing, showRejected, showGridGuides, onSelect, onSelectAbstractField, onAdd, onBoxChange, onBoxChangeEnd }: AnnotationCanvasProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [availableSize, setAvailableSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const container = stageRef.current?.parentElement;
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

  const fittedSize = useMemo(() => {
    if (!imageSize.width || !imageSize.height || !availableSize.width || !availableSize.height) return null;
    const scale = Math.min(availableSize.width / imageSize.width, availableSize.height / imageSize.height);
    return {
      width: imageSize.width * scale,
      height: imageSize.height * scale,
    };
  }, [availableSize, imageSize]);

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
    } else {
      onBoxChange(gesture.id, resizedBox(gesture.initial, gesture.handle, dx, dy));
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
  // Abstract templates are represented by their instance regions; their inherited
  // parent/list bbox must never become a single selection rectangle.
  const renderedElements = [...visibleElements.filter((element) => !element.abstraction || element.abstraction.instanceRegions.length === 0)]
    .sort((left, right) => Number(left.id === selectedId) - Number(right.id === selectedId));
  const selectedElement = visibleElements.find((element) => element.id === selectedId) || null;
  const selectedInheritsListRegion = Boolean(selectedElement?.abstraction?.kind === 'repeated-template' && visibleElements.some((candidate) => candidate.id === selectedElement.parentId && ['list', 'grouped-list', 'swipe-list', 'expandable-list'].includes(candidate.elementType)));

  return (
    <div
      ref={stageRef}
      className={`annotation-stage ${drawing ? 'annotation-stage-drawing' : ''}`}
      style={fittedSize || undefined}
      onPointerDown={(event) => {
        const isBackground = event.target === event.currentTarget || event.target instanceof HTMLImageElement;
        if (!stageRef.current || !isBackground) return;
        if (!drawing) {
          onSelect(null);
          onSelectAbstractField(null);
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
      {visibleElements.flatMap((element) => element.abstraction?.instanceRegions.map((region, index) => ({ element, region, index })) || []).map(({ element, region, index }) => (
        <div
          key={`${element.id}-instance-${index}`}
          className={`bbox bbox-abstract bbox-abstract-instance ${element.id === selectedId ? 'bbox-abstract-instance-selected' : ''}`}
          style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }}
          title={`${element.label} · 第 ${index + 1} 项实例`}
          onPointerDown={(event) => { event.stopPropagation(); onSelect(element.id); onSelectAbstractField(null); }}
        />
      ))}
      {selectedElement?.abstraction?.fields.find((field) => field.key === selectedAbstractFieldKey)?.instanceRegions.map((region, index) => {
        const field = selectedElement.abstraction?.fields.find((candidate) => candidate.key === selectedAbstractFieldKey);
        return (
          <div
            key={`${selectedElement.id}-field-${selectedAbstractFieldKey}-${index}`}
            className="bbox-abstract-field-instance"
            style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }}
            title={`${field?.label || '共相字段'} · 第 ${index + 1} 项实例`}
            aria-label={`${field?.label || '共相字段'} 第 ${index + 1} 项实例 bbox`}
          />
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
              const hit = elementAtPoint(visibleElements, selectedId, start.x, start.y);
              if (!hit) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              onSelect(hit.id);
              onSelectAbstractField(null);
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
  );
}
