import type { PlaygroundRuntimeInfo, PlaygroundSessionState, PlaygroundSessionTarget } from '@midscene/playground';

export type ReviewStatus = 'pending' | 'accepted' | 'edited' | 'rejected';
export type OwnerKind = 'page' | 'application' | 'component' | 'shared_component';

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AbstractElementField {
  key: string;
  label: string;
  elementType: string;
  description: string;
  displayCondition: string;
  capabilities: string[];
  interactionBoundary: string;
  actionEffects: Array<{ action: string; effect: string }>;
  parentId: string | null;
  required: boolean;
  instanceRegions: BBox[];
}

export interface AbstractElementDefinition {
  kind: 'repeated-template' | 'dynamic-template';
  templateKey: string;
  instanceCount: number;
  fields: AbstractElementField[];
  instanceRegions: BBox[];
  bboxStyle: 'abstract';
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
  displayCondition: string;
  elementType: string;
  role: string;
  capabilities: string[];
  actionEffects: Array<{ action: string; effect: string }>;
  enabled: boolean | null;
  state: string;
  dynamicContent: boolean;
  abstraction: AbstractElementDefinition | null;
  bbox: BBox;
  gridColumns: number;
  gridRows: number;
  gridRegion: number;
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
  source: 'ai' | 'human' | 'mixed';
  aiModel: string | null;
  lastModelProposal: Record<string, unknown> | null;
}

export interface DraftPage {
  id: string;
  key: string;
  name: string;
  functionRef?: string;
  implementationType?: 'native' | 'rn' | 'h5' | 'mini-program' | 'unknown';
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

export interface DraftRelationInterface {
  id: string;
  method: string;
  path: string;
  service: string;
  description: string;
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
  triggeredInterfaces?: DraftRelationInterface[];
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
    functionRef?: string;
    implementationType?: 'native' | 'rn' | 'h5' | 'mini-program' | 'unknown';
    surfaceType: string;
    stateSummary: string;
    scrollableRegions: string[];
  };
  pages: DraftPage[];
  elements: DraftElement[];
  elementEditRecords: ElementEditRecord[];
  transitions: DraftTransition[];
  lastAiModel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CanonicalGraphPage {
  id: string;
  key: string;
  label: string;
  featurePath: string[];
  surfaceType: string;
  status: string;
  summary: string;
  states: Array<{ key: string; summary: string }>;
  elementCount: number;
  sharedElementCount: number;
  inboundCount: number;
  outboundCount: number;
  preview: CanonicalGraphPreview | null;
}

export interface CanonicalGraphPreview {
  frameRef: string;
  imageUrl: string;
  viewport: { width: number; height: number };
}

export interface CanonicalGraphElementPreview extends CanonicalGraphPreview {
  pageId: string;
  element: {
    id: string;
    key: string;
    label: string;
    elementType: string;
    rect: { left: number; top: number; width: number; height: number };
  };
}

export interface CanonicalGraphEdge {
  id: string;
  canonicalId?: string;
  key: string;
  kind: 'transition' | 'authority_contract';
  source: string;
  target: string;
  sourceStateKey: string | null;
  targetStateKey: string | null;
  action: string;
  capability: string;
  triggerElementId: string;
  trigger: { id: string; key: string; label: string; elementType: string } | null;
  preview: CanonicalGraphElementPreview | null;
  reversible: boolean | null;
  risk: 'safe' | 'low' | 'medium' | 'high' | 'critical' | string;
  status: string;
  planningEligible: boolean;
}

export interface CanonicalGraph {
  appKey: string;
  application: { id: string; key: string; label: string; platform: string } | null;
  revision: string | null;
  status: string;
  generatedAt: string | null;
  stats: {
    pages: number;
    elements: number;
    transitions: number;
    authorityContracts: number;
  };
  featureDomains: string[];
  pages: CanonicalGraphPage[];
  edges: CanonicalGraphEdge[];
}

export interface ValidationIssue {
  level: 'error' | 'warning';
  code: string;
  elementId?: string;
  message: string;
  candidateKey?: string;
  relatedElementIds?: string[];
  pageIds?: string[];
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
  runtimeStructure?: Record<string, unknown> | null;
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
  recognitionRunning: boolean;
  manualModelConfigured: boolean;
  manualModel: string | null;
  manualGatewayLabel: string | null;
  manualReasoningEffort: ReasoningEffort | null;
  manualSession: RecognitionResumeSession | null;
  spec: {
    version: string;
    schemaVersion: string;
    contentHash: string;
    index: string;
  };
  session: PlaygroundSessionState | null;
}

export interface RecognitionResumeSession {
  id: string;
  status: 'paused' | 'running';
  frameId: string;
  pageId?: string | null;
  pageContext: string;
  includeUiTree?: boolean;
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
  kind: 'manual';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  frameId: string | null;
  pageId?: string | null;
  workspaceSessionId?: string;
  model: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt?: string | null;
  durationMs?: number | null;
  errorMessage?: string | null;
  schemaErrors?: unknown[];
  consistencyIssues?: unknown[];
  normalizationIssues?: unknown[];
  reasoningContent: string;
  outputContent: string;
  retryAttempts?: RecognitionResumeSession['retryAttempts'];
  lastEventId?: number;
}

export interface RecognitionElementCandidate {
  candidateKey: string;
  label?: string | null;
  visualDescription?: string;
  elementType?: string;
  approximateRegion?: BBox;
  confidence?: number;
  [key: string]: unknown;
}

export interface RecognitionResult {
  frameId: string;
  page: Record<string, unknown>;
  elements: RecognitionElementCandidate[];
  relationships: Array<Record<string, unknown>>;
  actionCandidates: Array<Record<string, unknown>>;
  comparison: Record<string, unknown>;
  uncertainties: string[];
  done?: boolean;
  [key: string]: unknown;
}

export interface ModelPreset {
  id: string;
  name: string;
  modelName: string;
  modelFamily: string;
  badge: string;
  summary: string;
  inputPrice: string | null;
  outputPrice: string | null;
}

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';
export type ModelTarget = 'manual' | 'auto' | 'midscene';
export type WorkbenchMode = 'manual' | 'auto';
export type ModelCapabilityMode = 'native' | 'local' | 'unavailable';

export interface ModelCapability {
  mode: ModelCapabilityMode;
  checkedAt: string;
  detail: string;
  gatewayUpdatedAt?: string;
}

export interface ModelGatewaySettings {
  id: string;
  label: string;
  baseUrl: string;
  kind: 'default' | 'custom';
  apiKeyConfigured: boolean;
  apiKeyHint: string | null;
  defaultValueAvailable?: boolean;
}

export interface ModelGatewayCatalog extends ModelGatewaySettings {
  sourceUrl: string;
  models: string[];
  modelFamilies: Record<string, string>;
  capabilities: Record<string, ModelCapability | null>;
  error?: string;
}

export interface AvailableModels {
  gateways: ModelGatewayCatalog[];
  totalModels: number;
}

export interface ModelSettingsData {
  settingsSchemaVersion?: number;
  sections?: Array<{ id: string; label: string; order: number }>;
  manual: ModelSlotSettings;
  auto: ModelSlotSettings;
  midscene: ModelSlotSettings;
  gateways: ModelGatewaySettings[];
  runtimeReloaded?: boolean;
  modeConfiguration: { mode: WorkbenchMode };
}

export type ProjectModelFieldValueType = 'string' | 'text' | 'integer' | 'number' | 'boolean' | 'date' | 'datetime' | 'option' | 'multi_option' | 'entity_ref' | 'entity_ref_list' | 'object' | 'object_list';

export interface ProjectModelOption {
  value: string;
  label: string;
  status?: 'active' | 'inactive';
}

export interface ProjectModelField {
  key: string;
  label?: string;
  description?: string;
  example?: string;
  appliesTo: string[];
  valueType: ProjectModelFieldValueType;
  required?: boolean;
  defaultValue?: unknown;
  optionSetRef?: string;
  allowCustomOptions?: boolean;
  searchable?: boolean;
  itemFields?: Array<Record<string, unknown>>;
  ui?: { group?: string; component?: string; [key: string]: unknown };
}

export interface ProjectModelRelationType {
  sourceTypes: string[];
  targetTypes: string[];
  constraints?: Record<string, unknown>;
  label?: string;
  description?: string;
}

export interface ProjectModelOptionSet {
  label?: string;
  description?: string;
  options?: ProjectModelOption[];
  addOptions?: ProjectModelOption[];
}

export interface ProjectModelDefinition {
  projectRef?: string;
  baseModelVersion?: string;
  modelVersion: string;
  name?: string;
  entityTypes?: Record<string, { label: string; description?: string; group?: string }>;
  relationTypes?: Record<string, ProjectModelRelationType>;
  optionSets?: Record<string, ProjectModelOptionSet>;
  fields?: ProjectModelField[];
}

export interface ProjectModelData {
  projectKey: string;
  core: ProjectModelDefinition;
  project: ProjectModelDefinition;
  effectiveModelVersion: string;
}

export interface ModelSlotSettings {
  storagePath: string;
  target: ModelTarget;
  config: {
    gatewayId: string;
    baseUrl: string;
    modelName: string;
    modelFamily: string;
    timeout: number;
    temperature: number;
    reasoningEffort: ReasoningEffort;
    reasoningEnabled: boolean;
    apiKeyConfigured: boolean;
    apiKeyHint: string | null;
  };
  presets: ModelPreset[];
  modelFamilies: string[];
  runtimeModel: string | null;
  runtimeSynced: boolean;
  capability: ModelCapability | null;
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
  updatedAt: string;
  status: 'draft' | 'published' | 'archived';
  operation: 'prepare' | 'merge' | 'rollback';
  sourceStageIds: string[];
  rollbackOfStageId?: string;
  mergeConflicts: Array<{
    path: string;
    previousStageId: string;
    overridingStageId: string;
  }>;
  graphRevision: string;
  explorationId?: string | null;
  explorationIds: string[];
  publishedAt: string | null;
  archivedAt: string | null;
  isCurrent?: boolean;
  isStale?: boolean;
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

export interface StagingPublishResult {
  published: true;
  graphRevision: string;
  backupPath: string;
  explorationId: string | null;
  version: StagingResult;
  draft: Draft;
  issues: ValidationIssue[];
}

export interface DeviceState {
  online: boolean;
  session: PlaygroundSessionState | null;
  runtimeInfo: PlaygroundRuntimeInfo | null;
  targets: PlaygroundSessionTarget[];
}
