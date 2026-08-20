import {
  applyNodeChanges,
  BaseEdge,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  getViewportForBounds,
  useInternalNode,
  useNodesState,
  useUpdateNodeInternals,
  type Edge,
  type EdgeProps,
  type InternalNode,
  type Node,
  type NodeChange,
  type OnNodeDrag,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
  forceX,
  forceY,
  type ForceLink,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { KnowledgeGraphNodeType, KnowledgeGraphViewEdge, KnowledgeGraphViewNode } from './knowledge-graph-view';

interface ForceKnowledgeGraphProps {
  graphNodes: KnowledgeGraphViewNode[];
  graphEdges: KnowledgeGraphViewEdge[];
  matchedNodeIds: Set<string>;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  hoveredNodeId: string | null;
  hoveredEdgeId: string | null;
  onNodeClick: (nodeId: string) => void;
  onEdgeClick: (edgeId: string) => void;
  onNodeHover: (nodeId: string | null) => void;
  onEdgeHover: (edgeId: string | null) => void;
  onPaneClick: () => void;
  onFitReady: (fitGraph: (duration?: number) => void) => void;
}

interface ForceNodeData extends Record<string, unknown> {
  node: KnowledgeGraphViewNode;
  color: string;
  activeColor: string;
  selected: boolean;
  active: boolean;
  focused: boolean;
  dimmed: boolean;
  insideCollapsedContainer: boolean;
}

interface NavContainerData extends Record<string, unknown> {
  expanded: boolean;
  selected: boolean;
  focused: boolean;
  dimmed: boolean;
  radius: number;
  onToggle: () => void;
}

interface LayoutNode extends SimulationNodeDatum {
  id: string;
  type: KnowledgeGraphNodeType;
  label: string;
  order?: number;
  radialDepth: number;
}

interface LayoutLink {
  source: string | LayoutNode;
  target: string | LayoutNode;
  kind: string;
}

const nodeVisuals: Record<KnowledgeGraphNodeType, { color: string; radius: number; kind: string }> = {
  nav: { color: '#339cff', radius: 11, kind: '' },
  feature: { color: '#f3883b', radius: 15, kind: '功能' },
  page: { color: '#5dc977', radius: 8, kind: '' },
  shared: { color: '#eb77b1', radius: 9, kind: '共享' },
  entry: { color: '#9b79ec', radius: 12, kind: '聚合' },
};

function darken(color: string, amount = 0.2) {
  const channels = color.slice(1).match(/.{2}/g)?.map((channel) => Math.round(Number.parseInt(channel, 16) * (1 - amount))) || [0, 0, 0];
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function ForceGraphNode({ data: rawData }: NodeProps) {
  const data = rawData as ForceNodeData;
  const visual = nodeVisuals[data.node.type];
  const style = {
    '--kg-node-color': data.color,
    '--kg-node-active-color': data.activeColor,
    '--kg-node-size': `${visual.radius * 2}px`,
  } as CSSProperties;
  return <div
    className={`kg-force-node kg-force-node-${data.node.type} ${data.selected ? 'selected' : ''} ${data.active ? 'active' : ''} ${data.focused ? 'focused' : ''} ${data.dimmed ? 'dimmed' : ''} ${data.insideCollapsedContainer ? 'inside-collapsed-container' : ''}`}
    style={style}
    aria-label={`${data.node.layer}：${data.node.label}`}
  >
    <Handle type="target" position={Position.Left} />
    {visual.kind && <span className="kg-force-kind">{visual.kind}</span>}
    <span className="kg-force-dot" />
    <span className="kg-force-label">{data.node.label}</span>
    <Handle type="source" position={Position.Right} />
  </div>;
}

function nodeRadius(node: InternalNode<Node>) {
  if (node.type === 'navContainer') {
    const data = node.data as NavContainerData;
    return data.expanded ? data.radius : 17;
  }
  const data = node.data as ForceNodeData;
  const visual = nodeVisuals[data.node.type];
  const scale = data.selected ? 1.48 : data.active ? 1.22 : 1;
  return visual.radius * scale;
}

function FloatingForceEdge({
  id, source, target, markerStart, markerEnd, style, label, labelStyle, labelShowBg,
  labelBgStyle, labelBgPadding, labelBgBorderRadius, interactionWidth, data,
}: EdgeProps) {
  const visualNodeIds = data as { visualSourceId?: string; visualTargetId?: string } | undefined;
  const sourceNode = useInternalNode(visualNodeIds?.visualSourceId || source);
  const targetNode = useInternalNode(visualNodeIds?.visualTargetId || target);
  if (!sourceNode || !targetNode) return null;
  const sourceCenter = {
    x: sourceNode.internals.positionAbsolute.x + (sourceNode.measured.width || 30) / 2,
    y: sourceNode.internals.positionAbsolute.y + (sourceNode.measured.height || 30) / 2,
  };
  const targetCenter = {
    x: targetNode.internals.positionAbsolute.x + (targetNode.measured.width || 30) / 2,
    y: targetNode.internals.positionAbsolute.y + (targetNode.measured.height || 30) / 2,
  };
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const unitX = dx / distance;
  const unitY = dy / distance;
  const sourceRadius = nodeRadius(sourceNode);
  const targetRadius = nodeRadius(targetNode);
  const sourceX = sourceCenter.x + unitX * sourceRadius;
  const sourceY = sourceCenter.y + unitY * sourceRadius;
  const targetX = targetCenter.x - unitX * targetRadius;
  const targetY = targetCenter.y - unitY * targetRadius;
  const labelX = (sourceX + targetX) / 2 - unitY * 5;
  const labelY = (sourceY + targetY) / 2 + unitX * 5;
  return <BaseEdge
    id={id}
    path={`M ${sourceX},${sourceY} L ${targetX},${targetY}`}
    markerStart={markerStart}
    markerEnd={markerEnd}
    style={style}
    label={label}
    labelX={labelX}
    labelY={labelY}
    labelStyle={labelStyle}
    labelShowBg={labelShowBg}
    labelBgStyle={labelBgStyle}
    labelBgPadding={labelBgPadding}
    labelBgBorderRadius={labelBgBorderRadius}
    interactionWidth={interactionWidth}
  />;
}

function NavContainerNode({ id, data: rawData }: NodeProps) {
  const data = rawData as NavContainerData;
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => updateNodeInternals(id));
    return () => window.cancelAnimationFrame(frame);
  }, [data.expanded, id, updateNodeInternals]);
  return <div
    className={`kg-nav-container ${data.expanded ? 'expanded' : 'collapsed'} ${data.selected ? 'selected' : ''} ${data.focused ? 'focused' : ''} ${data.dimmed ? 'dimmed' : ''}`}
    aria-label="当前底部导航"
    role="button"
    tabIndex={0}
    onClick={(event) => { event.stopPropagation(); data.onToggle(); }}
    onKeyDown={(event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        data.onToggle();
      }
    }}
  >
    <Handle type="target" position={Position.Left} />
    <i className="kg-nav-ring kg-nav-ring-outer" />
    <i className="kg-nav-ring kg-nav-ring-middle" />
    <i className="kg-nav-ring kg-nav-ring-inner" />
    <span className="kg-nav-container-label">当前底部导航</span>
    <Handle type="source" position={Position.Right} />
  </div>;
}

const nodeTypes = { forceGraph: ForceGraphNode, navContainer: NavContainerNode };
const edgeTypes = { floating: FloatingForceEdge };
const navContainerId = 'nav.container';

function layoutSize(compact: boolean) {
  return compact ? { width: 420, height: 760 } : { width: 960, height: 680 };
}

function layoutLinks(nodes: Pick<LayoutNode, 'id' | 'type'>[], graphEdges: KnowledgeGraphViewEdge[]) {
  const links: LayoutLink[] = graphEdges.map((edge) => ({ source: edge.source, target: edge.target, kind: edge.kind }));
  const navNodes = nodes.filter((node) => node.type === 'nav');
  const navCenter = navNodes.find((node) => node.id === 'nav.more') || navNodes[0];
  if (navCenter) {
    for (const node of navNodes) {
      if (node.id !== navCenter.id) links.push({ source: navCenter.id, target: node.id, kind: 'nav-cluster' });
    }
  }
  return links;
}

function radialDepths(graphNodes: KnowledgeGraphViewNode[], graphEdges: KnowledgeGraphViewEdge[]) {
  const lightweightNodes = graphNodes.map((node) => ({ id: node.id, type: node.type }));
  const links = layoutLinks(lightweightNodes, graphEdges);
  const adjacency = new Map(graphNodes.map((node) => [node.id, new Set<string>()]));
  for (const link of links) {
    const source = typeof link.source === 'string' ? link.source : link.source.id;
    const target = typeof link.target === 'string' ? link.target : link.target.id;
    adjacency.get(source)?.add(target);
    adjacency.get(target)?.add(source);
  }
  const centerId = adjacency.has('nav.more') ? 'nav.more' : graphNodes[0]?.id;
  const depths = new Map<string, number>();
  if (!centerId) return depths;
  depths.set(centerId, 0);
  const queue = [centerId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const nextDepth = (depths.get(current) || 0) + 1;
    for (const neighbor of adjacency.get(current) || []) {
      if (depths.has(neighbor)) continue;
      depths.set(neighbor, nextDepth);
      queue.push(neighbor);
    }
  }
  const fallbackDepth = Math.max(0, ...depths.values()) + 1;
  for (const node of graphNodes) if (!depths.has(node.id)) depths.set(node.id, fallbackDepth);
  for (const node of graphNodes) {
    if (node.type === 'entry') depths.set(node.id, Math.max(2, depths.get(node.id) || 0));
  }
  return depths;
}

function radialRadius(node: LayoutNode, width: number, height: number, compact: boolean) {
  if (node.radialDepth === 0) return 0;
  const limit = Math.min(width * 0.43, height * 0.4);
  const step = compact ? 64 : 88;
  return Math.min(limit, 28 + node.radialDepth * step);
}

function layoutCollisionRadius(label: string) {
  return Math.max(52, Math.min(112, Array.from(label).length * 9 + 30));
}

function createSimulation(nodes: LayoutNode[], graphEdges: KnowledgeGraphViewEdge[], compact: boolean) {
  const { width, height } = layoutSize(compact);
  const links = layoutLinks(nodes, graphEdges);
  const forceScale = compact ? 0.48 : 1;
  return forceSimulation(nodes)
    .force('link', forceLink<LayoutNode, LayoutLink>(links)
      .id((node) => node.id)
      .distance((link) => link.kind === 'nav-cluster' ? (compact ? 66 : 92) : link.kind === 'placement' ? (compact ? 104 : 142) : (compact ? 80 : 110))
      .strength((link) => link.kind === 'nav-cluster' ? 0.2 : link.kind === 'placement' ? 0.11 : 0.36))
    .force('charge', forceManyBody<LayoutNode>().strength((node) => (node.type === 'feature' ? -500 : node.type === 'entry' ? -400 : node.type === 'nav' ? -330 : -250) * forceScale))
    .force('collide', forceCollide<LayoutNode>().radius((node) => layoutCollisionRadius(node.label)).strength(1).iterations(3))
    .force('radial', forceRadial<LayoutNode>((node) => radialRadius(node, width, height, compact), width / 2, height / 2)
      .strength((node) => node.radialDepth === 0 ? 0.42 : 0.11))
    .force('entry-orbit', forceX<LayoutNode>((node) => node.type === 'entry' ? width * (compact ? 0.16 : 0.12) : width / 2)
      .strength((node) => node.type === 'entry' ? 0.22 : 0))
    .force('entry-orbit-y', forceY<LayoutNode>((node) => node.type === 'entry' && compact ? height * 0.14 : height / 2)
      .strength((node) => node.type === 'entry' && compact ? 0.2 : 0))
    .force('center', forceCenter(width / 2, height / 2).strength(0.045))
    .alphaDecay(0.035)
    .velocityDecay(0.38);
}

function forceLayout(graphNodes: KnowledgeGraphViewNode[], graphEdges: KnowledgeGraphViewEdge[], compact: boolean) {
  const { width, height } = layoutSize(compact);
  const depths = radialDepths(graphNodes, graphEdges);
  const nodes: LayoutNode[] = graphNodes.map((node) => ({
    id: node.id,
    type: node.type,
    label: node.label,
    order: node.order,
    radialDepth: depths.get(node.id) || 0,
  }));
  const depthGroups = new Map<number, LayoutNode[]>();
  for (const node of nodes) depthGroups.set(node.radialDepth, [...(depthGroups.get(node.radialDepth) || []), node]);
  for (const [depth, group] of depthGroups) {
    group.forEach((node, index) => {
      const angle = -Math.PI / 2 + (index / Math.max(1, group.length)) * Math.PI * 2 + depth * 0.42;
      const radius = radialRadius(node, width, height, compact);
      node.x = width / 2 + Math.cos(angle) * radius;
      node.y = height / 2 + Math.sin(angle) * radius;
    });
  }
  const simulation = createSimulation(nodes, graphEdges, compact).stop();
  for (let index = 0; index < 420; index += 1) simulation.tick();
  return new Map(nodes.map((node) => [node.id, { x: Math.max(25, Math.min(width - 25, node.x || width / 2)) - 15, y: Math.max(25, Math.min(height - 34, node.y || height / 2)) - 15 }]));
}

function navContainerGeometry(nodes: Node[], expanded: boolean) {
  const navNodes = nodes.filter((node) => node.id.startsWith('nav.'));
  const centers = navNodes.map((node) => ({ x: node.position.x + 15, y: node.position.y + 15 }));
  const centerX = centers.reduce((total, point) => total + point.x, 0) / Math.max(1, centers.length);
  const centerY = centers.reduce((total, point) => total + point.y, 0) / Math.max(1, centers.length);
  const contentRadius = Math.max(72, ...centers.map((point) => Math.hypot(point.x - centerX, point.y - centerY) + 42));
  const size = expanded ? contentRadius * 2 : 34;
  return { centerX, centerY, radius: size / 2, size };
}

function navContainerNode(
  nodes: Node[],
  expanded: boolean,
  selected: boolean,
  focused: boolean,
  dimmed: boolean,
  onToggle: () => void,
): Node {
  const { centerX, centerY, radius, size } = navContainerGeometry(nodes, expanded);
  return {
    id: navContainerId,
    type: 'navContainer',
    position: { x: centerX - size / 2, y: centerY - size / 2 },
    data: { expanded, selected, focused, dimmed, radius, onToggle } satisfies NavContainerData,
    style: { width: size, height: size },
    className: expanded ? 'kg-nav-container-node-expanded' : 'kg-nav-container-node-collapsed',
    draggable: true,
    selectable: true,
    focusable: true,
    selected,
    zIndex: 8,
  };
}

function nodesWithNavContainer(
  nodes: Node[],
  expanded: boolean,
  selected: boolean,
  focused: boolean,
  dimmed: boolean,
  onToggle: () => void,
): Node[] {
  const container = navContainerNode(nodes, expanded, selected, focused, dimmed, onToggle);
  return [container, ...nodes];
}

function pushNodesOutsideNavContainer(nodes: Node[]) {
  const geometry = navContainerGeometry(nodes, true);
  let changed = false;
  const pushedNodes = nodes.map((node) => {
    if (node.id === navContainerId || node.id.startsWith('nav.')) return node;
    const data = node.data as ForceNodeData;
    const collisionRadius = layoutCollisionRadius(data.node.label);
    const centerX = node.position.x + 15;
    const centerY = node.position.y + 15;
    let deltaX = centerX - geometry.centerX;
    let deltaY = centerY - geometry.centerY;
    let distance = Math.hypot(deltaX, deltaY);
    const minimumDistance = geometry.radius + collisionRadius + 20;
    if (distance >= minimumDistance) return node;
    if (distance < 1) {
      const seed = Array.from(node.id).reduce((total, character) => total + character.charCodeAt(0), 0);
      const angle = (seed % 360) * Math.PI / 180;
      deltaX = Math.cos(angle);
      deltaY = Math.sin(angle);
      distance = 1;
    }
    changed = true;
    return {
      ...node,
      position: {
        x: geometry.centerX + deltaX / distance * minimumDistance - 15,
        y: geometry.centerY + deltaY / distance * minimumDistance - 15,
      },
    };
  });
  return changed ? pushedNodes : nodes;
}

function visibleGraphBounds(nodes: Node[], compact: boolean) {
  const containerNode = nodes.find((node) => node.id === navContainerId);
  const containerExpanded = Boolean((containerNode?.data as NavContainerData | undefined)?.expanded);
  const graphNodes = nodes.filter((node) => {
    if (node.id === navContainerId) return true;
    if (!containerExpanded && node.id.startsWith('nav.')) return false;
    return true;
  });
  if (graphNodes.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  const bounds = graphNodes.map((node) => {
    if (node.id === navContainerId) {
      const width = typeof node.style?.width === 'number' ? node.style.width : 34;
      const height = typeof node.style?.height === 'number' ? node.style.height : 34;
      return { left: node.position.x, right: node.position.x + width, top: node.position.y, bottom: node.position.y + height + (containerExpanded ? 0 : 22) };
    }
    const data = node.data as ForceNodeData;
    const visual = nodeVisuals[data.node.type];
    const radius = visual.radius * (data.selected ? 1.48 : data.active ? 1.22 : 1);
    const labelWidth = Math.min(180, Math.max(36, Array.from(data.node.label).length * 18));
    const centerX = node.position.x + 15;
    const centerY = node.position.y + 15;
    return {
      left: centerX - Math.max(radius, labelWidth / 2),
      right: centerX + Math.max(radius, labelWidth / 2),
      top: centerY - Math.max(radius, visual.kind ? 26 : radius),
      bottom: centerY + Math.max(radius, 30),
    };
  });
  const minX = Math.min(...bounds.map((bound) => bound.left)) - 18;
  const maxX = Math.max(...bounds.map((bound) => bound.right)) + 18;
  const minY = Math.min(...bounds.map((bound) => bound.top)) - 18;
  const maxY = Math.max(...bounds.map((bound) => bound.bottom)) + (compact ? 88 : 58);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function ForceKnowledgeGraph(props: ForceKnowledgeGraphProps) {
  const {
    graphNodes, graphEdges, matchedNodeIds, selectedNodeId, selectedEdgeId, hoveredNodeId, hoveredEdgeId,
    onNodeClick, onEdgeClick, onNodeHover, onEdgeHover, onPaneClick, onFitReady,
  } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const flowInstanceRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const simulationRef = useRef<Simulation<LayoutNode, undefined> | null>(null);
  const simulationNodesRef = useRef(new Map<string, LayoutNode>());
  const containerDragRef = useRef<{
    containerPosition: { x: number; y: number };
    navPositions: Map<string, { x: number; y: number }>;
  } | null>(null);
  const nodesRef = useRef<Node[]>([]);
  const compactRef = useRef(false);
  const containerExpandedRef = useRef(false);
  const containerSelectedRef = useRef(false);
  const containerFocusedRef = useRef(false);
  const containerDimmedRef = useRef(false);
  const previousContainerExpandedRef = useRef(false);
  const onPaneClickRef = useRef(onPaneClick);
  onPaneClickRef.current = onPaneClick;
  const [compact, setCompact] = useState(false);
  const [containerSelected, setContainerSelected] = useState(false);
  const [containerReflowing, setContainerReflowing] = useState(false);
  const toggleNavContainer = useCallback(() => {
    onPaneClickRef.current();
    setContainerSelected(true);
  }, []);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width < 520));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  const positions = useMemo(() => forceLayout(graphNodes, graphEdges, compact), [compact, graphEdges, graphNodes]);
  const activeNodeId = hoveredNodeId || selectedNodeId;
  const oneHopIds = useMemo(() => {
    if (!activeNodeId) return new Set<string>();
    const ids = new Set([activeNodeId]);
    for (const edge of graphEdges) {
      if (edge.source === activeNodeId) ids.add(edge.target);
      if (edge.target === activeNodeId) ids.add(edge.source);
    }
    return ids;
  }, [activeNodeId, graphEdges]);
  const selectedOneHopIds = useMemo(() => {
    if (!selectedNodeId) return new Set<string>();
    const ids = new Set([selectedNodeId]);
    for (const edge of graphEdges) {
      if (edge.source === selectedNodeId) ids.add(edge.target);
      if (edge.target === selectedNodeId) ids.add(edge.source);
    }
    return ids;
  }, [graphEdges, selectedNodeId]);
  const containerExpanded = containerSelected || [...selectedOneHopIds].some((id) => id.startsWith('nav.'));
  const containerFocused = Boolean(activeNodeId && [...oneHopIds].some((id) => id.startsWith('nav.')));
  const containerDimmed = Boolean(activeNodeId && !containerFocused);
  containerExpandedRef.current = containerExpanded;
  containerSelectedRef.current = containerSelected;
  containerFocusedRef.current = containerFocused;
  containerDimmedRef.current = containerDimmed;

  const projectedNodes = useMemo<Node[]>(() => {
    const graphFlowNodes: Node[] = graphNodes.map((node) => {
      const visual = nodeVisuals[node.type];
      return {
        id: node.id,
        type: 'forceGraph',
        position: positions.get(node.id) || { x: 0, y: 0 },
        data: {
          node,
          color: visual.color,
          activeColor: darken(visual.color),
          selected: node.id === selectedNodeId,
          active: node.id === activeNodeId,
          focused: oneHopIds.has(node.id),
          dimmed: (matchedNodeIds.size !== graphNodes.length && !matchedNodeIds.has(node.id))
            || Boolean(activeNodeId && !oneHopIds.has(node.id)),
          insideCollapsedContainer: node.type === 'nav' && !containerExpanded,
        } satisfies ForceNodeData,
        selected: node.id === selectedNodeId,
        draggable: node.type !== 'nav' || containerExpanded,
        className: node.type === 'nav' ? (containerExpanded ? 'kg-nav-child-expanded' : 'kg-nav-child-collapsed') : undefined,
        zIndex: node.type === 'nav' && containerExpanded ? 12 : node.id === activeNodeId ? 5 : 1,
      };
    });
    return nodesWithNavContainer(graphFlowNodes, containerExpanded, containerSelected, containerFocused, containerDimmed, toggleNavContainer);
  }, [activeNodeId, containerDimmed, containerExpanded, containerFocused, containerSelected, graphNodes, matchedNodeIds, oneHopIds, positions, selectedNodeId, toggleNavContainer]);
  const [nodes, setNodes] = useNodesState(projectedNodes);
  nodesRef.current = nodes;
  compactRef.current = compact;
  const fitGraph = (duration = 0) => {
    const root = rootRef.current;
    const instance = flowInstanceRef.current;
    if (!root || !instance || root.clientWidth === 0 || root.clientHeight === 0) return;
    const viewport = getViewportForBounds(
      visibleGraphBounds(nodesRef.current, compactRef.current),
      root.clientWidth,
      root.clientHeight,
      0.45,
      1.25,
      compactRef.current ? 0.06 : 0.08,
    );
    void instance.setViewport(viewport, { duration, interpolate: 'smooth' });
  };
  useEffect(() => setNodes((currentNodes) => {
    const graphFlowNodes = projectedNodes
      .filter((node) => node.id !== navContainerId)
      .map((nextNode) => {
        const currentNode = currentNodes.find((candidate) => candidate.id === nextNode.id);
        if (!currentNode) return nextNode;
        return { ...currentNode, ...nextNode, position: currentNode.position, measured: currentNode.measured };
      });
    return nodesWithNavContainer(
      graphFlowNodes,
      containerExpandedRef.current,
      containerSelectedRef.current,
      containerFocusedRef.current,
      containerDimmedRef.current,
      toggleNavContainer,
    );
  }), [projectedNodes, setNodes, toggleNavContainer]);
  useEffect(() => {
    setNodes(projectedNodes);
    let fitFrame = 0;
    let fitTimer = 0;
    const updateFrame = window.requestAnimationFrame(() => {
      fitFrame = window.requestAnimationFrame(() => {
        fitGraph();
      });
    });
    fitTimer = window.setTimeout(fitGraph, 240);
    return () => {
      window.cancelAnimationFrame(updateFrame);
      window.cancelAnimationFrame(fitFrame);
      window.clearTimeout(fitTimer);
    };
  }, [compact, positions]);

  useEffect(() => {
    const { width, height } = layoutSize(compact);
    const depths = radialDepths(graphNodes, graphEdges);
    const layoutNodes: LayoutNode[] = graphNodes.map((node) => {
      const position = positions.get(node.id) || { x: width / 2 - 15, y: height / 2 - 15 };
      return {
        id: node.id,
        type: node.type,
        label: node.label,
        order: node.order,
        radialDepth: depths.get(node.id) || 0,
        x: position.x + 15,
        y: position.y + 15,
      } satisfies LayoutNode;
    });
    const simulationNodeMap = new Map(layoutNodes.map((node) => [node.id, node]));
    const simulation = createSimulation(layoutNodes, graphEdges, compact)
      .on('tick', () => {
        setNodes((currentNodes) => {
          const graphFlowNodes = currentNodes
            .filter((node) => node.id !== navContainerId)
            .map((node) => {
              const layoutNode = simulationNodeMap.get(node.id);
              if (!layoutNode) return node;
              return {
                ...node,
                position: { x: (layoutNode.x || width / 2) - 15, y: (layoutNode.y || height / 2) - 15 },
              };
            });
          return nodesWithNavContainer(
            graphFlowNodes,
            containerExpandedRef.current,
            containerSelectedRef.current,
            containerFocusedRef.current,
            containerDimmedRef.current,
            toggleNavContainer,
          );
        });
      })
      .alpha(0)
      .stop();
    if (!containerExpandedRef.current) {
      for (const node of layoutNodes) {
        if (node.type !== 'nav') continue;
        node.fx = node.x;
        node.fy = node.y;
      }
    }
    simulationRef.current = simulation;
    simulationNodesRef.current = simulationNodeMap;
    return () => {
      simulation.stop();
      if (simulationRef.current === simulation) simulationRef.current = null;
    };
  }, [compact, graphEdges, graphNodes, positions, setNodes]);

  useEffect(() => {
    const wasExpanded = previousContainerExpandedRef.current;
    previousContainerExpandedRef.current = containerExpanded;
    for (const node of simulationNodesRef.current.values()) {
      if (node.type !== 'nav') continue;
      if (containerExpanded) {
        node.fx = null;
        node.fy = null;
      } else {
        node.fx = node.x;
        node.fy = node.y;
      }
    }
    if (!containerExpanded || wasExpanded) return undefined;

    setContainerReflowing(true);
    let settleTimer = 0;
    const frame = window.requestAnimationFrame(() => {
      setNodes((currentNodes) => {
        const graphFlowNodes = currentNodes.filter((node) => node.id !== navContainerId);
        const pushedNodes = pushNodesOutsideNavContainer(graphFlowNodes);
        for (const node of pushedNodes) {
          if (node.id.startsWith('nav.')) continue;
          const simulationNode = simulationNodesRef.current.get(node.id);
          if (!simulationNode) continue;
          simulationNode.x = node.position.x + 15;
          simulationNode.y = node.position.y + 15;
          simulationNode.vx = 0;
          simulationNode.vy = 0;
        }
        return nodesWithNavContainer(
          pushedNodes,
          containerExpandedRef.current,
          containerSelectedRef.current,
          containerFocusedRef.current,
          containerDimmedRef.current,
          toggleNavContainer,
        );
      });
      settleTimer = window.setTimeout(() => setContainerReflowing(false), 340);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      setContainerReflowing(false);
    };
  }, [containerExpanded, setNodes, toggleNavContainer]);

  const onNodesChange = (changes: NodeChange[]) => setNodes((currentNodes) => {
    const nextNodes = applyNodeChanges(changes.filter((change) => !('id' in change) || change.id !== navContainerId), currentNodes);
    const graphFlowNodes = nextNodes.filter((node) => node.id !== navContainerId);
    return nodesWithNavContainer(
      graphFlowNodes,
      containerExpandedRef.current,
      containerSelectedRef.current,
      containerFocusedRef.current,
      containerDimmedRef.current,
      toggleNavContainer,
    );
  });

  const updateDraggedNode = (node: Node) => {
    const simulationNode = simulationNodesRef.current.get(node.id);
    if (!simulationNode) return;
    const x = node.position.x + 15;
    const y = node.position.y + 15;
    simulationNode.x = x;
    simulationNode.y = y;
    simulationNode.fx = x;
    simulationNode.fy = y;
  };

  const moveNavContainer = (node: Node) => {
    const origin = containerDragRef.current;
    if (!origin) return;
    const deltaX = node.position.x - origin.containerPosition.x;
    const deltaY = node.position.y - origin.containerPosition.y;
    setNodes((currentNodes) => {
      const graphFlowNodes = currentNodes
        .filter((currentNode) => currentNode.id !== navContainerId)
        .map((currentNode) => {
          const initialPosition = origin.navPositions.get(currentNode.id);
          if (!initialPosition) return currentNode;
          const position = { x: initialPosition.x + deltaX, y: initialPosition.y + deltaY };
          const simulationNode = simulationNodesRef.current.get(currentNode.id);
          if (simulationNode) {
            simulationNode.x = position.x + 15;
            simulationNode.y = position.y + 15;
            simulationNode.fx = simulationNode.x;
            simulationNode.fy = simulationNode.y;
          }
          return { ...currentNode, position };
        });
      return nodesWithNavContainer(
        graphFlowNodes,
        containerExpandedRef.current,
        containerSelectedRef.current,
        containerFocusedRef.current,
        containerDimmedRef.current,
        toggleNavContainer,
      );
    });
  };

  const onNodeDragStart: OnNodeDrag<Node> = (_event, node) => {
    setContainerReflowing(false);
    if (node.id === navContainerId) {
      containerDragRef.current = {
        containerPosition: { ...node.position },
        navPositions: new Map(nodesRef.current
          .filter((currentNode) => currentNode.id.startsWith('nav.'))
          .map((currentNode) => [currentNode.id, { ...currentNode.position }])),
      };
      const simulation = simulationRef.current;
      simulation?.force('radial', null).force('entry-orbit', null).force('entry-orbit-y', null).force('center', null);
      moveNavContainer(node);
      return;
    }
    updateDraggedNode(node);
    const simulation = simulationRef.current;
    if (simulation) {
      simulation.force('radial', null).force('entry-orbit', null).force('entry-orbit-y', null).force('center', null);
      const linkForce = simulation.force('link') as ForceLink<LayoutNode, LayoutLink> | undefined;
      linkForce?.strength((link) => link.kind === 'nav-cluster' ? 0.1 : link.kind === 'placement' ? 0.07 : 0.18);
      simulation.alpha(Math.max(simulation.alpha(), 0.32)).alphaTarget(0.18).restart();
    }
  };

  const onNodeDrag: OnNodeDrag<Node> = (_event, node) => {
    if (node.id === navContainerId) moveNavContainer(node);
    else updateDraggedNode(node);
  };

  const onNodeDragStop: OnNodeDrag<Node> = (_event, node) => {
    if (node.id === navContainerId) {
      moveNavContainer(node);
      for (const id of containerDragRef.current?.navPositions.keys() || []) {
        const simulationNode = simulationNodesRef.current.get(id);
        if (simulationNode) {
          simulationNode.fx = containerExpandedRef.current ? null : simulationNode.x;
          simulationNode.fy = containerExpandedRef.current ? null : simulationNode.y;
        }
      }
      containerDragRef.current = null;
      simulationRef.current?.alpha(0.12).alphaTarget(0).restart();
      return;
    }
    const simulationNode = simulationNodesRef.current.get(node.id);
    if (!simulationNode) return;
    updateDraggedNode(node);
    simulationNode.fx = null;
    simulationNode.fy = null;
    const simulation = simulationRef.current;
    if (simulation) simulation.alpha(0.14).alphaTarget(0).restart();
  };

  const handleInit = (instance: ReactFlowInstance<Node, Edge>) => {
    flowInstanceRef.current = instance;
    onFitReady(fitGraph);
    window.requestAnimationFrame(() => fitGraph());
  };

  const handleNodeClick = (node: Node) => {
    if (node.id === navContainerId) {
      toggleNavContainer();
      return;
    }
    setContainerSelected(false);
    onNodeClick(node.id);
  };

  const handlePaneClick = () => {
    setContainerSelected(false);
    onPaneClick();
  };

  const directEdgeCount = activeNodeId ? graphEdges.filter((edge) => edge.source === activeNodeId || edge.target === activeNodeId).length : 0;
  const flowEdges = useMemo<Edge[]>(() => graphEdges.flatMap((edge) => {
    const selected = edge.id === selectedEdgeId;
    const hovered = edge.id === hoveredEdgeId;
    const touchesNavContainer = edge.source.startsWith('nav.') || edge.target.startsWith('nav.');
    const connected = activeNodeId ? edge.source === activeNodeId || edge.target === activeNodeId : containerSelected && touchesNavContainer;
    const placement = edge.kind === 'placement';
    const stroke = placement ? '#8a7569' : '#71837a';
    const sourceUsesContainer = !containerExpanded && edge.source.startsWith('nav.');
    const targetUsesContainer = !containerExpanded && edge.target.startsWith('nav.');
    if (sourceUsesContainer && targetUsesContainer) return [];
    return [{
      id: edge.id,
      source: edge.source,
      target: edge.target,
      data: {
        visualSourceId: sourceUsesContainer ? navContainerId : undefined,
        visualTargetId: targetUsesContainer ? navContainerId : undefined,
      },
      type: 'floating',
      label: selected || hovered || (connected && directEdgeCount <= 3) ? edge.label : undefined,
      labelStyle: { fill: '#31443b', fontSize: 9, fontWeight: 650 },
      labelBgStyle: { fill: '#f8faf9', fillOpacity: 0.95 },
      labelBgPadding: [5, 3],
      labelBgBorderRadius: 3,
      markerEnd: { type: MarkerType.ArrowClosed, width: 11, height: 11, color: stroke },
      style: {
        stroke,
        strokeWidth: selected || hovered || connected ? 1.9 : 1.15,
        strokeDasharray: placement ? '6 5' : undefined,
        opacity: activeNodeId && !connected ? 0.1 : activeNodeId && connected ? 0.96 : 0.5,
      },
      selected,
      zIndex: selected || hovered || connected ? 4 : 0,
    }];
  }), [activeNodeId, containerExpanded, containerSelected, directEdgeCount, graphEdges, hoveredEdgeId, selectedEdgeId]);

  return <div className={`kg-force-root ${containerReflowing ? 'container-reflowing' : ''}`} data-layout={compact ? 'compact' : 'wide'} ref={rootRef}><ReactFlow
    nodes={nodes}
    edges={flowEdges}
    nodeTypes={nodeTypes}
    edgeTypes={edgeTypes}
    onNodesChange={onNodesChange}
    onNodeDragStart={onNodeDragStart}
    onNodeDrag={onNodeDrag}
    onNodeDragStop={onNodeDragStop}
    onInit={handleInit}
    onNodeClick={(_event, node) => handleNodeClick(node)}
    onEdgeClick={(_event, edge) => onEdgeClick(edge.id)}
    onNodeMouseEnter={(_event, node) => { if (node.id !== navContainerId) onNodeHover(node.id); }}
    onNodeMouseLeave={() => onNodeHover(null)}
    onEdgeMouseEnter={(_event, edge) => onEdgeHover(edge.id)}
    onEdgeMouseLeave={() => onEdgeHover(null)}
    onPaneClick={handlePaneClick}
    nodesConnectable={false}
    minZoom={0.45}
    maxZoom={2.3}
    proOptions={{ hideAttribution: true }}
  >
    <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#ccd5d1" />
    <Controls showInteractive={false} />
  </ReactFlow></div>;
}
