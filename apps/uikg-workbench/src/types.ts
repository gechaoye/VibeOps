import type { PlaygroundRuntimeInfo, PlaygroundSessionState, PlaygroundSessionTarget } from '@midscene/playground';

export type ReviewStatus = 'pending' | 'accepted' | 'edited' | 'rejected';
export type OwnerKind = 'page' | 'application' | 'component' | 'shared_component';

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MeaningEvidence {
  visibleTexts: string[];
  visibleIcons: string[];
  visibleStates: string[];
  visualCues: string[];
  userContext: string | null;
  unclassified: Array<{
    type: string;
    detail: string | null;
  }>;
}

export interface DraftElement {
  id: string;
  candidateKey: string;
  label: string;
  visualDescription: string;
  controlType: string;
  role: string;
  capabilities: string[];
  actionEffects: Array<{ action: string; effect: string }>;
  enabled: boolean | null;
  state: string;
  dynamicContent: boolean;
  bbox: BBox;
  geometryKind: string;
  geometryConfidence: number;
  confidence: number;
  meaning: {
    status: 'known' | 'candidate' | 'unknown';
    description: string | null;
    evidence: MeaningEvidence;
  };
  riskSignals: string[];
  ownerKind: OwnerKind;
  ownerRef: string;
  parentId: string | null;
  childrenIds: string[];
  pageId: string | null;
  availableOnPageIds: string[];
  interactionBoundary: string;
  reviewStatus: ReviewStatus;
  source: 'ai_worker' | 'human' | 'mixed';
  workerModel: string | null;
  lastModelProposal: Record<string, unknown> | null;
}

export interface DraftPage {
  id: string;
  key: string;
  name: string;
  surfaceType: string;
  stateSummary: string;
  scrollableRegions: string[];
  featurePath: string[];
  frameIds: string[];
  elementIds: string[];
  publishedAt?: string | null;
}

export interface DraftTransitionEvidence {
  beforeFrameId: string;
  locatorFrameId: string;
  actionTraceRef: string;
  afterFrameId: string;
  postcondition: 'pass' | 'pending' | 'failed';
  semanticAssertions: string[];
}

export interface DraftTransition {
  id: string;
  key: string;
  sourcePageId: string;
  sourceStateKey: string;
  triggerElementId: string;
  action: string;
  capability: string;
  targetPageId: string;
  targetStateKey: string;
  reversible: boolean;
  risk: 'safe' | 'low' | 'medium' | 'high' | 'critical';
  evidence: DraftTransitionEvidence;
}

export interface ElementEditRecord {
  elementId: string;
  kind: 'created' | 'updated';
  fields: string[];
  editedAt: string;
}

export interface ElementActivityRecord {
  id: string;
  action: string;
  createdAt: string;
  elementIds: string[];
  elementLabels: string[];
  fields: string[];
  groupKey?: string;
}

export interface Draft {
  schemaVersion: string;
  revision: number;
  appKey: string;
  buildRef: string;
  featurePath: string[];
  currentPageId: string;
  currentFrameId: string | null;
  rawModelResultRef: string | null;
  page: {
    id: string;
    key: string;
    name: string;
    surfaceType: string;
    stateSummary: string;
    scrollableRegions: string[];
  };
  pages: DraftPage[];
  elements: DraftElement[];
  elementEditRecords: ElementEditRecord[];
  transitions: DraftTransition[];
  lastWorkerModel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationIssue {
  level: 'error' | 'warning';
  code: string;
  elementId?: string;
  message: string;
}

export interface FrameMetadata {
  frameId: string;
  mimeType: string;
  extension: string;
  width: number;
  height: number;
  bytes: number;
  capturedAt: string;
  imageUrl: string;
}

export type PageUploadStatus = 'queued' | 'uploading' | 'completed' | 'failed';

export interface PageUploadTask {
  id: string;
  sourceType: 'file' | 'url';
  name: string;
  url: string | null;
  mimeType: string | null;
  totalBytes: number | null;
  uploadedBytes: number;
  status: PageUploadStatus;
  errorReason: string | null;
  pageId: string | null;
  frameId: string | null;
  createdAt: string;
  updatedAt: string;
  processing?: boolean;
}

export interface WorkbenchStatus {
  ok: boolean;
  agentConnected: boolean;
  workersRunning: boolean;
  workerAConfigured: boolean;
  workerAModel: string | null;
  workerBConfigured: boolean;
  workerBModel: string | null;
  workerASession: WorkerResumeSession | null;
  workerBSession: WorkerResumeSession | null;
  spec: {
    version: string;
    schemaVersion: string;
    contentHash: string;
    index: string;
  };
  session: PlaygroundSessionState | null;
}

export interface WorkerResumeSession {
  id: string;
  status: 'paused';
  frameId: string;
  pageId?: string | null;
  pageContext: string;
  model: string | null;
  completedCandidates: number;
  retryAttempts: Array<{
    attempt: number;
    completed: boolean;
    receivedContent?: boolean;
    recoveredElements?: number;
    error?: string;
  }>;
  createdAt: string;
  updatedAt: string;
  errorMessage: string;
  reasoningContent?: string;
  outputContent?: string;
}

export interface AnalysisSession {
  id: string;
  kind: 'worker_a' | 'worker_b';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  frameId: string | null;
  pageId?: string | null;
  model: string | null;
  startedAt: string;
  updatedAt: string;
  errorMessage?: string | null;
  reasoningContent: string;
  outputContent: string;
  retryAttempts?: WorkerResumeSession['retryAttempts'];
}

export interface WorkerElementCandidate {
  candidateKey: string;
  label?: string | null;
  visualDescription?: string;
  controlType?: string;
  approximateRegion?: BBox;
  confidence?: number;
  [key: string]: unknown;
}

export interface WorkerResult {
  frameId: string;
  page: Record<string, unknown>;
  elements: WorkerElementCandidate[];
  relationships: Array<Record<string, unknown>>;
  actionCandidates: Array<Record<string, unknown>>;
  comparison: Record<string, unknown>;
  uncertainties: string[];
  done?: boolean;
  [key: string]: unknown;
}

export type WorkerMergeSource = 'workerA' | 'workerB';

export interface WorkerElementMergeSelection {
  candidateKey: string;
  workerACandidateKey?: string;
  workerBCandidateKey?: string;
  baseSource: WorkerMergeSource;
  fieldSources: Record<string, WorkerMergeSource>;
}

export interface WorkerModelPreset {
  id: string;
  name: string;
  modelName: string;
  modelFamily: string;
  badge: string;
  summary: string;
  inputPrice: string | null;
  outputPrice: string | null;
}

export interface WorkerModelSettings {
  workerA: WorkerSlotSettings;
  workerB: WorkerSlotSettings;
  runtimeReloaded?: boolean;
}

export interface WorkerSlotSettings {
  envPath: string;
  worker: 'worker_a' | 'worker_b';
  config: {
    baseUrl: string;
    modelName: string;
    modelFamily: string;
    timeout: number;
    temperature: number;
    reasoningEnabled: boolean;
    apiKeyConfigured: boolean;
    apiKeyHint: string | null;
  };
  presets: WorkerModelPreset[];
  modelFamilies: string[];
  runtimeModel: string | null;
  runtimeSynced: boolean;
}

export interface StagingDiffItem {
  entityType: 'Page' | 'Element' | 'Transition' | 'Manifest' | 'Obsidian';
  change: 'add' | 'update' | 'unchanged';
  key: string;
  label: string;
  path: string;
  summary: string;
}

export interface StagingResult {
  stageId: string;
  appKey: string;
  draftRevision: number;
  baseRootHash: string;
  createdAt: string;
  graphRevision: string;
  diff: StagingDiffItem[];
  validation: {
    valid: boolean;
    errors: string[];
    warnings: string[];
    schemaChecks: number;
    graphChecks: number;
  };
  counts: {
    pages: number;
    elements: number;
    transitions: number;
  };
}

export interface DeviceState {
  online: boolean;
  session: PlaygroundSessionState | null;
  runtimeInfo: PlaygroundRuntimeInfo | null;
  targets: PlaygroundSessionTarget[];
}
