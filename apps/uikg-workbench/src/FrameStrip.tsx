import { Plus, Smartphone, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface FrameStripProps {
  frameIds: string[];
  currentFrameId: string | null;
  primaryFrameId?: string | null;
  recognizedFrameIds?: ReadonlySet<string>;
  frameUrlFor: (frameId: string) => string;
  busy?: boolean;
  deviceConnected?: boolean;
  readOnly?: boolean;
  onSelectFrame: (frameId: string) => void;
  onDeleteFrame: (frameId: string) => void;
  onSetPrimary?: (frameId: string) => void;
  onAddFromDevice: () => void;
  onAddFromUpload: () => void;
}

interface AddFrameButtonProps {
  busy?: boolean;
  deviceConnected?: boolean;
  placement?: 'above' | 'below';
  variant?: 'strip' | 'toolbar';
  onAddFromDevice: () => void;
  onAddFromUpload: () => void;
}

export function AddFrameButton({
  busy = false,
  deviceConnected = true,
  placement = 'above',
  variant = 'strip',
  onAddFromDevice,
  onAddFromUpload,
}: AddFrameButtonProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const updateMenuPosition = () => {
    const anchor = buttonRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setMenuPosition({ left: rect.left, top: placement === 'above' ? rect.top - 6 : rect.bottom + 6 });
  };

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (shellRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    updateMenuPosition();
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [menuOpen, placement]);

  return <div className={`add-frame-control add-frame-control-${variant}`} ref={shellRef}>
    <button
      ref={buttonRef}
      type="button"
      className={variant === 'strip' ? 'frame-strip-add-button' : 'button'}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      aria-label="添加观测帧"
      disabled={busy}
      onClick={() => {
        if (!menuOpen) updateMenuPosition();
        setMenuOpen((open) => !open);
      }}
    >
      <Plus size={variant === 'strip' ? 18 : 15} />
      <span>添加观测帧</span>
    </button>
    {menuOpen && menuPosition && <div
      className={`frame-strip-menu${placement === 'below' ? ' frame-strip-menu-below' : ''}`}
      ref={menuRef}
      role="menu"
      style={{ left: menuPosition.left, top: menuPosition.top }}
    >
      <button
        type="button"
        role="menuitem"
        disabled={busy || !deviceConnected}
        title={deviceConnected ? undefined : '设备未连接，无法使用设备帧'}
        onClick={() => { setMenuOpen(false); onAddFromDevice(); }}
      >
        <Smartphone size={15} />使用设备帧
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={busy}
        onClick={() => { setMenuOpen(false); onAddFromUpload(); }}
      >
        <Upload size={15} />上传图片
      </button>
    </div>}
  </div>;
}

export function FrameStrip({
  frameIds,
  currentFrameId,
  primaryFrameId,
  recognizedFrameIds,
  frameUrlFor,
  busy = false,
  deviceConnected = true,
  readOnly = false,
  onSelectFrame,
  onDeleteFrame,
  onSetPrimary,
  onAddFromDevice,
  onAddFromUpload,
}: FrameStripProps) {
  const [hoveredFrameId, setHoveredFrameId] = useState<string | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);

  const canDelete = frameIds.length > 1;
  const effectivePrimaryFrameId = primaryFrameId && frameIds.includes(primaryFrameId)
    ? primaryFrameId
    : frameIds[0] || null;
  const auxiliaryFrameIds = frameIds.filter((frameId) => frameId !== effectivePrimaryFrameId);

  const renderFrame = (frameId: string, primary: boolean) => {
    const index = frameIds.indexOf(frameId);
    const active = frameId === currentFrameId;
    const recognized = recognizedFrameIds?.has(frameId) || false;
    return (
      <div
        key={frameId}
        role="listitem"
        className={`frame-strip-item${active ? ' is-active' : ''}${primary ? ' is-primary' : ' is-auxiliary'}`}
        onMouseEnter={() => setHoveredFrameId(frameId)}
        onMouseLeave={() => setHoveredFrameId(null)}
      >
        <button
          type="button"
          className="frame-strip-thumb"
          aria-pressed={active}
          aria-label={`${primary ? '主帧' : '辅助帧'} ${index + 1}${active ? '（当前）' : ''}`}
          onClick={() => onSelectFrame(frameId)}
        >
          <img src={frameUrlFor(frameId)} alt={`观测帧 ${index + 1} 缩略图`} loading="lazy" />
          <span className="frame-strip-index">{index + 1}</span>
          {recognizedFrameIds && <span className={`frame-strip-annotation-status ${recognized ? 'is-recognized' : 'is-pending'}`}>{recognized ? '已标注' : '未标注'}</span>}
        </button>
        {!readOnly && !primary && onSetPrimary && (
          <button
            type="button"
            className="frame-strip-set-primary"
            disabled={busy}
            onClick={(event) => { event.stopPropagation(); onSetPrimary(frameId); }}
          >
            设为主帧
          </button>
        )}
        {!readOnly && canDelete && (
          <button
            type="button"
            className="frame-strip-delete"
            aria-label={`删除观测帧 ${index + 1}`}
            disabled={busy}
            onClick={() => onDeleteFrame(frameId)}
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className={`frame-strip-shell${readOnly ? ' frame-strip-shell-readonly' : ''}`} ref={shellRef}>
    <div className="frame-strip" role="list" aria-label="页面观测帧列表">
      {effectivePrimaryFrameId && <div className="frame-strip-group frame-strip-primary-group">
        <span className="frame-strip-group-label">主帧</span>
        {renderFrame(effectivePrimaryFrameId, true)}
      </div>}
      {auxiliaryFrameIds.length > 0 && <div className="frame-strip-group frame-strip-auxiliary-group">
        <span className="frame-strip-group-label">辅助帧</span>
        {auxiliaryFrameIds.map((frameId) => renderFrame(frameId, false))}
      </div>}
      {!readOnly && <div className="frame-strip-add"><AddFrameButton busy={busy} deviceConnected={deviceConnected} onAddFromDevice={onAddFromDevice} onAddFromUpload={onAddFromUpload} /></div>}
    </div>
    {!readOnly && hoveredFrameId && <div className="frame-strip-preview" role="tooltip"><img src={frameUrlFor(hoveredFrameId)} alt="悬浮预览观测帧" /><span>观测帧 {frameIds.indexOf(hoveredFrameId) + 1} 预览</span></div>}
    </div>
  );
}
