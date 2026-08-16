import { useEffect, useState } from 'react';
import { Archive, CheckCircle2, CircleAlert, FileDiff, GitMerge, LoaderCircle, LockKeyhole, Rocket, RotateCcw, Trash2 } from 'lucide-react';
import type { StagingResult } from './types';

interface StagingPanelProps {
  versions: StagingResult[];
  staging: StagingResult | null;
  busy: string | null;
  dirty: boolean;
  onPrepare: () => void;
  onSelect: (version: StagingResult) => void;
  onMerge: (stageIds: string[]) => void;
  onPublish: (stageId: string) => void;
  onDelete: (stageId: string) => void;
  onRollback: (stageId: string) => void;
  onArchive: (stageId: string) => void;
}

const statusLabels = { draft: '待发布', published: '已发布', archived: '已归档' } as const;
const operationLabels = { prepare: '草稿快照', merge: '合并版本', rollback: '回退版本' } as const;

function displayTime(value: string | null) {
  if (!value) return '';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export function StagingPanel({ versions, staging, busy, dirty, onPrepare, onSelect, onMerge, onPublish, onDelete, onRollback, onArchive }: StagingPanelProps) {
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const selectable = new Set(versions.filter((version) => version.status === 'draft' && !version.isStale).map((version) => version.stageId));
    setCheckedIds((current) => new Set([...current].filter((id) => selectable.has(id))));
  }, [versions]);

  const toggleChecked = (stageId: string) => {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (next.has(stageId)) next.delete(stageId);
      else next.add(stageId);
      return next;
    });
  };

  return (
    <main className="staging-workspace">
      <section className="staging-summary">
        <div><FileDiff size={18} /><div><strong>发布版本</strong><span>生成快照，合并变更，校验后发布；已发布版本可在归档前回退。</span></div></div>
        {dirty && <small>当前草稿有未保存修改</small>}
        <button type="button" className="button button-primary" disabled={dirty || busy === 'staging'} onClick={onPrepare}>{busy === 'staging' ? <LoaderCircle className="spin" size={15} /> : <FileDiff size={15} />}生成版本</button>
      </section>

      <div className="staging-layout">
        <aside className="staging-version-browser">
          <header>
            <div><strong>版本记录</strong><span>{versions.length}</span></div>
            <button type="button" className="button" disabled={checkedIds.size < 2 || busy === 'merge-staging'} onClick={() => onMerge([...checkedIds])}>{busy === 'merge-staging' ? <LoaderCircle className="spin" size={14} /> : <GitMerge size={14} />}合并 {checkedIds.size > 1 ? checkedIds.size : ''}</button>
          </header>
          <div className="staging-version-list">
            {versions.length === 0 && <div className="staging-version-empty"><FileDiff size={28} /><span>还没有发布版本</span></div>}
            {versions.map((version) => (
              <article key={version.stageId} className={`staging-version-card ${staging?.stageId === version.stageId ? 'selected' : ''}`} onClick={() => onSelect(version)} onKeyDown={(event) => { if (event.key === 'Enter') onSelect(version); }} role="button" tabIndex={0}>
                <div className="staging-version-heading">
                  {version.status === 'draft' && !version.isStale ? <input type="checkbox" aria-label="选择合并版本" checked={checkedIds.has(version.stageId)} onClick={(event) => event.stopPropagation()} onChange={() => toggleChecked(version.stageId)} /> : <span className="staging-version-check-placeholder" />}
                  <div><strong>{version.graphRevision}</strong><span>{operationLabels[version.operation] || '版本快照'} · Draft r{version.draftRevision}</span></div>
                  <i className={`version-status version-status-${version.isStale ? 'stale' : version.status}`}>{version.isStale ? '基线过期' : version.isCurrent ? '当前发布' : statusLabels[version.status]}</i>
                </div>
                <div className="staging-version-meta">
                  <span>{displayTime(version.publishedAt || version.createdAt)}</span>
                  <span>{version.counts.pages} Page</span><span>{version.counts.elements} Element</span><span>{version.diff.length} 变更</span>
                </div>
                {version.sourceStageIds.length > 0 && <div className="staging-version-source">来源 {version.sourceStageIds.length} 个版本</div>}
                <div className="staging-version-actions" onClick={(event) => event.stopPropagation()}>
                  {version.status === 'draft' && <>
                    <button type="button" className="icon-button" title={version.isStale ? '活动图谱已变化，请重新生成版本' : '发布版本'} disabled={version.isStale || !version.validation.valid || dirty || busy !== null} onClick={() => onPublish(version.stageId)}><Rocket size={14} /></button>
                    <button type="button" className="icon-button danger-icon-button" title="删除版本" disabled={busy !== null} onClick={() => onDelete(version.stageId)}><Trash2 size={14} /></button>
                  </>}
                  {version.status === 'published' && <>
                    <button type="button" className="icon-button" title="回退到此版本" disabled={dirty || busy !== null} onClick={() => onRollback(version.stageId)}><RotateCcw size={14} /></button>
                    <button type="button" className="icon-button" title="永久归档版本" disabled={busy !== null} onClick={() => onArchive(version.stageId)}><Archive size={14} /></button>
                  </>}
                  {version.status === 'archived' && <span className="archived-lock"><LockKeyhole size={13} />不可回退</span>}
                </div>
              </article>
            ))}
          </div>
        </aside>

        {!staging ? <div className="staging-empty"><FileDiff size={38} /><strong>选择或生成一个版本</strong></div> : (
          <section className="staging-detail">
            <section className="staging-validation">
              <div className={staging.validation.valid ? 'valid' : 'invalid'}>{staging.validation.valid ? <CheckCircle2 size={20} /> : <CircleAlert size={20} />}<div><strong>{staging.validation.valid ? '校验通过' : '存在发布阻断项'}</strong><span>{staging.validation.schemaChecks} 项 Schema · {staging.validation.graphChecks} 项图级校验</span></div></div>
              <dl><dt>Stage</dt><dd>{staging.stageId}</dd><dt>状态</dt><dd>{statusLabels[staging.status]}</dd><dt>Draft revision</dt><dd>{staging.draftRevision}</dd><dt>Graph revision</dt><dd>{staging.graphRevision}</dd><dt>实体统计</dt><dd>{staging.counts.pages} Page / {staging.counts.elements} Element / {staging.counts.transitions} Transition</dd></dl>
              {staging.validation.errors.map((error) => <p key={error} className="staging-error"><CircleAlert size={14} />{error}</p>)}
              {staging.validation.warnings.map((warning) => <p key={warning} className="staging-warning">{warning}</p>)}
            </section>
            <section className="diff-list">
              <div className="diff-title"><strong>语义 Diff</strong><span>{staging.diff.length} 项变更</span></div>
              {staging.diff.map((item) => <article key={`${item.entityType}-${item.path}`}><i className={`diff-${item.change}`}>{item.change === 'add' ? '新增' : '更新'}</i><div><strong>{item.label}</strong><span>{item.entityType} · {item.summary}</span><code>{item.path}</code></div></article>)}
            </section>
          </section>
        )}
      </div>
    </main>
  );
}
