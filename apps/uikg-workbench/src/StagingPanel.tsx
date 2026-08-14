import { CheckCircle2, CircleAlert, FileDiff, LoaderCircle, Rocket } from 'lucide-react';
import type { StagingResult } from './types';

interface StagingPanelProps {
  staging: StagingResult | null;
  busy: string | null;
  dirty: boolean;
  onPrepare: () => void;
  onPublish: () => void;
}

export function StagingPanel({ staging, busy, dirty, onPrepare, onPublish }: StagingPanelProps) {
  return (
    <main className="staging-workspace">
      <section className="staging-summary">
        <div><FileDiff size={18} /><div><strong>Staging Diff</strong><span>先生成独立 staging，校验通过后再显式发布到活动图谱。</span></div></div>
        <button type="button" className="button button-primary" disabled={dirty || busy === 'staging'} onClick={onPrepare}>{busy === 'staging' ? <LoaderCircle className="spin" size={15} /> : <FileDiff size={15} />}生成 staging Diff</button>
        {dirty && <small>请先保存草稿，确保 Diff 对应明确的 Draft revision。</small>}
      </section>
      {!staging ? <div className="staging-empty"><FileDiff size={38} /><strong>尚未生成 staging</strong><span>活动图谱不会因编辑 Draft 或生成 Diff 自动变化。</span></div> : (
        <div className="staging-content">
          <section className="staging-validation">
            <div className={staging.validation.valid ? 'valid' : 'invalid'}>{staging.validation.valid ? <CheckCircle2 size={20} /> : <CircleAlert size={20} />}<div><strong>{staging.validation.valid ? '校验通过' : '存在发布阻断项'}</strong><span>{staging.validation.schemaChecks} 项 Schema · {staging.validation.graphChecks} 项图级校验</span></div></div>
            <dl><dt>Stage</dt><dd>{staging.stageId}</dd><dt>Draft revision</dt><dd>{staging.draftRevision}</dd><dt>Graph revision</dt><dd>{staging.graphRevision}</dd><dt>实体统计</dt><dd>{staging.counts.pages} Page / {staging.counts.elements} Element / {staging.counts.transitions} Transition</dd></dl>
            {staging.validation.errors.map((error) => <p key={error} className="staging-error"><CircleAlert size={14} />{error}</p>)}
            {staging.validation.warnings.map((warning) => <p key={warning} className="staging-warning">{warning}</p>)}
            <button type="button" className="button publish-button" disabled={!staging.validation.valid || dirty || busy === 'publish'} onClick={onPublish}>{busy === 'publish' ? <LoaderCircle className="spin" size={15} /> : <Rocket size={15} />}发布到活动图谱</button>
          </section>
          <section className="diff-list">
            <div className="diff-title"><strong>语义 Diff</strong><span>{staging.diff.length} 项变更</span></div>
            {staging.diff.map((item) => <article key={`${item.entityType}-${item.path}`}><i className={`diff-${item.change}`}>{item.change === 'add' ? '新增' : '更新'}</i><div><strong>{item.label}</strong><span>{item.entityType} · {item.summary}</span><code>{item.path}</code></div></article>)}
          </section>
        </div>
      )}
    </main>
  );
}
