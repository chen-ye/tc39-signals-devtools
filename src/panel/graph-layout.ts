import type {
  SignalEdgeSnapshot,
  SignalKind,
  SignalNodeSnapshot,
} from "../protocol/types.ts";
import {
  computeHierarchicLayout,
  type LayoutEdgeInput,
  type LayoutNodeInput,
  type LayoutPoint,
} from "../shared/hierarchic-layout.ts";
import {
  formatSemanticTitle,
  smartTruncateToPx,
  splitTwoLineTitle,
  type TwoLineTitle,
} from "../shared/label-format.ts";
import { measureTextPx } from "../shared/text-measure.ts";

export type { LayoutPoint, TwoLineTitle };

export const NODE_WIDTH = 212;
export const NODE_HEIGHT = 72;
export const LAYER_GAP = 88;
export const ROW_GAP = 22;
export const CANVAS_PADDING = 36;

const MIN_CARD_WIDTH = 224;
const MAX_CARD_WIDTH = 296;
const TALL_CARD_HEIGHT = 86;
const DEFAULT_BUS_THRESHOLD = 5;

const TITLE_FONT =
  '600 12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const SUB_FONT =
  '400 11px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
const ID_FONT =
  '400 10px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

export interface BusTrunkSegment {
  readonly busGroupKey: string;
  readonly layerIndex: number;
  readonly sourceId: number;
  readonly kind: SignalKind;
  readonly x: number;
  readonly yStart: number;
  readonly yEnd: number;
  readonly path: string;
  readonly memberEdgeIds: ReadonlyArray<string>;
}

export interface BusJunctionPoint {
  readonly x: number;
  readonly y: number;
  readonly kind: SignalKind;
  readonly busGroupKey?: string;
}

export interface PositionedNode {
  readonly node: SignalNodeSnapshot;
  readonly layer: number;
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly formattedTitle?: string;
  readonly formattedTitleLines?: TwoLineTitle;
  readonly subtitleLabel?: string | null;
  readonly isCompact?: boolean;
  readonly componentIndex?: number;
  readonly isIsolated?: boolean;
}

export interface RoutedEdge {
  readonly id?: string;
  readonly sourceId: number;
  readonly sinkId: number;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly path: string;
  readonly points?: ReadonlyArray<LayoutPoint>;
  readonly isFeedback?: boolean;
  readonly isBusMember?: boolean;
  readonly busGroupKey?: string | null;
}

export interface GraphLayout {
  readonly nodes: ReadonlyArray<PositionedNode>;
  readonly edges: ReadonlyArray<RoutedEdge>;
  readonly nodeById: ReadonlyMap<number, PositionedNode>;
  readonly width: number;
  readonly height: number;
  readonly layerCount: number;
  readonly busTrunks?: ReadonlyArray<BusTrunkSegment>;
  readonly junctions?: ReadonlyArray<BusJunctionPoint>;
}

interface PreparedNodeMeta {
  readonly node: SignalNodeSnapshot;
  readonly width: number;
  readonly height: number;
  readonly formattedTitle: string;
  readonly formattedTitleLines: TwoLineTitle;
  readonly subtitleLabel: string | null;
  readonly isCompact: boolean;
}

const KIND_ORDER: Record<SignalKind, number> = {
  state: 0,
  computed: 1,
  watcher: 2,
};

function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value));
}

function compareNodes(a: SignalNodeSnapshot, b: SignalNodeSnapshot): number {
  const kindDiff = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (kindDiff !== 0) return kindDiff;
  return a.id - b.id;
}

function pickRawNodeTitle(node: SignalNodeSnapshot): string {
  const explicit = node.label?.trim();
  if (explicit && explicit.length > 0) return explicit;

  const auto = node.autoLabel?.trim();
  if (auto && auto.length > 0) return auto;

  const rawFn = node.site?.fn?.trim();
  if (rawFn && rawFn.length > 0) {
    const cleaned = rawFn
      .replace(/\.<instance_members_initializer>/g, "")
      .replace(/<instance_members_initializer>/g, "")
      .replace(/^Object\./, "")
      .trim();
    if (
      cleaned.length > 0 &&
      cleaned !== "<anonymous>" &&
      !/^new\s*$/i.test(cleaned)
    ) {
      return cleaned;
    }
  }

  return `${node.kind} #${node.id}`;
}

function prepareNodeMeta(node: SignalNodeSnapshot): PreparedNodeMeta {
  const rawTitle = pickRawNodeTitle(node);
  const semantic = formatSemanticTitle(rawTitle, {
    ownerLabel: node.ownerLabel ?? null,
  });

  const badgeAndLeftPad = node.kind === "state" ? 36 : 33;
  const rightEdgeInset = node.kind === "watcher" ? 15 : 11;
  const idReserve =
    Math.ceil(measureTextPx(`#${node.id}`, ID_FONT)) + 8 + rightEdgeInset;
  const horizontalReserve = badgeAndLeftPad + idReserve;

  const titleNeed =
    measureTextPx(semantic.title, TITLE_FONT) + horizontalReserve;
  const subSample = semantic.ownerLabel ?? node.value?.text ?? "";
  const subNeed = subSample
    ? Math.min(276, measureTextPx(subSample, SUB_FONT) + 32)
    : 0;

  const cardWidth = clamp(
    MIN_CARD_WIDTH,
    MAX_CARD_WIDTH,
    Math.ceil(Math.max(MIN_CARD_WIDTH, titleNeed, subNeed)),
  );
  const availTitlePx = Math.max(40, cardWidth - horizontalReserve);

  const formattedTitle = smartTruncateToPx(
    semantic.title,
    availTitlePx,
    TITLE_FONT,
    semantic.disambiguator,
  );
  const formattedTitleLines = splitTwoLineTitle(
    semantic.title,
    availTitlePx,
    TITLE_FONT,
    semantic.disambiguator,
  );
  const cardHeight =
    formattedTitleLines.line2 !== null ? TALL_CARD_HEIGHT : NODE_HEIGHT;

  return {
    node,
    width: cardWidth,
    height: cardHeight,
    formattedTitle,
    formattedTitleLines,
    subtitleLabel: semantic.ownerLabel,
    isCompact: false,
  };
}

function computeSemanticLayerHints(
  nodes: ReadonlyArray<SignalNodeSnapshot>,
  nodeMap: ReadonlyMap<number, SignalNodeSnapshot>,
  validEdges: ReadonlyArray<SignalEdgeSnapshot>,
): ReadonlyMap<number, number> {
  const outgoing = new Map<number, number[]>();
  const incoming = new Map<number, number[]>();
  const inDegree = new Map<number, number>();

  for (const node of nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
    inDegree.set(node.id, 0);
  }

  for (const edge of validEdges) {
    outgoing.get(edge.sourceId)?.push(edge.sinkId);
    incoming.get(edge.sinkId)?.push(edge.sourceId);
    inDegree.set(edge.sinkId, (inDegree.get(edge.sinkId) ?? 0) + 1);
  }

  const layerById = new Map<number, number>();
  const queue: number[] = [];
  for (const node of nodes) {
    if ((inDegree.get(node.id) ?? 0) === 0) {
      queue.push(node.id);
      layerById.set(node.id, 0);
    }
  }
  queue.sort((a, b) => compareNodes(nodeMap.get(a)!, nodeMap.get(b)!));

  const processed = new Set<number>();
  let cursor = 0;
  while (cursor < queue.length) {
    const id = queue[cursor++]!;
    processed.add(id);
    const currentLayer = layerById.get(id) ?? 0;

    for (const sinkId of outgoing.get(id) ?? []) {
      const nextLayer = Math.max(layerById.get(sinkId) ?? 0, currentLayer + 1);
      layerById.set(sinkId, nextLayer);
      const deg = (inDegree.get(sinkId) ?? 0) - 1;
      inDegree.set(sinkId, deg);
      if (deg === 0) {
        queue.push(sinkId);
      }
    }
  }

  if (processed.size < nodes.length) {
    const remaining = nodes
      .filter((n) => !processed.has(n.id))
      .toSorted(compareNodes);
    for (const node of remaining) {
      let maxIn = -1;
      for (const srcId of incoming.get(node.id) ?? []) {
        const srcLayer = layerById.get(srcId);
        if (srcLayer !== undefined && srcLayer > maxIn) {
          maxIn = srcLayer;
        }
      }
      layerById.set(node.id, maxIn + 1);
    }
  }

  const hasStates = nodes.some((n) => n.kind === "state");
  const hasNonWatcherSignals = nodes.some((n) => n.kind !== "watcher");
  const hasIncoming = (id: number) => (incoming.get(id)?.length ?? 0) > 0;

  let maxSignalLayer = 0;
  for (const node of nodes) {
    if (node.kind === "computed" && !hasIncoming(node.id) && hasStates) {
      layerById.set(node.id, Math.max(layerById.get(node.id) ?? 0, 1));
    }
    if (node.kind !== "watcher") {
      const l = layerById.get(node.id) ?? 0;
      if (l > maxSignalLayer) maxSignalLayer = l;
    }
  }

  const minLayerHintById = new Map<number, number>();
  for (const node of nodes) {
    let hint = 0;
    if (node.kind === "computed" && !hasIncoming(node.id) && hasStates) {
      hint = 1;
    } else if (
      node.kind === "watcher" &&
      !hasIncoming(node.id) &&
      hasNonWatcherSignals
    ) {
      hint = maxSignalLayer + 1;
    }
    minLayerHintById.set(node.id, hint);
  }

  return minLayerHintById;
}

function layoutDisconnectedColumns(
  nodes: ReadonlyArray<SignalNodeSnapshot>,
  metaById: ReadonlyMap<number, PreparedNodeMeta>,
  minLayerHintById: ReadonlyMap<number, number>,
): GraphLayout {
  let maxLayer = 0;
  for (const node of nodes) {
    const l = minLayerHintById.get(node.id) ?? 0;
    if (l > maxLayer) maxLayer = l;
  }

  const layers: PreparedNodeMeta[][] = Array.from(
    { length: maxLayer + 1 },
    () => [],
  );
  for (const node of nodes) {
    const l = minLayerHintById.get(node.id) ?? 0;
    const meta = metaById.get(node.id);
    if (meta) layers[l]?.push(meta);
  }

  const nonEmptyLayers = layers.filter((layer) => layer.length > 0);
  for (const layerNodes of nonEmptyLayers) {
    layerNodes.sort((a, b) => compareNodes(a.node, b.node));
  }

  const colWidths = nonEmptyLayers.map((layerNodes) => {
    let maxW = MIN_CARD_WIDTH;
    for (const m of layerNodes) {
      if (m.width > maxW) maxW = m.width;
    }
    return maxW;
  });

  const colHeights = nonEmptyLayers.map((layerNodes) => {
    let totalH = Math.max(0, layerNodes.length - 1) * ROW_GAP;
    for (const m of layerNodes) {
      totalH += m.height;
    }
    return totalH;
  });

  let maxColumnHeight = 0;
  for (const h of colHeights) {
    if (h > maxColumnHeight) maxColumnHeight = h;
  }

  const colX: number[] = [];
  let cursorX = CANVAS_PADDING;
  for (let l = 0; l < nonEmptyLayers.length; l++) {
    colX.push(cursorX);
    cursorX += (colWidths[l] ?? MIN_CARD_WIDTH) + LAYER_GAP;
  }

  const positionedNodes: PositionedNode[] = [];
  const nodeById = new Map<number, PositionedNode>();

  for (let l = 0; l < nonEmptyLayers.length; l++) {
    const layerNodes = nonEmptyLayers[l]!;
    const colW = colWidths[l] ?? MIN_CARD_WIDTH;
    const colH = colHeights[l] ?? 0;
    const x = colX[l] ?? CANVAS_PADDING;
    let y = CANVAS_PADDING + Math.round((maxColumnHeight - colH) / 2);

    for (let r = 0; r < layerNodes.length; r++) {
      const meta = layerNodes[r]!;
      const positioned: PositionedNode = {
        node: meta.node,
        layer: l,
        row: r,
        x,
        y,
        width: colW,
        height: meta.height,
        formattedTitle: meta.formattedTitle,
        formattedTitleLines: meta.formattedTitleLines,
        subtitleLabel: meta.subtitleLabel,
        isCompact: meta.isCompact,
        componentIndex: 0,
        isIsolated: true,
      };
      positionedNodes.push(positioned);
      nodeById.set(meta.node.id, positioned);
      y += meta.height + ROW_GAP;
    }
  }

  const totalColumnsWidth = colWidths.reduce((sum, w) => sum + w, 0);
  const width =
    CANVAS_PADDING * 2 +
    totalColumnsWidth +
    Math.max(0, nonEmptyLayers.length - 1) * LAYER_GAP;
  const height = CANVAS_PADDING * 2 + maxColumnHeight;

  return {
    nodes: positionedNodes,
    edges: [],
    nodeById,
    width,
    height,
    layerCount: nonEmptyLayers.length,
    busTrunks: [],
    junctions: [],
  };
}

export function computeGraphLayout(
  nodes: ReadonlyArray<SignalNodeSnapshot>,
  edges: ReadonlyArray<SignalEdgeSnapshot>,
): GraphLayout {
  if (nodes.length === 0) {
    return {
      nodes: [],
      edges: [],
      nodeById: new Map(),
      width: CANVAS_PADDING * 2,
      height: CANVAS_PADDING * 2,
      layerCount: 0,
      busTrunks: [],
      junctions: [],
    };
  }

  const nodeMap = new Map<number, SignalNodeSnapshot>();
  const metaById = new Map<number, PreparedNodeMeta>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
    metaById.set(node.id, prepareNodeMeta(node));
  }

  const validEdges: SignalEdgeSnapshot[] = [];
  for (const edge of edges) {
    if (edge.sourceId === edge.sinkId) continue;
    if (!nodeMap.has(edge.sourceId) || !nodeMap.has(edge.sinkId)) continue;
    validEdges.push(edge);
  }

  const minLayerHintById = computeSemanticLayerHints(
    nodes,
    nodeMap,
    validEdges,
  );

  // Preserve State / unread Computed / idle Watcher column alignment when graph has no edges
  if (validEdges.length === 0) {
    return layoutDisconnectedColumns(nodes, metaById, minLayerHintById);
  }

  const layoutNodes: LayoutNodeInput[] = nodes.map((node) => {
    const meta = metaById.get(node.id)!;
    const minLayerHint = minLayerHintById.get(node.id) ?? 0;
    return {
      id: node.id,
      width: meta.width,
      height: meta.height,
      sortGroup: KIND_ORDER[node.kind],
      minLayerHint,
    };
  });

  const seenEdgePairCount = new Map<string, number>();
  const edgeSourceById = new Map<string, number>();
  const layoutEdges: LayoutEdgeInput[] = validEdges.map((edge) => {
    const baseKey = `${edge.sourceId}->${edge.sinkId}`;
    const count = (seenEdgePairCount.get(baseKey) ?? 0) + 1;
    seenEdgePairCount.set(baseKey, count);
    const id = count === 1 ? baseKey : `${baseKey}:${count}`;
    edgeSourceById.set(id, edge.sourceId);

    const srcKind = nodeMap.get(edge.sourceId)?.kind;
    const dstKind = nodeMap.get(edge.sinkId)?.kind;
    const priority =
      srcKind === "state" && dstKind !== "state"
        ? 3
        : dstKind === "watcher" && srcKind !== "watcher"
          ? 2
          : 1;

    return {
      id,
      sourceId: edge.sourceId,
      targetId: edge.sinkId,
      priority,
      busGroupKey: `fanout:${edge.sourceId}`,
      weight: 1,
      minSpan: 1,
    };
  });

  const rawLayout = computeHierarchicLayout(layoutNodes, layoutEdges, {
    padding: CANVAS_PADDING,
    minLayerGap: LAYER_GAP,
    nodeSpacingY: ROW_GAP,
    componentGap: 56,
    busThreshold: DEFAULT_BUS_THRESHOLD,
    cornerRadius: 8,
    uniformColumnWidth: true,
  });

  const positionedNodes: PositionedNode[] = [];
  const nodeById = new Map<number, PositionedNode>();

  for (const pn of rawLayout.nodes) {
    const meta = metaById.get(pn.id)!;
    const positioned: PositionedNode = {
      node: meta.node,
      layer: pn.layer,
      row: pn.row,
      x: pn.x,
      y: pn.y,
      width: pn.width,
      height: pn.height,
      formattedTitle: meta.formattedTitle,
      formattedTitleLines: meta.formattedTitleLines,
      subtitleLabel: meta.subtitleLabel,
      isCompact: meta.isCompact,
      componentIndex: pn.componentIndex,
      isIsolated: pn.isIsolated,
    };
    positionedNodes.push(positioned);
    nodeById.set(pn.id, positioned);
  }

  const routedEdges: RoutedEdge[] = rawLayout.edges.map((re) => ({
    id: re.id,
    sourceId: re.sourceId,
    sinkId: re.targetId,
    x1: re.x1,
    y1: re.y1,
    x2: re.x2,
    y2: re.y2,
    path: re.path,
    points: re.points,
    isFeedback: re.isFeedback,
    isBusMember: re.isBusMember,
    busGroupKey: re.busGroupKey,
  }));

  const trunkKindByKey = new Map<string, SignalKind>();
  const busTrunks: BusTrunkSegment[] = rawLayout.busTrunks.map((bt) => {
    const firstMemberId = bt.memberEdgeIds[0];
    const origSourceId =
      firstMemberId !== undefined
        ? edgeSourceById.get(firstMemberId)
        : undefined;
    const kind: SignalKind =
      nodeMap.get(bt.sourceId)?.kind ??
      (origSourceId !== undefined
        ? nodeMap.get(origSourceId)?.kind
        : undefined) ??
      "state";
    trunkKindByKey.set(bt.busGroupKey, kind);
    return {
      busGroupKey: bt.busGroupKey,
      layerIndex: bt.layerIndex,
      sourceId: bt.sourceId,
      kind,
      x: bt.x,
      yStart: bt.yStart,
      yEnd: bt.yEnd,
      path: bt.path,
      memberEdgeIds: bt.memberEdgeIds,
    };
  });

  const junctions: BusJunctionPoint[] = rawLayout.junctions.map((j) => ({
    x: j.x,
    y: j.y,
    kind: trunkKindByKey.get(j.busGroupKey) ?? "state",
    busGroupKey: j.busGroupKey,
  }));

  return {
    nodes: positionedNodes,
    edges: routedEdges,
    nodeById,
    width: rawLayout.width,
    height: rawLayout.height,
    layerCount: rawLayout.layerCount,
    busTrunks,
    junctions,
  };
}
