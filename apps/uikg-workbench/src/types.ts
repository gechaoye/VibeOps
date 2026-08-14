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

export type AIReviewStatus = 'pass' | 'needs_review' | 'reject';

export interface AIReview {
  status: AIReviewStatus;
  confidence: number;
  summary: string;
  issues: string[];
  model: string;
  reviewedAt: string;
}

export interface DraftElement {
  id: string;
  candidateKey: string;
  label: string;
  visualDescription: string;
  controlType: string;
  role: string;
  capabilities: string[];
  actionable: 'yes' | 'no' | 'unknown';
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
  source: 'ai_scout' | 'human' | 'mixed';
  scoutModel: string | null;
  lastModelProposal: Record<string, unknown> | null;
  aiReview: AIReview | null;
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
  lastScoutModel: string | null;
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

export interface WorkbenchStatus {
  ok: boolean;
  agentConnected: boolean;
  scoutRunning: boolean;
  scoutConfigured: boolean;
  scoutModel: string | null;
  reviewerConfigured: boolean;
  reviewerModel: string | null;
  scoutSession: ScoutResumeSession | null;
  spec: {
    version: string;
    schemaVersion: string;
    contentHash: string;
    index: string;
  };
  session: PlaygroundSessionState | null;
}

export interface ScoutResumeSession {
  id: string;
  status: 'paused';
  frameId: string;
  pageContext: string;
  model: string | null;
  completedCandidates: number;
  retryAttempts: Array<{
    attempt: number;
    completed: boolean;
    timedOut?: boolean;
    error?: string;
    receivedElements?: number;
  }>;
  createdAt: string;
  updatedAt: string;
  errorMessage: string;
  reasoningContent?: string;
  outputContent?: string;
}

export interface ScoutModelPreset {
  id: string;
  name: string;
  modelName: string;
  modelFamily: string;
  badge: string;
  summary: string;
  inputPrice: string | null;
  outputPrice: string | null;
}

export interface ScoutModelSettings {
  envPath: string;
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
  presets: ScoutModelPreset[];
  modelFamilies: string[];
  runtimeModel: string | null;
  runtimeSynced: boolean;
  runtimeReloaded?: boolean;
  reviewer?: ModelRoleSettings;
}

export interface ModelRoleSettings {
  envPath: string;
  role: 'scout' | 'reviewer';
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
  presets: ScoutModelPreset[];
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
