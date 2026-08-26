import { Monitor, Plus, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface FrameStripProps {
  frameIds: string[];
  currentFrameId: string | null;
  frameUrlFor: (frameId: string) => string;
  busy?: boolean;
  deviceConnected?: boolean;
  onSelectFrame: (frameId: string) => void;
  onDeleteFrame: (frameId: string) => void;
  onAddFromDevice: () => void;
  onAddFromUpload: () => void;
}

export function FrameStrip({
  frameIds,
  currentFrameId,
  frameUrlFor,
  busy = false,
  deviceConnected = true,
  onSelectFrame,
  onDeleteFrame,
  onAddFromDevice,
  onAddFromUpload,
}: FrameStripProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointer = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [menuOpen]);

  const canDelete = frameIds.length > 1;

  return (
    <div className="frame-strip" role="list" aria-label="页面观测帧列表">
      {frameIds.map((frameId, index) => {
        const active = frameId === currentFrameId;
        return (
          <div
            key={frameId}
            role="listitem"
            className={`frame-strip-item${active ? ' is-active' : ''}`}
          >
            <button
              type="button"
              className="frame-strip-thumb"
              aria-pressed={active}
              aria-label={`观测帧 ${index + 1}${active ? '（当前）' : ''}`}
              onClick={() => onSelectFrame(frameId)}
            >
              <img src={frameUrlFor(frameId)} alt={`观测帧 ${index + 1} 缩略图`} loading="lazy" />
              <span className="frame-strip-index">{index + 1}</span>
            </button>
            {canDelete && (
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
      })}
      <div className="frame-strip-add" ref={menuRef}>
        <button
          type="button"
          className="frame-strip-add-button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="添加观测帧"
          disabled={busy}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Plus size={18} />
          <span>加帧</span>
        </button>
        {menuOpen && (
          <div className="frame-strip-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              disabled={busy || !deviceConnected}
              title={deviceConnected ? undefined : '设备未连接，无法冻结画面'}
              onClick={() => { setMenuOpen(false); onAddFromDevice(); }}
            >
              <Monitor size={15} />冻结设备画面
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => { setMenuOpen(false); onAddFromUpload(); }}
            >
              <Upload size={15} />上传图片
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
