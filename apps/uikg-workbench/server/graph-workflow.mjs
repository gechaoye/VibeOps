import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { normalizeDraftShape } from './draft-model.mjs';

const execFileAsync = promisify(execFile);
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function stableHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function createUlid(now = Date.now()) {
  let timestamp = now;
  let prefix = '';
  for (let index = 0; index < 10; index += 1) {
    prefix = CROCKFORD[timestamp % 32] + prefix;
    timestamp = Math.floor(timestamp / 32);
  }
  let suffix = '';
  for (const byte of randomBytes(16)) suffix += CROCKFORD[byte % 32];
  return `${prefix}${suffix.slice(0, 16)}`;
}

function normalizePath(value) {
  return value.split(path.sep).join('/');
}

function safeSegment(value) {
  return String(value || '待归类').replace(/[\\/:*?"<>|]/g, '-').trim() || '待归类';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(root, predicate = () => true) {
  if (!(await exists(root))) return [];
  const output = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && predicate(target)) output.push(target);
    }
  }
  return output.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function yamlRecords(yaml, files) {
  const records = [];
  for (const file of files) {
    const value = yaml.load(readFileSync(file, 'utf8'));
    if (value && typeof value === 'object') records.push({ file, value });
  }
  return records;
}

function draftTransitionIssues(transition, draft) {
  const issues = [];
  const trigger = draft.elements.find((element) => element.id === transition.triggerElementId);
  if (!draft.pages.some((page) => page.id === transition.sourcePageId)) issues.push('来源 Page 不存在');
  if (!draft.pages.some((page) => page.id === transition.targetPageId)) issues.push('目标 Page 不存在');
  if (!trigger) issues.push('触发元素不存在');
  if (trigger && !trigger.capabilities.includes(transition.capability)) issues.push('触发元素不具备所选能力');
  if (!transition.evidence.beforeFrameId) issues.push('缺少 before Frame');
  if (!transition.evidence.locatorFrameId) issues.push('缺少 locator 所属 Frame');
  if (transition.evidence.locatorFrameId && transition.evidence.beforeFrameId !== transition.evidence.locatorFrameId) issues.push('locator 必须属于 before Frame');
  if (!transition.evidence.actionTraceRef.trim()) issues.push('缺少 action Trace');
  if (!transition.evidence.afterFrameId) issues.push('缺少 after Frame');
  if (transition.evidence.postcondition !== 'pass') issues.push('后置条件尚未通过');
  if (!transition.evidence.semanticAssertions.filter((item) => item.trim()).length) issues.push('缺少语义断言');
  return issues;
}

export { draftTransitionIssues };

export class GraphWorkflow {
  constructor({ graphRoot, workbenchRoot, dataRoot, spec, pythonBinary = null }) {
    this.graphRoot = graphRoot;
    this.workbenchRoot = workbenchRoot;
    this.dataRoot = dataRoot;
    this.spec = spec;
    this.stagingRoot = path.join(dataRoot, 'staging');
    this.backupRoot = path.join(dataRoot, 'publish-backups');
    const require = createRequire(import.meta.url);
    this.yaml = require(path.join(graphRoot, 'tools', 'vendor', 'js-yaml-4.1.1.js'));
    this.renderScript = path.join(workbenchRoot, 'server', 'render-redbox.py');
    const bundledPython = path.join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'bin', 'python3');
    this.pythonBinary = pythonBinary || process.env.UIKG_WORKBENCH_PYTHON || bundledPython;
  }

  async initialize() {
    await Promise.all([mkdir(this.stagingRoot, { recursive: true }), mkdir(this.backupRoot, { recursive: true })]);
    if (!(await exists(this.pythonBinary))) this.pythonBinary = 'python3';
  }

  normalizeStageMetadata(stage) {
    const explorationIds = Array.isArray(stage.explorationIds)
      ? stage.explorationIds
      : stage.explorationId ? [stage.explorationId] : [];
    return {
      ...stage,
      status: ['draft', 'published', 'archived'].includes(stage.status) ? stage.status : 'draft',
      operation: ['prepare', 'merge', 'rollback'].includes(stage.operation) ? stage.operation : 'prepare',
      sourceStageIds: Array.isArray(stage.sourceStageIds) ? stage.sourceStageIds : [],
      mergeConflicts: Array.isArray(stage.mergeConflicts) ? stage.mergeConflicts : [],
      explorationId: stage.explorationId || explorationIds[0] || null,
      explorationIds,
      publishedAt: stage.publishedAt || null,
      archivedAt: stage.archivedAt || null,
      updatedAt: stage.updatedAt || stage.createdAt,
    };
  }

  stageRoot(stageId) {
    if (!/^stage-[A-Za-z0-9-]+$/.test(stageId)) throw new Error('无效的 staging ID');
    return path.join(this.stagingRoot, stageId);
  }

  async saveStage(stage) {
    const normalized = this.normalizeStageMetadata(stage);
    const stageRoot = this.stageRoot(normalized.stageId);
    await mkdir(stageRoot, { recursive: true });
    const target = path.join(stageRoot, 'stage.json');
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    await rename(temporary, target);
    return normalized;
  }

  async listStages() {
    const entries = await readdir(this.stagingRoot, { withFileTypes: true });
    const stages = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && /^stage-[A-Za-z0-9-]+$/.test(entry.name))
      .map(async (entry) => {
        try {
          return await this.loadStage(entry.name);
        } catch {
          return null;
        }
      }));
    const manifests = new Map();
    const withActivity = await Promise.all(stages.filter(Boolean).map(async (stage) => {
      if (!manifests.has(stage.appKey)) {
        manifests.set(stage.appKey, readFile(path.join(this.graphRoot, 'apps', stage.appKey, 'manifest.yaml'), 'utf8')
          .then((content) => this.yaml.load(content))
          .catch(() => null));
      }
      const activeManifest = await manifests.get(stage.appKey);
      return {
        ...stage,
        isCurrent: Boolean(activeManifest && activeManifest.graphRevision === stage.graphRevision),
        isStale: Boolean(stage.status === 'draft' && activeManifest && activeManifest.rootHash !== stage.baseRootHash),
      };
    }));
    return withActivity.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }

  async loadFrameMetadata(frameId) {
    const digest = frameId.replace(/^sha256:/, '');
    return JSON.parse(await readFile(path.join(this.dataRoot, 'evidence', 'frames', `${digest}.json`), 'utf8'));
  }

  async sourceFramePath(frameId) {
    const metadata = await this.loadFrameMetadata(frameId);
    return { metadata, imagePath: metadata.imagePath };
  }

  async loadCanonicalIndex(appRoot) {
    const files = await listFiles(appRoot, (file) => /\.ya?ml$/i.test(file) && path.basename(file) !== 'manifest.yaml');
    const records = yamlRecords(this.yaml, files);
    const byType = new Map();
    const byKey = new Map();
    const byId = new Map();
    for (const record of records) {
      const type = record.value.entityType || record.value.recordType;
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push(record);
      if (record.value.key) byKey.set(record.value.key, record);
      if (record.value.id) byId.set(record.value.id, record);
    }
    return { records, byType, byKey, byId };
  }

  findExisting(index, type, key, label) {
    const exact = index.byKey.get(key);
    if (exact?.value.entityType === type) return exact;
    const matches = (index.byType.get(type) || []).filter((record) => record.value.label === label);
    return matches.length === 1 ? matches[0] : null;
  }

  async writeYaml(file, value) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, this.yaml.dump(value, { noRefs: true, lineWidth: 120, sortKeys: false }), 'utf8');
  }

  async copyEvidence(stageGraphRoot, stageId, draft, usedFrameIds) {
    const explorationId = `workbench-${stageId}`;
    const explorationRoot = path.join(stageGraphRoot, 'explorations', explorationId);
    const framesRoot = path.join(explorationRoot, 'frames');
    const modelRoot = path.join(explorationRoot, 'model-results');
    await Promise.all([mkdir(framesRoot, { recursive: true }), mkdir(modelRoot, { recursive: true })]);
    const frameAssets = new Map();
    for (const frameId of usedFrameIds) {
      const { metadata, imagePath } = await this.sourceFramePath(frameId);
      const digest = frameId.replace(/^sha256:/, '');
      const destination = path.join(framesRoot, `${digest}.${metadata.extension}`);
      await cp(imagePath, destination);
      await writeFile(path.join(framesRoot, `${digest}.json`), JSON.stringify({ ...metadata, imagePath: undefined }, null, 2));
      frameAssets.set(frameId, { metadata, source: imagePath, explorationRef: normalizePath(path.relative(stageGraphRoot, destination)) });
    }
    let rawModelResultRef = null;
    if (draft.rawModelResultRef) {
      const source = path.join(this.workbenchRoot, draft.rawModelResultRef);
      if (await exists(source)) {
        const destination = path.join(modelRoot, path.basename(source));
        await cp(source, destination);
        rawModelResultRef = normalizePath(path.relative(stageGraphRoot, destination));
      }
    }
    const now = new Date().toISOString();
    await this.writeYaml(path.join(explorationRoot, 'scope.yaml'), {
      schemaVersion: '3.0.0',
      recordType: 'WorkbenchExplorationScope',
      explorationId,
      appKey: draft.appKey,
      buildRef: draft.buildRef || 'unknown-build',
      status: 'human_reviewed_staging',
      normativeSpec: this.spec,
      recordedAt: now,
    });
    await this.writeYaml(path.join(explorationRoot, 'coverage.yaml'), {
      schemaVersion: '3.0.0',
      recordType: 'WorkbenchCoverage',
      status: 'incomplete',
      reviewedElements: draft.elements.filter((element) => ['accepted', 'edited'].includes(element.reviewStatus)).length,
      pendingElements: draft.elements.filter((element) => element.reviewStatus === 'pending').length,
      ignoredElements: draft.elements.filter((element) => element.reviewStatus === 'rejected').length,
      limitations: ['Workbench staging does not claim recursive exploration completion.'],
    });
    await writeFile(path.join(explorationRoot, 'report.md'), `# Workbench Staging ${stageId}\n\n- Spec: ${this.spec.version}\n- Draft revision: ${draft.revision}\n- Status: incomplete\n`, 'utf8');
    return { explorationId, explorationRoot, frameAssets, rawModelResultRef };
  }

  async makeFullPageAsset(obsidianRoot, frameId, frameAsset) {
    const destination = path.join(obsidianRoot, 'assets', 'full-pages', `${frameId}.png`);
    await mkdir(path.dirname(destination), { recursive: true });
    if (!(await exists(destination))) await execFileAsync(this.pythonBinary, [this.renderScript, frameAsset.source, destination]);
    return destination;
  }

  async makeRedboxAsset(obsidianRoot, canonicalId, frameId, frameAsset, bbox) {
    const width = frameAsset.metadata.width;
    const height = frameAsset.metadata.height;
    const rect = {
      left: bbox.x * width,
      top: bbox.y * height,
      width: bbox.width * width,
      height: bbox.height * height,
    };
    const destination = path.join(obsidianRoot, 'assets', 'element-redboxes', `${canonicalId}-${frameId}.png`);
    await execFileAsync(this.pythonBinary, [
      this.renderScript,
      frameAsset.source,
      destination,
      String(rect.left),
      String(rect.top),
      String(rect.width),
      String(rect.height),
    ]);
    return { rect, destination };
  }

  async updatePageCard(obsidianRoot, page) {
    const existing = await this.findCardById(obsidianRoot, page.id, '页面');
    const relative = existing || path.join('页面', ...page.featurePath.map(safeSegment), `${safeSegment(page.label)}.md`);
    const observations = page.observations.map((observation) => `### \`${observation.frameRef}\`\n\n![[assets/full-pages/${observation.frameRef}.png|640]]\n\n- 构建：\`${observation.buildRef}\`\n- 证据状态：\`${observation.evidenceStatus}\``).join('\n\n');
    const body = `---\ntype: page\nid: ${page.id}\nkey: ${page.key}\napplication: [[中通宝盒-知识图谱首页]]\nfeature_path: ${JSON.stringify(page.featurePath)}\nstatus: ${page.status}\n---\n\n# ${page.label}\n\n${page.summary}\n\n[[中通宝盒-知识图谱首页|返回知识图谱首页]]\n\n## 页面实例\n\n${observations}\n\n## 页面元素\n\n${page.elementRefs.map((ref) => `- Element \`${ref}\``).join('\n') || '- 暂无'}\n\n## 导航关系\n\n- 入边：${page.inboundTransitionRefs.length}\n- 出边：${page.outboundTransitionRefs.length}\n`;
    await mkdir(path.dirname(path.join(obsidianRoot, relative)), { recursive: true });
    await writeFile(path.join(obsidianRoot, relative), body, 'utf8');
    return normalizePath(relative);
  }

  async updateElementCard(obsidianRoot, element) {
    const existing = await this.findCardById(obsidianRoot, element.id, '元素');
    const relative = existing || path.join('元素', ...element.featurePath.map(safeSegment), `${safeSegment(element.label)}.md`);
    const observations = element.observations.map((observation) => `### \`${observation.frameRef}\`\n\n![[${observation.redboxRef}|640]]\n\n- rect: \`${JSON.stringify(observation.locator.rect)}\`\n- 几何状态：\`${observation.locator.status}\``).join('\n\n');
    const body = `---\ntype: element\nid: ${element.id}\nkey: ${element.key}\napplication: [[中通宝盒-知识图谱首页]]\nfeature_path: ${JSON.stringify(element.featurePath)}\nstatus: ${element.status}\n---\n\n# ${element.label}\n\n${element.summary}\n\n[[中通宝盒-知识图谱首页|返回知识图谱首页]]\n\n## 归属\n\n- owner: \`${element.owner.kind}:${element.owner.ref}\`\n- parent: \`${element.parentElementRef || '无'}\`\n- children: ${element.childElementRefs?.length || 0}\n\n## 动作与边界\n\n- 元素类型：\`${element.controlType}\`\n- 元素动作：${element.capabilities.join('、')}\n- 动作效果：${element.actionEffects.map((item) => `${item.action}=${item.effect}`).join('；')}\n- 可操作：${element.interactionBoundary.actionable ? '是' : '否'}\n\n## 信息来源\n\n- Model A 模型：\`${element.provenance.model || 'unknown'}\`\n- 原始证据：\`${element.observations.at(-1).rawEvidenceRef || '无'}\`\n\n## 元素实例\n\n${observations}\n`;
    await mkdir(path.dirname(path.join(obsidianRoot, relative)), { recursive: true });
    await writeFile(path.join(obsidianRoot, relative), body, 'utf8');
    return normalizePath(relative);
  }

  async findCardById(obsidianRoot, id, category) {
    const root = path.join(obsidianRoot, category);
    for (const file of await listFiles(root, (item) => item.endsWith('.md'))) {
      const content = await readFile(file, 'utf8');
      if (new RegExp(`^id:\\s*${id}$`, 'm').test(content)) return path.relative(obsidianRoot, file);
    }
    return null;
  }

  async materialize(stageGraphRoot, draft, stageId) {
    const appRoot = path.join(stageGraphRoot, 'apps', draft.appKey);
    const obsidianRoot = path.join(stageGraphRoot, 'obsidian', draft.appKey);
    const index = await this.loadCanonicalIndex(appRoot);
    const applicationRecord = (index.byType.get('Application') || [])[0];
    if (!applicationRecord) throw new Error(`活动图谱缺少 Application：${draft.appKey}`);
    const application = applicationRecord.value;
    const eligibleElements = draft.elements.filter((element) => ['accepted', 'edited'].includes(element.reviewStatus));
    const usedFrameIds = new Set(draft.pages.flatMap((page) => page.frameIds).filter(Boolean));
    for (const transition of draft.transitions) {
      if (transition.evidence.beforeFrameId) usedFrameIds.add(transition.evidence.beforeFrameId);
      if (transition.evidence.afterFrameId) usedFrameIds.add(transition.evidence.afterFrameId);
    }
    const evidence = await this.copyEvidence(stageGraphRoot, stageId, draft, usedFrameIds);
    for (const [frameId, frameAsset] of evidence.frameAssets) await this.makeFullPageAsset(obsidianRoot, frameId, frameAsset);

    const pageIdMap = new Map();
    const pageRecords = new Map();
    const outputPaths = new Map();
    for (const draftPage of draft.pages) {
      if (!draftPage.frameIds.length) continue;
      const existing = this.findExisting(index, 'Page', draftPage.key, draftPage.name);
      const id = existing?.value.id || createUlid();
      const key = existing?.value.key || draftPage.key;
      pageIdMap.set(draftPage.id, id);
      const lastFrameId = draftPage.frameIds.at(-1);
      const frameAsset = evidence.frameAssets.get(lastFrameId);
      const observation = {
        frameRef: lastFrameId,
        observedAt: frameAsset.metadata.capturedAt,
        buildRef: draft.buildRef || 'unknown-build',
        deviceRef: 'sha256:workbench-device-redacted',
        viewport: {
          width: frameAsset.metadata.width,
          height: frameAsset.metadata.height,
          orientation: frameAsset.metadata.height >= frameAsset.metadata.width ? 'portrait' : 'landscape',
        },
        stateProperties: { summary: draftPage.stateSummary },
        screenshotRef: frameAsset.explorationRef,
        rawEvidenceRef: normalizePath(path.join('explorations', evidence.explorationId)),
        evidenceStatus: 'worker_human_reviewed',
      };
      const page = {
        ...(existing?.value || {}),
        schemaVersion: '3.0.0',
        entityType: 'Page',
        id,
        key,
        label: draftPage.name,
        applicationRef: application.id,
        featurePath: draftPage.featurePath.slice(0, 3),
        surfaceType: draftPage.surfaceType || 'page',
        status: 'workbench_reviewed_incomplete',
        summary: draftPage.stateSummary || `${draftPage.name}页面`,
        states: unique([...(existing?.value.states || []).map((state) => state.key), 'default']).map((stateKey) => {
          const previous = existing?.value.states?.find((state) => state.key === stateKey);
          if (stateKey === 'default') {
            return {
              ...(previous || { key: 'default', summary: '默认状态' }),
              frameRefs: unique([...(previous?.frameRefs || []), lastFrameId]),
            };
          }
          return previous;
        }),
        elementRefs: [...(existing?.value.elementRefs || [])],
        inboundTransitionRefs: [...(existing?.value.inboundTransitionRefs || [])],
        outboundTransitionRefs: [...(existing?.value.outboundTransitionRefs || [])],
        inboundAuthorityContractRefs: [...(existing?.value.inboundAuthorityContractRefs || [])],
        outboundAuthorityContractRefs: [...(existing?.value.outboundAuthorityContractRefs || [])],
        observations: [...(existing?.value.observations || []).filter((item) => item.frameRef !== lastFrameId), observation],
        provenance: {
          sourceType: 'workbench_human_reviewed_worker',
          materializationSpec: normalizePath(path.join('explorations', evidence.explorationId, 'scope.yaml')),
          recordedAt: new Date().toISOString(),
          reviewedBy: 'workbench_user',
          limitations: ['Recursive exploration completion is not asserted by Workbench staging.'],
          model: draft.lastWorkerModel || null,
        },
      };
      pageRecords.set(draftPage.id, page);
      outputPaths.set(id, existing?.file || path.join(appRoot, 'pages', ...page.featurePath.map(safeSegment), `${page.key}.yaml`));
    }

    const elementIdMap = new Map();
    const elementRecords = new Map();
    for (const draftElement of eligibleElements) {
      const existing = this.findExisting(index, 'Element', draftElement.candidateKey, draftElement.label);
      elementIdMap.set(draftElement.id, existing?.value.id || createUlid());
    }
    for (const draftElement of eligibleElements) {
      const id = elementIdMap.get(draftElement.id);
      const existing = this.findExisting(index, 'Element', draftElement.candidateKey, draftElement.label);
      const parentId = draftElement.parentId ? elementIdMap.get(draftElement.parentId) || index.byId.get(draftElement.parentId)?.value.id : null;
      const pageId = draftElement.pageId ? pageIdMap.get(draftElement.pageId) : null;
      if (!parentId && draftElement.ownerKind !== 'application' && !pageId) continue;
      const ownerKind = parentId
        ? (draftElement.ownerKind === 'shared_component' ? 'shared_component' : 'component')
        : draftElement.ownerKind === 'application' ? 'application' : 'page';
      const ownerRef = parentId || (ownerKind === 'application' ? application.id : pageId);
      const draftPage = draft.pages.find((page) => page.id === draftElement.pageId);
      const featurePath = ownerKind === 'application' || ownerKind === 'shared_component'
        ? (existing?.value.featurePath || ['共享元素'])
        : (draftPage?.featurePath || ['待归类']).slice(0, 3);
      const frameId = draftPage?.frameIds.at(-1) || draft.currentFrameId;
      if (!frameId || !evidence.frameAssets.has(frameId)) continue;
      const frameAsset = evidence.frameAssets.get(frameId);
      const { rect, destination } = await this.makeRedboxAsset(obsidianRoot, id, frameId, frameAsset, draftElement.bbox);
      const redboxRelative = normalizePath(path.relative(obsidianRoot, destination));
      const actionable = draftElement.capabilities.some((capability) => capability !== 'none');
      const observation = {
        frameRef: frameId,
        observedAt: frameAsset.metadata.capturedAt,
        buildRef: draft.buildRef || 'unknown-build',
        deviceRef: 'sha256:workbench-device-redacted',
        viewport: {
          width: frameAsset.metadata.width,
          height: frameAsset.metadata.height,
          orientation: frameAsset.metadata.height >= frameAsset.metadata.width ? 'portrait' : 'landscape',
        },
        locator: {
          rect,
          center: [rect.left + rect.width / 2, rect.top + rect.height / 2],
          dpr: 1,
          status: draftElement.interactionBoundary === 'candidate_bbox' ? 'candidate_pending_boundary_acceptance' : 'human_reviewed_boundary',
          evidenceRef: normalizePath(path.join('explorations', evidence.explorationId)),
        },
        state: draftElement.state || 'visible',
        stateProperties: { enabled: draftElement.enabled, actionable },
        dynamicValue: draftElement.dynamicContent ? draftElement.label : null,
        screenshotRef: frameAsset.explorationRef,
        redboxRef: redboxRelative,
        actionTraceRef: null,
        rawEvidenceRef: evidence.rawModelResultRef,
        evidenceStatus: 'worker_human_reviewed',
      };
      const element = {
        ...(existing?.value || {}),
        schemaVersion: '3.0.0',
        entityType: 'Element',
        id,
        key: existing?.value.key || draftElement.candidateKey,
        label: draftElement.label,
        applicationRef: application.id,
        featurePath,
        owner: { kind: ownerKind, ref: ownerRef },
        parentElementRef: parentId,
        controlType: draftElement.controlType,
        role: draftElement.role,
        capabilities: [...draftElement.capabilities],
        actionEffects: [...draftElement.actionEffects],
        summary: draftElement.meaning.description || draftElement.visualDescription || draftElement.label,
        relationshipRefs: unique([
          ...(existing?.value.relationshipRefs || []).filter((ref) => !/^(owner|parent|child):/.test(ref)),
          `owner:${ownerRef}`,
          ...(parentId ? [`parent:${parentId}`] : []),
        ]),
        childElementRefs: [],
        observations: [...(existing?.value.observations || []).filter((item) => item.frameRef !== frameId), observation],
        coverage: 'human_reviewed',
        risk: draftElement.riskSignals.length ? 'medium' : 'low',
        status: 'workbench_reviewed_incomplete',
        interactionBoundary: {
          actionable,
          function: draftElement.interactionBoundary,
        },
        provenance: {
          sourceType: 'workbench_human_reviewed_worker',
          materializationSpec: normalizePath(path.join('explorations', evidence.explorationId, 'scope.yaml')),
          recordedAt: new Date().toISOString(),
          reviewedBy: 'workbench_user',
          limitations: draftElement.interactionBoundary === 'candidate_bbox' ? ['Model A bbox boundary acceptance is pending.'] : [],
          model: draftElement.workerModel || draft.lastWorkerModel || null,
        },
      };
      if (ownerKind === 'application') {
        element.availableOnPageRefs = unique([
          ...(existing?.value.availableOnPageRefs || []),
          ...draftElement.availableOnPageIds.map((pageIdValue) => pageIdMap.get(pageIdValue)),
        ]);
      }
      elementRecords.set(draftElement.id, { element, redboxRelative });
      outputPaths.set(id, existing?.file || path.join(appRoot, 'elements', ...featurePath.map(safeSegment), `${element.key}.yaml`));
    }

    for (const [draftId, entry] of elementRecords) {
      const children = eligibleElements.filter((item) => item.parentId === draftId && elementRecords.has(item.id));
      entry.element.childElementRefs = children.map((item) => elementRecords.get(item.id).element.id);
      entry.element.relationshipRefs = unique([
        ...entry.element.relationshipRefs.filter((ref) => !ref.startsWith('child:')),
        ...entry.element.childElementRefs.map((childId) => `child:${childId}`),
      ]);
      if (entry.element.owner.kind === 'page') {
        const draftPage = pageRecords.get(draft.elements.find((item) => item.id === draftId)?.pageId);
        if (draftPage) draftPage.elementRefs = unique([...draftPage.elementRefs, entry.element.id]);
      }
      if (entry.element.owner.kind === 'application') {
        for (const availablePageRef of entry.element.availableOnPageRefs || []) {
          const draftPageEntry = [...pageRecords.values()].find((page) => page.id === availablePageRef);
          if (draftPageEntry) draftPageEntry.elementRefs = unique([...draftPageEntry.elementRefs, entry.element.id]);
        }
      }
    }

    const transitionRecords = [];
    for (const draftTransition of draft.transitions) {
      const issues = draftTransitionIssues(draftTransition, draft);
      if (issues.length) continue;
      const sourceRef = pageIdMap.get(draftTransition.sourcePageId);
      const targetRef = pageIdMap.get(draftTransition.targetPageId);
      const triggerElementRef = elementIdMap.get(draftTransition.triggerElementId);
      if (!sourceRef || !targetRef || !triggerElementRef) continue;
      const existing = this.findExisting(index, 'Transition', draftTransition.key, null);
      const transition = {
        ...(existing?.value || {}),
        schemaVersion: '3.0.0',
        entityType: 'Transition',
        id: existing?.value.id || createUlid(),
        key: existing?.value.key || draftTransition.key,
        applicationRef: application.id,
        featurePath: pageRecords.get(draftTransition.sourcePageId)?.featurePath || ['待归类'],
        sourceRef,
        sourceStateKey: draftTransition.sourceStateKey || null,
        triggerElementRef,
        action: draftTransition.action,
        capability: draftTransition.capability,
        targetRef,
        targetStateKey: draftTransition.targetStateKey || null,
        reversible: draftTransition.reversible,
        risk: draftTransition.risk,
        verificationStatus: 'executed_verified',
        evidence: {
          actionTraceRef: draftTransition.evidence.actionTraceRef,
          beforeFrameRef: draftTransition.evidence.beforeFrameId,
          locatorFrameRef: draftTransition.evidence.locatorFrameId,
          afterFrameRef: draftTransition.evidence.afterFrameId,
          postcondition: 'pass',
          semanticAssertions: draftTransition.evidence.semanticAssertions.filter((item) => item.trim()),
        },
        provenance: {
          sourceType: 'verified_midscene_evidence',
          materializationSpec: normalizePath(path.join('explorations', evidence.explorationId, 'scope.yaml')),
          recordedAt: new Date().toISOString(),
          reviewedBy: 'workbench_user',
        },
      };
      transitionRecords.push(transition);
      outputPaths.set(transition.id, existing?.file || path.join(appRoot, 'transitions', ...transition.featurePath.map(safeSegment), `${transition.key}.yaml`));
      const trigger = [...elementRecords.values()].find((entry) => entry.element.id === triggerElementRef)?.element || index.byId.get(triggerElementRef)?.value;
      if (trigger) {
        trigger.relationshipRefs = unique([...(trigger.relationshipRefs || []), `transition:${transition.id}`]);
        const draftEntry = [...elementRecords.values()].find((entry) => entry.element.id === triggerElementRef);
        if (draftEntry) draftEntry.element = trigger;
      }
      const source = [...pageRecords.values()].find((page) => page.id === sourceRef);
      const target = [...pageRecords.values()].find((page) => page.id === targetRef);
      if (source) source.outboundTransitionRefs = unique([...source.outboundTransitionRefs, transition.id]);
      if (target) target.inboundTransitionRefs = unique([...target.inboundTransitionRefs, transition.id]);
    }

    const touched = [];
    for (const [draftPageIdValue, page] of pageRecords) {
      const file = outputPaths.get(page.id);
      await this.writeYaml(file, page);
      touched.push({ entityType: 'Page', key: page.key, label: page.label, path: file });
      await this.updatePageCard(obsidianRoot, page);
    }
    for (const { element } of elementRecords.values()) {
      const file = outputPaths.get(element.id);
      await this.writeYaml(file, element);
      touched.push({ entityType: 'Element', key: element.key, label: element.label, path: file });
      await this.updateElementCard(obsidianRoot, element);
    }
    for (const transition of transitionRecords) {
      const file = outputPaths.get(transition.id);
      await this.writeYaml(file, transition);
      touched.push({ entityType: 'Transition', key: transition.key, label: transition.key, path: file });
    }

    const refreshed = await this.loadCanonicalIndex(appRoot);
    const canonicalEntities = refreshed.records.filter((record) => record.value.entityType);
    const entries = (await listFiles(appRoot, (file) => /\.ya?ml$/i.test(file) && path.basename(file) !== 'manifest.yaml'))
      .map((file) => normalizePath(path.relative(appRoot, file)));
    const graphRevision = `workbench-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${stageId.slice(-6)}`;
    const manifest = {
      schemaVersion: '3.0.0',
      manifestType: 'NormalizedUiKnowledgeGraph',
      applicationRef: application.id,
      generatedAt: new Date().toISOString(),
      graphRevision,
      status: 'incomplete',
      entries,
      entityIds: canonicalEntities.map((record) => record.value.id).sort(),
      migratedEntityIds: this.yaml.load(await readFile(path.join(appRoot, 'manifest.yaml'), 'utf8'))?.migratedEntityIds || [],
      legacyTransitionIds: this.yaml.load(await readFile(path.join(appRoot, 'manifest.yaml'), 'utf8'))?.legacyTransitionIds || [],
    };
    await this.writeYaml(path.join(appRoot, 'manifest.yaml'), manifest);
    manifest.rootHash = await this.rootHash(appRoot);
    await this.writeYaml(path.join(appRoot, 'manifest.yaml'), manifest);
    const navIndex = path.join(obsidianRoot, '导航', '导航路网索引.md');
    if (await exists(navIndex)) {
      const content = await readFile(navIndex, 'utf8');
      await writeFile(navIndex, content
        .replace(/graph_revision:\s*.*$/m, `graph_revision: ${graphRevision}`)
        .replace(/Graph Revision：`[^`]+`/, `Graph Revision：\`${graphRevision}\``), 'utf8');
    }
    return { appRoot, obsidianRoot, graphRevision, touched, evidence, counts: {
      pages: refreshed.byType.get('Page')?.length || 0,
      elements: refreshed.byType.get('Element')?.length || 0,
      transitions: refreshed.byType.get('Transition')?.length || 0,
    } };
  }

  async rootHash(appRoot) {
    const digest = createHash('sha256');
    for (const file of await listFiles(appRoot, (item) => /\.ya?ml$/i.test(item) && path.basename(item) !== 'manifest.yaml')) {
      digest.update(normalizePath(path.relative(appRoot, file)));
      digest.update(Buffer.from([0]));
      digest.update(await readFile(file));
      digest.update(Buffer.from([0]));
    }
    return `sha256:${digest.digest('hex')}`;
  }

  async validateStage(stageGraphRoot, draft, materialized) {
    const errors = [];
    const warnings = [];
    for (const element of draft.elements) {
      if (element.reviewStatus === 'pending') warnings.push(`待审核元素未进入 staging：${element.label}`);
      if (['accepted', 'edited'].includes(element.reviewStatus) && element.interactionBoundary === 'candidate_bbox') {
        warnings.push(`元素边界仍是 Model A 候选框：${element.label}`);
      }
    }
    for (const transition of draft.transitions) {
      errors.push(...draftTransitionIssues(transition, draft).map((issue) => `Transition ${transition.key}：${issue}`));
    }

    const schemaRoot = path.join(this.graphRoot, 'spec', 'schemas');
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const schemaFiles = await listFiles(schemaRoot, (file) => file.endsWith('.json'));
    const schemas = [];
    for (const file of schemaFiles) schemas.push(JSON.parse(await readFile(file, 'utf8')));
    for (const schema of schemas) ajv.addSchema(schema, schema.$id);
    const schemaByType = {
      Application: 'application.schema.json',
      Page: 'page.schema.json',
      Element: 'element.schema.json',
      Transition: 'transition.schema.json',
      AuthorityContract: 'authority-contract.schema.json',
    };
    let schemaChecks = 0;
    const stagedIndex = await this.loadCanonicalIndex(materialized.appRoot);
    for (const record of stagedIndex.records) {
      const schemaId = schemaByType[record.value.entityType] || (record.value.recordType ? 'supporting-record.schema.json' : null);
      if (!schemaId) continue;
      schemaChecks += 1;
      const validator = ajv.getSchema(schemaId);
      if (!validator(record.value)) {
        errors.push(`${normalizePath(path.relative(stageGraphRoot, record.file))}：${ajv.errorsText(validator.errors, { separator: '；' })}`);
      }
    }
    const manifest = this.yaml.load(await readFile(path.join(materialized.appRoot, 'manifest.yaml'), 'utf8'));
    const manifestValidator = ajv.getSchema('manifest.schema.json');
    schemaChecks += 1;
    if (!manifestValidator(manifest)) errors.push(`manifest.yaml：${ajv.errorsText(manifestValidator.errors, { separator: '；' })}`);

    let graphChecks = 0;
    try {
      const reportPath = path.join(path.dirname(stageGraphRoot), 'validation-report.txt');
      await execFileAsync(this.pythonBinary, [
        path.join(this.graphRoot, 'tools', 'validate_normalized_zto_graph.py'),
        '--root', stageGraphRoot,
        '--report', reportPath,
      ], { maxBuffer: 8 * 1024 * 1024 });
      graphChecks += 1;
    } catch (error) {
      graphChecks += 1;
      const output = `${error.stdout || ''}\n${error.stderr || ''}`.trim();
      errors.push(...output.split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2)));
    }
    return { valid: errors.length === 0, errors: unique(errors), warnings: unique(warnings), schemaChecks, graphChecks };
  }

  async semanticDiff(activeGraphRoot, stageGraphRoot, appKey, touched) {
    const diff = [];
    for (const item of touched) {
      const relative = path.relative(stageGraphRoot, item.path);
      const activePath = path.join(activeGraphRoot, relative);
      const stageBytes = await readFile(item.path);
      const activeBytes = await readFile(activePath).catch(() => null);
      const change = activeBytes ? (stableHash(activeBytes) === stableHash(stageBytes) ? 'unchanged' : 'update') : 'add';
      if (change !== 'unchanged') diff.push({
        entityType: item.entityType,
        change,
        key: item.key,
        label: item.label,
        path: normalizePath(relative),
        summary: change === 'add' ? '新增 Canonical 实体' : '追加观测或更新人工审核字段',
      });
    }
    diff.push({ entityType: 'Manifest', change: 'update', key: 'manifest', label: 'Manifest', path: `apps/${appKey}/manifest.yaml`, summary: '更新 Graph Revision、实体集合与内容根哈希' });
    return diff;
  }

  async refreshSnapshotManifest(stageGraphRoot, appKey, stageId) {
    const appRoot = path.join(stageGraphRoot, 'apps', appKey);
    const index = await this.loadCanonicalIndex(appRoot);
    const manifestPath = path.join(appRoot, 'manifest.yaml');
    const previous = this.yaml.load(await readFile(manifestPath, 'utf8'));
    const entries = (await listFiles(appRoot, (file) => /\.ya?ml$/i.test(file) && path.basename(file) !== 'manifest.yaml'))
      .map((file) => normalizePath(path.relative(appRoot, file)));
    const graphRevision = `workbench-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${stageId.slice(-6)}`;
    const manifest = {
      ...previous,
      generatedAt: new Date().toISOString(),
      graphRevision,
      entries,
      entityIds: index.records.filter((record) => record.value.entityType).map((record) => record.value.id).sort(),
    };
    delete manifest.rootHash;
    await this.writeYaml(manifestPath, manifest);
    manifest.rootHash = await this.rootHash(appRoot);
    await this.writeYaml(manifestPath, manifest);

    const navIndex = path.join(stageGraphRoot, 'obsidian', appKey, '导航', '导航路网索引.md');
    if (await exists(navIndex)) {
      const content = await readFile(navIndex, 'utf8');
      await writeFile(navIndex, content
        .replace(/graph_revision:\s*.*$/m, `graph_revision: ${graphRevision}`)
        .replace(/Graph Revision：`[^`]+`/, `Graph Revision：\`${graphRevision}\``), 'utf8');
    }
    return {
      graphRevision,
      rootHash: manifest.rootHash,
      index,
      counts: {
        pages: index.byType.get('Page')?.length || 0,
        elements: index.byType.get('Element')?.length || 0,
        transitions: index.byType.get('Transition')?.length || 0,
      },
    };
  }

  canonicalTouched(index) {
    return index.records.flatMap((record) => record.value.entityType ? [{
      entityType: record.value.entityType,
      key: record.value.key || record.value.id,
      label: record.value.label || record.value.key || record.value.id,
      path: record.file,
    }] : []);
  }

  async prepare(draftValue) {
    const draft = normalizeDraftShape(draftValue);
    const stageId = `stage-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const stageRoot = path.join(this.stagingRoot, stageId);
    const stageGraphRoot = path.join(stageRoot, 'knowledge_graph');
    await mkdir(stageGraphRoot, { recursive: true });
    await Promise.all([
      cp(path.join(this.graphRoot, 'apps'), path.join(stageGraphRoot, 'apps'), { recursive: true }),
      cp(path.join(this.graphRoot, 'obsidian'), path.join(stageGraphRoot, 'obsidian'), { recursive: true }),
    ]);
    const activeManifest = this.yaml.load(await readFile(path.join(this.graphRoot, 'apps', draft.appKey, 'manifest.yaml'), 'utf8'));
    const materialized = await this.materialize(stageGraphRoot, draft, stageId);
    const validation = await this.validateStage(stageGraphRoot, draft, materialized);
    const diff = await this.semanticDiff(this.graphRoot, stageGraphRoot, draft.appKey, materialized.touched);
    const result = {
      stageId,
      appKey: draft.appKey,
      draftRevision: draft.revision,
      baseRootHash: activeManifest.rootHash,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'draft',
      operation: 'prepare',
      sourceStageIds: [],
      mergeConflicts: [],
      graphRevision: materialized.graphRevision,
      diff,
      validation,
      counts: materialized.counts,
      explorationId: materialized.evidence.explorationId,
      explorationIds: [materialized.evidence.explorationId],
      publishedAt: null,
      archivedAt: null,
    };
    await writeFile(path.join(stageRoot, 'draft.json'), `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
    return this.saveStage(result);
  }

  async loadStage(stageId) {
    return this.normalizeStageMetadata(JSON.parse(await readFile(path.join(this.stageRoot(stageId), 'stage.json'), 'utf8')));
  }

  async deleteStage(stageId) {
    const stage = await this.loadStage(stageId);
    if (stage.status !== 'draft') throw new Error('只有未发布版本可以删除');
    await rm(this.stageRoot(stageId), { recursive: true, force: true });
    return { deleted: true, stageId };
  }

  async archiveStage(stageId) {
    const stage = await this.loadStage(stageId);
    if (stage.status !== 'published') throw new Error('只有已发布版本可以归档');
    const now = new Date().toISOString();
    return this.saveStage({ ...stage, status: 'archived', archivedAt: now, updatedAt: now });
  }

  async mergeStages(stageIds) {
    const ids = unique(stageIds || []);
    if (ids.length < 2) throw new Error('至少选择两个 Staging 版本进行合并');
    const sources = (await Promise.all(ids.map((id) => this.loadStage(id))))
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
    if (sources.some((stage) => stage.status !== 'draft')) throw new Error('只能合并未发布版本');
    const appKeys = unique(sources.map((stage) => stage.appKey));
    if (appKeys.length !== 1) throw new Error('不同应用的 Staging 版本不能合并');
    const appKey = appKeys[0];
    const activeManifest = this.yaml.load(await readFile(path.join(this.graphRoot, 'apps', appKey, 'manifest.yaml'), 'utf8'));
    if (sources.some((stage) => stage.baseRootHash !== activeManifest.rootHash)) {
      throw new Error('存在基于旧活动图谱生成的版本，请重新生成后再合并');
    }

    const stageId = `stage-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const stageRoot = this.stageRoot(stageId);
    const stageGraphRoot = path.join(stageRoot, 'knowledge_graph');
    await mkdir(stageGraphRoot, { recursive: true });
    await Promise.all([
      cp(path.join(this.graphRoot, 'apps'), path.join(stageGraphRoot, 'apps'), { recursive: true }),
      cp(path.join(this.graphRoot, 'obsidian'), path.join(stageGraphRoot, 'obsidian'), { recursive: true }),
    ]);

    const applied = new Map();
    const mergeConflicts = [];
    const obsidianTouched = new Map();
    for (const source of sources) {
      for (const area of ['apps', 'obsidian']) {
        const sourceRoot = path.join(this.stageRoot(source.stageId), 'knowledge_graph', area, appKey);
        const activeRoot = path.join(this.graphRoot, area, appKey);
        if (!(await exists(sourceRoot))) continue;
        for (const sourceFile of await listFiles(sourceRoot)) {
          const relative = path.relative(sourceRoot, sourceFile);
          if (area === 'apps' && relative === 'manifest.yaml') continue;
          const sourceBytes = await readFile(sourceFile);
          const activeBytes = await readFile(path.join(activeRoot, relative)).catch(() => null);
          if (activeBytes && stableHash(sourceBytes) === stableHash(activeBytes)) continue;
          const key = `${area}/${normalizePath(relative)}`;
          const hash = stableHash(sourceBytes);
          const previous = applied.get(key);
          if (previous && previous.hash !== hash) {
            mergeConflicts.push({ path: key, previousStageId: previous.stageId, overridingStageId: source.stageId });
          }
          const destination = path.join(stageGraphRoot, area, appKey, relative);
          await mkdir(path.dirname(destination), { recursive: true });
          await cp(sourceFile, destination);
          applied.set(key, { hash, stageId: source.stageId });
          if (area === 'obsidian') obsidianTouched.set(key, { entityType: 'Obsidian', key, label: path.basename(relative), path: destination });
        }
      }
      for (const explorationId of source.explorationIds) {
        const sourceExploration = path.join(this.stageRoot(source.stageId), 'knowledge_graph', 'explorations', explorationId);
        if (await exists(sourceExploration)) {
          await mkdir(path.join(stageGraphRoot, 'explorations'), { recursive: true });
          await cp(sourceExploration, path.join(stageGraphRoot, 'explorations', explorationId), { recursive: true });
        }
      }
    }

    const refreshed = await this.refreshSnapshotManifest(stageGraphRoot, appKey, stageId);
    const materialized = { appRoot: path.join(stageGraphRoot, 'apps', appKey), ...refreshed };
    const validation = await this.validateStage(stageGraphRoot, { elements: [], transitions: [] }, materialized);
    if (mergeConflicts.length) {
      validation.warnings.push(...mergeConflicts.map((conflict) => `合并覆盖：${conflict.path}，采用较新版本 ${conflict.overridingStageId}`));
    }
    const touched = [...this.canonicalTouched(refreshed.index), ...obsidianTouched.values()];
    const diff = await this.semanticDiff(this.graphRoot, stageGraphRoot, appKey, touched);
    const now = new Date().toISOString();
    return this.saveStage({
      stageId,
      appKey,
      draftRevision: Math.max(...sources.map((stage) => stage.draftRevision)),
      baseRootHash: activeManifest.rootHash,
      createdAt: now,
      updatedAt: now,
      status: 'draft',
      operation: 'merge',
      sourceStageIds: sources.map((stage) => stage.stageId),
      mergeConflicts,
      graphRevision: refreshed.graphRevision,
      diff,
      validation,
      counts: refreshed.counts,
      explorationId: sources.flatMap((stage) => stage.explorationIds)[0] || null,
      explorationIds: unique(sources.flatMap((stage) => stage.explorationIds)),
      publishedAt: null,
      archivedAt: null,
    });
  }

  async publish(stageId) {
    const stage = await this.loadStage(stageId);
    if (stage.status !== 'draft') throw new Error('只有未发布版本可以发布');
    if (!stage.validation.valid) throw new Error('staging 仍有发布阻断项');
    const activeManifest = this.yaml.load(await readFile(path.join(this.graphRoot, 'apps', stage.appKey, 'manifest.yaml'), 'utf8'));
    if (activeManifest.rootHash !== stage.baseRootHash) throw new Error('活动图谱已变化，请重新生成 staging Diff');
    const stageGraphRoot = path.join(this.stagingRoot, stageId, 'knowledge_graph');
    const activeApp = path.join(this.graphRoot, 'apps', stage.appKey);
    const activeObsidian = path.join(this.graphRoot, 'obsidian', stage.appKey);
    const stagedApp = path.join(stageGraphRoot, 'apps', stage.appKey);
    const stagedObsidian = path.join(stageGraphRoot, 'obsidian', stage.appKey);
    const backup = path.join(this.backupRoot, `${Date.now()}-${stageId}`);
    const preparedApp = path.join(this.graphRoot, 'apps', `.${stage.appKey}-${stageId}`);
    const preparedObsidian = path.join(this.graphRoot, 'obsidian', `.${stage.appKey}-${stageId}`);
    await Promise.all([
      cp(stagedApp, preparedApp, { recursive: true }),
      cp(stagedObsidian, preparedObsidian, { recursive: true }),
      mkdir(backup, { recursive: true }),
    ]);
    let appSwitched = false;
    let obsidianSwitched = false;
    const copiedExplorations = [];
    try {
      await rename(activeApp, path.join(backup, 'app'));
      await rename(preparedApp, activeApp);
      appSwitched = true;
      await rename(activeObsidian, path.join(backup, 'obsidian'));
      await rename(preparedObsidian, activeObsidian);
      obsidianSwitched = true;
      for (const explorationId of stage.explorationIds) {
        const stagedExploration = path.join(stageGraphRoot, 'explorations', explorationId);
        if (await exists(stagedExploration)) {
          const activeExploration = path.join(this.graphRoot, 'explorations', explorationId);
          await cp(stagedExploration, activeExploration, { recursive: true });
          copiedExplorations.push(activeExploration);
        }
      }
    } catch (error) {
      await Promise.all(copiedExplorations.map((exploration) => rm(exploration, { recursive: true, force: true })));
      if (obsidianSwitched) await rm(activeObsidian, { recursive: true, force: true });
      if (await exists(path.join(backup, 'obsidian'))) await rename(path.join(backup, 'obsidian'), activeObsidian);
      if (appSwitched) await rm(activeApp, { recursive: true, force: true });
      if (await exists(path.join(backup, 'app'))) await rename(path.join(backup, 'app'), activeApp);
      throw error;
    } finally {
      await Promise.all([rm(preparedApp, { recursive: true, force: true }), rm(preparedObsidian, { recursive: true, force: true })]);
    }
    const publishedAt = new Date().toISOString();
    const version = await this.saveStage({
      ...stage,
      status: 'published',
      publishedAt,
      updatedAt: publishedAt,
      backupPath: backup,
    });
    return { published: true, graphRevision: stage.graphRevision, backupPath: backup, explorationId: stage.explorationId, version };
  }

  async rollback(stageId) {
    const target = await this.loadStage(stageId);
    if (target.status === 'archived') throw new Error('已归档版本不能回退');
    if (target.status !== 'published') throw new Error('只能回退到已发布版本');
    const activeManifest = this.yaml.load(await readFile(path.join(this.graphRoot, 'apps', target.appKey, 'manifest.yaml'), 'utf8'));
    const rollbackStageId = `stage-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const rollbackRoot = this.stageRoot(rollbackStageId);
    const rollbackGraphRoot = path.join(rollbackRoot, 'knowledge_graph');
    await mkdir(rollbackRoot, { recursive: true });
    await cp(path.join(this.stageRoot(stageId), 'knowledge_graph'), rollbackGraphRoot, { recursive: true });
    const refreshed = await this.refreshSnapshotManifest(rollbackGraphRoot, target.appKey, rollbackStageId);
    const materialized = { appRoot: path.join(rollbackGraphRoot, 'apps', target.appKey), ...refreshed };
    const validation = await this.validateStage(rollbackGraphRoot, { elements: [], transitions: [] }, materialized);
    const diff = await this.semanticDiff(this.graphRoot, rollbackGraphRoot, target.appKey, this.canonicalTouched(refreshed.index));
    const now = new Date().toISOString();
    await this.saveStage({
      ...target,
      stageId: rollbackStageId,
      baseRootHash: activeManifest.rootHash,
      graphRevision: refreshed.graphRevision,
      createdAt: now,
      updatedAt: now,
      status: 'draft',
      operation: 'rollback',
      rollbackOfStageId: stageId,
      sourceStageIds: [stageId],
      mergeConflicts: [],
      diff,
      validation,
      counts: refreshed.counts,
      publishedAt: null,
      archivedAt: null,
      backupPath: null,
    });
    return this.publish(rollbackStageId);
  }
}
