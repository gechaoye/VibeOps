import { History } from 'lucide-react';
import type { ElementActivityRecord } from './types';

const fieldLabels: Record<string, string> = {
  added: '新增元素',
  removed: '删除元素',
  label: '元素名称',
  elementType: '元素类型',
  visualDescription: '元素描述',
  displayCondition: '展示条件',
  capabilities: '元素动作',
  actionEffects: '动作效果',
  state: '当前状态',
  parentId: '父级元素',
  ownerKind: '所属范围',
  ownerRef: '归属引用',
  pageId: '所属页面',
  availableOnPageIds: '共享页面',
  interactionBoundary: '交互区域',
  bbox: '边框位置',
  gridColumns: '横向分割块数',
  gridRows: '纵向分割块数',
  gridRegion: '宫格区域编号',
  reviewStatus: '审核状态',
  source: '信息来源',
  childrenIds: '子元素关系',
};

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value));
}

export function EditHistoryPanel({ records, onSelectElement }: { records: ElementActivityRecord[]; onSelectElement: (id: string) => void }) {
  if (records.length === 0) {
    return <div className="edit-history-empty"><History size={28} /><strong>暂无编辑记录</strong><span>元素修改、恢复和撤销操作会显示在这里</span></div>;
  }
  return (
    <div className="edit-history-list">
      {records.map((record) => (
        <button key={record.id} type="button" className="edit-history-item" disabled={record.elementIds.length === 0} onClick={() => record.elementIds[0] && onSelectElement(record.elementIds[0])}>
          <span className="edit-history-marker"><History size={13} /></span>
          <span className="edit-history-content">
            <span className="edit-history-heading"><strong>{record.action}</strong><time>{formatTime(record.createdAt)}</time></span>
            <span className="edit-history-elements">{record.elementLabels.join('、') || '元素集合'}</span>
            <span className="edit-history-fields">{record.fields.map((field) => fieldLabels[field] || field).join(' · ')}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
