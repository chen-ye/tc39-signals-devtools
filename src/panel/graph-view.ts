import type { SignalKind, SignalNodeSnapshot } from "../protocol/types.ts";
import {
  GraphViewportController,
  findNearestDirectionalNode,
} from "../shared/graph-viewport.ts";
import { smartTruncateToPx } from "../shared/label-format.ts";
import {
  type BusJunctionPoint,
  type BusTrunkSegment,
  type GraphLayout,
  type PositionedNode,
  type RoutedEdge,
} from "./graph-layout.ts";
import { formatNodeDisplayName, type PanelViewModel } from "./graph-state.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
const GRID_STEP = 20;
const TITLE_FONT =
  '600 12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const VALUE_FONT =
  '400 11px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

export interface GraphViewCallbacks {
  readonly onSelectNode: (nodeId: number | null) => void;
  readonly onZoomChange: (scale: number) => void;
}

interface NodeDomRefs {
  readonly group: SVGGElement;
  readonly kind: SignalKind;
  readonly width: number;
  readonly height: number;
  readonly hasTwoLines: boolean;
  readonly searchRing: SVGElement;
  readonly titleEl: SVGTitleElement;
  readonly nameText: SVGTextElement;
  readonly idText: SVGTextElement;
  readonly valueText: SVGTextElement;
  readonly liveDot: SVGCircleElement;
  readonly liveLabel: SVGTextElement;
  readonly rightMetaText: SVGTextElement;
  readonly inlineCauseText: SVGTextElement | null;
  readonly flagGroup: SVGGElement;
  readonly flagRect: SVGRectElement;
  readonly flagText: SVGTextElement;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Readonly<Record<string, string | number>>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      el.setAttribute(key, String(value));
    }
  }
  return el;
}

function formatDurationShort(ms: number): string {
  if (ms < 0.05) return "<0.1ms";
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms)}ms`;
}

function createArrowMarker(id: string, className: string): SVGMarkerElement {
  const marker = svgEl("marker", {
    id,
    viewBox: "0 0 10 10",
    refX: 9.2,
    refY: 5,
    markerWidth: 8,
    markerHeight: 8,
    orient: "auto-start-reverse",
    markerUnits: "userSpaceOnUse",
  });
  marker.appendChild(
    svgEl("path", {
      d: "M 1 1.6 L 9.2 5 L 1 8.4 Z",
      class: className,
    }),
  );
  return marker;
}

function buildNodeTooltip(
  node: SignalNodeSnapshot,
  incomingCount: number,
  subtitleLabel?: string | null,
): string {
  const displayName = formatNodeDisplayName(node);
  const parts: string[] = [
    `${displayName} (#${node.id} · ${node.kind})`,
    `Runtime: ${node.runtime} (${node.runtimeMode}) · ${node.live ? "live" : "cold"}`,
  ];
  if (subtitleLabel && subtitleLabel !== displayName) {
    parts.push(`Owner: ${subtitleLabel}`);
  }
  if (node.error !== null) {
    parts.push(`Error: ${node.error}`);
  } else if (node.kind === "watcher") {
    parts.push(
      `Watching ${incomingCount} signal${incomingCount === 1 ? "" : "s"} · notifies: ${node.notifies}`,
    );
  } else if (node.unread) {
    parts.push("Value: (unread)");
  } else if (node.value) {
    parts.push(`Value: ${node.value.text}`);
  }
  if (node.site) {
    const fnPart = node.site.fn ? `${node.site.fn} @ ` : "";
    parts.push(
      `Site: ${fnPart}${node.site.file}:${node.site.line}:${node.site.column}`,
    );
  }
  return parts.join("\n");
}

function createNodeElement(pos: PositionedNode): NodeDomRefs {
  const { node, width: w, height: h } = pos;
  const hasTwoLines = (pos.formattedTitleLines?.line2 ?? null) !== null;

  const group = svgEl("g", {
    class: "graph-node",
    tabindex: "0",
    role: "button",
    "data-node-id": node.id,
    "data-kind": node.kind,
    "data-testid": `graph-node-${node.id}`,
  });

  const titleEl = svgEl("title");
  group.appendChild(titleEl);

  let searchRing: SVGElement;

  if (node.kind === "state") {
    // Rounded rectangle with crisp left accent bar
    searchRing = svgEl("rect", {
      class: "node-search-ring",
      fill: "none",
      x: -5,
      y: -5,
      width: w + 10,
      height: h + 10,
      rx: 10,
      ry: 10,
    });
    searchRing.style.display = "none";
    group.appendChild(searchRing);
    group.appendChild(
      svgEl("rect", {
        class: "node-focus-ring",
        x: -3,
        y: -3,
        width: w + 6,
        height: h + 6,
        rx: 8,
        ry: 8,
      }),
    );
    group.appendChild(
      svgEl("rect", {
        class: "node-card",
        x: 0,
        y: 0,
        width: w,
        height: h,
        rx: 6,
        ry: 6,
      }),
    );
    group.appendChild(
      svgEl("path", {
        class: "node-accent-bar",
        d: `M 6 0.6 L 5.5 0.6 A 5.4 5.4 0 0 0 0.6 6 L 0.6 ${h - 6} A 5.4 5.4 0 0 0 5.5 ${h - 0.6} L 6 ${h - 0.6} Z`,
      }),
    );
    group.appendChild(
      svgEl("rect", {
        class: "node-badge-bg",
        x: 13,
        y: 10,
        width: 17,
        height: 17,
        rx: 3.5,
      }),
    );
    const badgeText = svgEl("text", {
      class: "node-badge-text",
      x: 21.5,
      y: 22,
      "text-anchor": "middle",
    });
    badgeText.textContent = "S";
    group.appendChild(badgeText);
    group.appendChild(
      svgEl("circle", { class: "node-port", cx: w, cy: h / 2, r: 3 }),
    );
  } else if (node.kind === "computed") {
    // Chamfered precision card with beveled badge
    const bevel = 9;
    searchRing = svgEl("path", {
      class: "node-search-ring",
      fill: "none",
      d: `M ${bevel - 2} -5 L ${w - bevel + 2} -5 L ${w + 5} ${bevel - 2} L ${w + 5} ${h - bevel + 2} L ${w - bevel + 2} ${h + 5} L ${bevel - 2} ${h + 5} L -5 ${h - bevel + 2} L -5 ${bevel - 2} Z`,
    });
    searchRing.style.display = "none";
    group.appendChild(searchRing);
    group.appendChild(
      svgEl("path", {
        class: "node-focus-ring",
        d: `M ${bevel - 1} -3 L ${w - bevel + 1} -3 L ${w + 3} ${bevel - 1} L ${w + 3} ${h - bevel + 1} L ${w - bevel + 1} ${h + 3} L ${bevel - 1} ${h + 3} L -3 ${h - bevel + 1} L -3 ${bevel - 1} Z`,
      }),
    );
    group.appendChild(
      svgEl("path", {
        class: "node-card",
        d: `M ${bevel} 0 L ${w - bevel} 0 L ${w} ${bevel} L ${w} ${h - bevel} L ${w - bevel} ${h} L ${bevel} ${h} L 0 ${h - bevel} L 0 ${bevel} Z`,
      }),
    );
    group.appendChild(
      svgEl("path", {
        class: "node-badge-bg",
        d: "M 14 10 L 23 10 L 27 14 L 27 23 L 23 27 L 14 27 L 10 23 L 10 14 Z",
      }),
    );
    const badgeText = svgEl("text", {
      class: "node-badge-text",
      x: 18.5,
      y: 22,
      "text-anchor": "middle",
    });
    badgeText.textContent = "C";
    group.appendChild(badgeText);
    group.appendChild(
      svgEl("circle", { class: "node-port", cx: 0, cy: h / 2, r: 3 }),
    );
    group.appendChild(
      svgEl("circle", { class: "node-port", cx: w, cy: h / 2, r: 3 }),
    );
  } else {
    // Terminal / sink card with notched right terminal rail
    searchRing = svgEl("path", {
      class: "node-search-ring",
      fill: "none",
      d: `M 6 -5 L ${w - 6} -5 L ${w + 5} 8 L ${w + 5} ${h - 8} L ${w - 6} ${h + 5} L 6 ${h + 5} A 10.5 10.5 0 0 1 -5 ${h - 6} L -5 6 A 10.5 10.5 0 0 1 6 -5 Z`,
    });
    searchRing.style.display = "none";
    group.appendChild(searchRing);
    group.appendChild(
      svgEl("path", {
        class: "node-focus-ring",
        d: `M 6 -3 L ${w - 7} -3 L ${w + 3} 9 L ${w + 3} ${h - 9} L ${w - 7} ${h + 3} L 6 ${h + 3} A 8.5 8.5 0 0 1 -3 ${h - 6} L -3 6 A 8.5 8.5 0 0 1 6 -3 Z`,
      }),
    );
    group.appendChild(
      svgEl("path", {
        class: "node-card",
        d: `M 6 0 L ${w - 8} 0 L ${w} 10 L ${w} ${h - 10} L ${w - 8} ${h} L 6 ${h} A 6 6 0 0 1 0 ${h - 6} L 0 6 A 6 6 0 0 1 6 0 Z`,
      }),
    );
    group.appendChild(
      svgEl("path", {
        class: "node-sink-rail",
        d: `M ${w - 8} 0.6 L ${w - 0.6} 10 L ${w - 0.6} ${h - 10} L ${w - 8} ${h - 0.6} Z`,
      }),
    );
    group.appendChild(
      svgEl("circle", {
        class: "node-badge-bg",
        cx: 18.5,
        cy: 18.5,
        r: 8.5,
      }),
    );
    const badgeText = svgEl("text", {
      class: "node-badge-text",
      x: 18.5,
      y: 22,
      "text-anchor": "middle",
    });
    badgeText.textContent = "W";
    group.appendChild(badgeText);
    group.appendChild(
      svgEl("circle", { class: "node-port", cx: 0, cy: h / 2, r: 3 }),
    );
  }

  const leftPad = node.kind === "state" ? 13 : 11;
  const rightEdge = node.kind === "watcher" ? w - 15 : w - 11;
  const titleX = node.kind === "state" ? 36 : 33;
  const titleY = hasTwoLines ? 17 : 22;
  const valueY = hasTwoLines ? 52 : 43;
  const dividerY = hasTwoLines ? h - 21 : 51;
  const footerY = hasTwoLines ? h - 7 : 65;

  const nameText = svgEl("text", {
    class: "node-title",
    x: titleX,
    y: titleY,
  });
  group.appendChild(nameText);

  const idText = svgEl("text", {
    class: "node-id",
    x: rightEdge,
    y: titleY,
    "text-anchor": "end",
  });
  group.appendChild(idText);

  const valueText = svgEl("text", {
    class: "node-value",
    x: leftPad,
    y: valueY,
  });
  group.appendChild(valueText);

  group.appendChild(
    svgEl("line", {
      class: "node-divider",
      x1: leftPad,
      y1: dividerY,
      x2: rightEdge,
      y2: dividerY,
    }),
  );

  const liveDot = svgEl("circle", {
    class: "node-live-dot",
    cx: leftPad + 3.5,
    cy: footerY - 3.5,
    r: 3,
  });
  group.appendChild(liveDot);

  const liveLabel = svgEl("text", {
    class: "node-meta",
    x: leftPad + 11,
    y: footerY,
  });
  group.appendChild(liveLabel);

  let inlineCauseText: SVGTextElement | null = null;
  if (node.kind === "computed") {
    inlineCauseText = svgEl("text", {
      class: "node-cause-inline",
      x: leftPad + 44,
      y: footerY,
    });
    group.appendChild(inlineCauseText);
  }

  const rightMetaText = svgEl("text", {
    class: "node-meta-num",
    x: rightEdge,
    y: footerY,
    "text-anchor": "end",
  });
  group.appendChild(rightMetaText);

  // Top-right status pill (CAUSE or ERR)
  const flagGroup = svgEl("g", {
    class: "node-flag",
    transform: `translate(${rightEdge - 37}, -8)`,
  });
  flagGroup.style.display = "none";
  const flagRect = svgEl("rect", {
    class: "node-flag-bg",
    x: 0,
    y: 0,
    width: 42,
    height: 15,
    rx: 3,
  });
  const flagText = svgEl("text", {
    class: "node-flag-text",
    x: 21,
    y: 10.5,
    "text-anchor": "middle",
  });
  flagGroup.appendChild(flagRect);
  flagGroup.appendChild(flagText);
  group.appendChild(flagGroup);

  return {
    group,
    kind: node.kind,
    width: w,
    height: h,
    hasTwoLines,
    searchRing,
    titleEl,
    nameText,
    idText,
    valueText,
    liveDot,
    liveLabel,
    rightMetaText,
    inlineCauseText,
    flagGroup,
    flagRect,
    flagText,
  };
}

export class GraphView {
  readonly #stageEl: HTMLElement;
  readonly #callbacks: GraphViewCallbacks;
  readonly #svg: SVGSVGElement;
  readonly #gridPattern: SVGPatternElement;
  readonly #viewportGroup: SVGGElement;
  readonly #edgesGroup: SVGGElement;
  readonly #busLayer: SVGGElement;
  readonly #nodesGroup: SVGGElement;
  readonly #viewport: GraphViewportController;
  readonly #nodeRefs = new Map<number, NodeDomRefs>();
  readonly #resizeObserver: ResizeObserver;
  readonly #unbindPan: () => void;
  readonly #unbindWheel: () => void;

  #hasAutoFitted = false;
  #pendingAutoFit = false;
  #busRenderKey = "";
  #lastVm: PanelViewModel | null = null;
  #lastLayout: GraphLayout | null = null;
  #lastFocusNodeId: number | null = null;
  #lastNodeCount = 0;

  constructor(
    stageEl: HTMLElement,
    mountEl: HTMLElement,
    callbacks: GraphViewCallbacks,
  ) {
    this.#stageEl = stageEl;
    this.#callbacks = callbacks;

    this.#svg = svgEl("svg", {
      class: "graph-svg",
      "data-testid": "graph-svg",
      role: "region",
      "aria-label": "Signal reactivity graph",
      tabindex: "0",
    });

    const defs = svgEl("defs");

    this.#gridPattern = svgEl("pattern", {
      id: "graph-grid-pattern",
      width: GRID_STEP,
      height: GRID_STEP,
      patternUnits: "userSpaceOnUse",
    });
    this.#gridPattern.appendChild(
      svgEl("circle", {
        class: "graph-grid-dot",
        cx: 1,
        cy: 1,
        r: 1,
      }),
    );
    defs.appendChild(this.#gridPattern);

    defs.appendChild(createArrowMarker("arrow-default", "marker-default"));
    defs.appendChild(createArrowMarker("arrow-upstream", "marker-upstream"));
    defs.appendChild(
      createArrowMarker("arrow-downstream", "marker-downstream"),
    );
    defs.appendChild(createArrowMarker("arrow-cause", "marker-cause"));
    defs.appendChild(createArrowMarker("arrow-dim", "marker-dim"));
    this.#svg.appendChild(defs);

    const gridBg = svgEl("rect", {
      class: "graph-grid-bg",
      x: 0,
      y: 0,
      width: "100%",
      height: "100%",
      fill: "url(#graph-grid-pattern)",
    });
    this.#svg.appendChild(gridBg);

    this.#viewportGroup = svgEl("g", { class: "graph-viewport" });
    this.#edgesGroup = svgEl("g", { class: "graph-edges" });
    this.#busLayer = svgEl("g", { class: "graph-bus-layer" });
    this.#edgesGroup.appendChild(this.#busLayer);
    this.#nodesGroup = svgEl("g", { class: "graph-nodes" });
    this.#viewportGroup.appendChild(this.#edgesGroup);
    this.#viewportGroup.appendChild(this.#nodesGroup);
    this.#svg.appendChild(this.#viewportGroup);

    mountEl.replaceChildren(this.#svg);

    this.#viewport = new GraphViewportController({
      onChange: () => {
        this.#applyTransform();
      },
    });

    this.#unbindPan = this.#viewport.bindPointerPan(this.#svg, {
      shouldIgnoreTarget: (target) =>
        target instanceof Element && target.closest(".graph-node") !== null,
    });
    this.#unbindWheel = this.#viewport.bindWheelZoom(this.#svg, {
      getViewportOrigin: () => this.#stageEl.getBoundingClientRect(),
    });

    this.#svg.addEventListener("click", this.#onClick);
    this.#svg.addEventListener("dblclick", this.#onDoubleClick);
    this.#svg.addEventListener("keydown", this.#onKeyDown);

    this.#resizeObserver = new ResizeObserver(() => {
      if (
        (this.#pendingAutoFit || !this.#viewport.userTransformed) &&
        this.#lastLayout &&
        this.#lastLayout.nodes.length > 0
      ) {
        if (
          this.#stageEl.clientWidth >= 20 &&
          this.#stageEl.clientHeight >= 20
        ) {
          this.fitToViewport();
        }
      }
    });
    this.#resizeObserver.observe(this.#stageEl);
    this.#applyTransform();
  }

  render(vm: PanelViewModel, activeSearchMatchId: number | null = null): void {
    const prevFocusId = this.#lastFocusNodeId;
    const prevNodeCount = this.#lastNodeCount;

    const activeElement = document.activeElement;
    const focusedNodeAttr =
      activeElement instanceof SVGElement &&
      this.#nodesGroup.contains(activeElement)
        ? activeElement.getAttribute("data-node-id")
        : null;
    const keyboardFocusNodeId =
      focusedNodeAttr !== null ? Number(focusedNodeAttr) : null;

    const layout = vm.layout;
    this.#lastVm = vm;
    this.#lastLayout = layout;
    this.#lastFocusNodeId = vm.focusedNode?.id ?? null;
    this.#lastNodeCount = layout.nodes.length;

    const incomingCountById = new Map<number, number>();
    if (vm.snapshot) {
      for (const edge of vm.snapshot.edges) {
        incomingCountById.set(
          edge.sinkId,
          (incomingCountById.get(edge.sinkId) ?? 0) + 1,
        );
      }
    }

    this.#renderEdges(layout, vm);
    this.#renderNodes(layout.nodes, vm, incomingCountById, activeSearchMatchId);

    if (keyboardFocusNodeId !== null && Number.isFinite(keyboardFocusNodeId)) {
      const target = this.#nodeRefs.get(keyboardFocusNodeId)?.group;
      if (target) {
        if (document.activeElement !== target) {
          target.focus({ preventScroll: true });
        }
      } else {
        this.#svg.focus({ preventScroll: true });
      }
    }

    const focusChanged = prevFocusId !== this.#lastFocusNodeId;
    const becamePopulated = prevNodeCount === 0 && layout.nodes.length > 0;
    if (
      layout.nodes.length > 0 &&
      (!this.#hasAutoFitted || becamePopulated || focusChanged)
    ) {
      if (!this.#viewport.userTransformed || focusChanged || becamePopulated) {
        this.fitToViewport();
      } else {
        this.#applyTransform();
      }
    } else {
      this.#applyTransform();
    }
  }

  fitToViewport(): void {
    const layout = this.#lastLayout;
    if (!layout || layout.nodes.length === 0) {
      this.#pendingAutoFit = false;
      this.#viewport.resetZoom();
      return;
    }

    const stageW = this.#stageEl.clientWidth;
    const stageH = this.#stageEl.clientHeight;
    if (stageW < 20 || stageH < 20) {
      this.#pendingAutoFit = true;
      return;
    }

    const pad = 24;
    const availW = Math.max(1, stageW - pad * 2);
    const availH = Math.max(1, stageH - pad * 2);
    const isCompactGraph =
      Boolean(this.#lastVm?.focusedNode) || layout.nodes.length <= 40;
    const minScaleFloor = isCompactGraph
      ? Math.max(
          0.25,
          Math.min(0.56, availW / layout.width, availH / layout.height),
        )
      : 0.56;

    let anchor = this.#lastVm?.selectedNode
      ? layout.nodeById.get(this.#lastVm.selectedNode.id)
      : undefined;
    if (!anchor) {
      let bestScore = -1;
      for (const candidate of layout.nodes) {
        const score =
          candidate.node.sets + candidate.node.runs + candidate.node.notifies;
        if (!anchor || score > bestScore) {
          bestScore = score;
          anchor = candidate;
        }
      }
    }

    const fitted = this.#viewport.fitToRect(
      { x: 0, y: 0, width: layout.width, height: layout.height },
      { width: stageW, height: stageH },
      {
        padding: pad,
        minScale: minScaleFloor,
        maxScale: 1.15,
        ...(anchor
          ? {
              anchorRect: {
                x: anchor.x,
                y: anchor.y,
                width: anchor.width,
                height: anchor.height,
              },
              anchorBiasX: 0.36,
              anchorBiasY: 0.5,
            }
          : {}),
        markUserTransformed: false,
      },
    );

    if (fitted) {
      this.#hasAutoFitted = true;
      this.#pendingAutoFit = false;
    } else {
      this.#pendingAutoFit = true;
    }
  }

  zoomBy(factor: number): void {
    this.#viewport.zoomAtCenter(
      {
        width: this.#stageEl.clientWidth,
        height: this.#stageEl.clientHeight,
      },
      factor,
    );
  }

  resetZoom(): void {
    this.#viewport.resetZoom();
  }

  panToNode(nodeId: number): void {
    const pos = this.#lastLayout?.nodeById.get(nodeId);
    if (!pos) return;
    const stageW = this.#stageEl.clientWidth;
    const stageH = this.#stageEl.clientHeight;
    if (stageW < 20 || stageH < 20) return;

    const scale = this.#viewport.scale;
    const tx = this.#viewport.tx;
    const ty = this.#viewport.ty;
    const screenLeft = pos.x * scale + tx;
    const screenTop = pos.y * scale + ty;
    const screenRight = (pos.x + pos.width) * scale + tx;
    const screenBottom = (pos.y + pos.height) * scale + ty;

    const margin = 36;
    if (
      screenLeft >= margin &&
      screenTop >= margin &&
      screenRight <= stageW - margin &&
      screenBottom <= stageH - 52
    ) {
      return;
    }

    this.#viewport.centerOnRect(
      { x: pos.x, y: pos.y, width: pos.width, height: pos.height },
      { width: stageW, height: stageH },
      { markUserTransformed: true },
    );
  }

  dispose(): void {
    this.#resizeObserver.disconnect();
    this.#unbindPan();
    this.#unbindWheel();
    this.#svg.removeEventListener("click", this.#onClick);
    this.#svg.removeEventListener("dblclick", this.#onDoubleClick);
    this.#svg.removeEventListener("keydown", this.#onKeyDown);
  }

  #renderEdges(layout: GraphLayout, vm: PanelViewModel): void {
    const selectedId =
      vm.selectedNode && vm.visibleNodeIds.has(vm.selectedNode.id)
        ? vm.selectedNode.id
        : null;

    interface ClassifiedEdge {
      readonly edge: RoutedEdge;
      readonly edgeKey: string;
      readonly priority: number;
      readonly relation: "upstream" | "downstream" | null;
      readonly causal: boolean;
      readonly highlighted: boolean;
      readonly dimmed: boolean;
      readonly markerId: string;
    }

    const highlightedEdgeIds = new Set<string>();
    const dimmedEdgeIds = new Set<string>();
    const edgeRelationById = new Map<string, "upstream" | "downstream">();

    const classified: ClassifiedEdge[] = layout.edges.map((edge) => {
      const edgeKey = edge.id ?? `${edge.sourceId}->${edge.sinkId}`;

      if (selectedId === null) {
        const isDimmed =
          vm.isHighlightQueryActive &&
          !vm.searchMatchIds.has(edge.sourceId) &&
          !vm.searchMatchIds.has(edge.sinkId);
        if (isDimmed) {
          dimmedEdgeIds.add(edgeKey);
          return {
            edge,
            edgeKey,
            priority: 0,
            relation: null,
            causal: false,
            highlighted: false,
            dimmed: true,
            markerId: "arrow-dim",
          };
        }
        return {
          edge,
          edgeKey,
          priority: 1,
          relation: null,
          causal: false,
          highlighted: false,
          dimmed: false,
          markerId: "arrow-default",
        };
      }

      const isCausal =
        edge.sinkId === selectedId && vm.directCauseIds.has(edge.sourceId);
      if (isCausal) {
        highlightedEdgeIds.add(edgeKey);
        edgeRelationById.set(edgeKey, "upstream");
        return {
          edge,
          edgeKey,
          priority: 3,
          relation: "upstream",
          causal: true,
          highlighted: true,
          dimmed: false,
          markerId: "arrow-cause",
        };
      }

      const isUpstream =
        (edge.sinkId === selectedId || vm.upstreamIds.has(edge.sinkId)) &&
        vm.upstreamIds.has(edge.sourceId);
      if (isUpstream) {
        highlightedEdgeIds.add(edgeKey);
        edgeRelationById.set(edgeKey, "upstream");
        return {
          edge,
          edgeKey,
          priority: 2,
          relation: "upstream",
          causal: false,
          highlighted: true,
          dimmed: false,
          markerId: "arrow-upstream",
        };
      }

      const isDownstream =
        (edge.sourceId === selectedId || vm.downstreamIds.has(edge.sourceId)) &&
        vm.downstreamIds.has(edge.sinkId);
      if (isDownstream) {
        highlightedEdgeIds.add(edgeKey);
        edgeRelationById.set(edgeKey, "downstream");
        return {
          edge,
          edgeKey,
          priority: 2,
          relation: "downstream",
          causal: false,
          highlighted: true,
          dimmed: false,
          markerId: "arrow-downstream",
        };
      }

      dimmedEdgeIds.add(edgeKey);
      return {
        edge,
        edgeKey,
        priority: 0,
        relation: null,
        causal: false,
        highlighted: false,
        dimmed: true,
        markerId: "arrow-dim",
      };
    });

    const busTrunks = layout.busTrunks ?? [];
    const junctions = layout.junctions ?? [];
    const trunkByEdgeId = new Map<string, BusTrunkSegment>();
    for (const trunk of busTrunks) {
      for (const edgeId of trunk.memberEdgeIds) {
        trunkByEdgeId.set(edgeId, trunk);
      }
    }

    this.#renderBusLayer(
      busTrunks,
      junctions,
      highlightedEdgeIds,
      dimmedEdgeIds,
      edgeRelationById,
    );

    classified.sort((a, b) => a.priority - b.priority);

    const frag = document.createDocumentFragment();
    for (const item of classified) {
      const effectivePath = this.#resolveEdgePath(
        layout,
        item.edge,
        item.edgeKey,
        item.highlighted,
        trunkByEdgeId,
      );
      const pathEl = svgEl("path", {
        class: "graph-edge",
        d: effectivePath,
        "marker-end": `url(#${item.markerId})`,
        "data-source-id": item.edge.sourceId,
        "data-sink-id": item.edge.sinkId,
      });
      if (item.relation) {
        pathEl.setAttribute("data-relation", item.relation);
      }
      if (item.causal) {
        pathEl.setAttribute("data-causal", "true");
      }
      if (item.dimmed) {
        pathEl.setAttribute("data-dimmed", "true");
      }
      if (item.edge.isFeedback) {
        pathEl.setAttribute("data-feedback", "true");
      }
      frag.appendChild(pathEl);
    }

    this.#edgesGroup.replaceChildren(this.#busLayer, frag);
  }

  #resolveEdgePath(
    layout: GraphLayout,
    edge: RoutedEdge,
    edgeKey: string,
    isHighlighted: boolean,
    trunkByEdgeId: ReadonlyMap<string, BusTrunkSegment>,
  ): string {
    if (!edge.isBusMember || isHighlighted || !edge.points) {
      return edge.path;
    }
    const trunk = trunkByEdgeId.get(edgeKey);
    if (!trunk) return edge.path;

    const srcPos = layout.nodeById.get(edge.sourceId);
    const dstPos = layout.nodeById.get(edge.sinkId);
    if (
      !srcPos ||
      !dstPos ||
      srcPos.isIsolated ||
      dstPos.isIsolated ||
      srcPos.layer !== trunk.layerIndex ||
      dstPos.layer !== trunk.layerIndex + 1
    ) {
      return edge.path;
    }

    const pts = edge.points;
    const penultimate = pts.length >= 2 ? pts[pts.length - 2] : undefined;
    const yTap =
      penultimate && Math.abs(penultimate.x - trunk.x) < 1
        ? penultimate.y
        : edge.y2;
    return `M ${trunk.x} ${yTap} L ${edge.x2} ${edge.y2}`;
  }

  #renderBusLayer(
    busTrunks: ReadonlyArray<BusTrunkSegment>,
    junctions: ReadonlyArray<BusJunctionPoint>,
    highlightedEdgeIds: ReadonlySet<string>,
    dimmedEdgeIds: ReadonlySet<string>,
    edgeRelationById: ReadonlyMap<string, "upstream" | "downstream">,
  ): void {
    const trunkStates = busTrunks.map((trunk) => {
      let anyHighlighted = false;
      let anyDimmed = false;
      let anyPlainVisible = false;
      let sharedRelation: "upstream" | "downstream" | null = null;
      let mixedRelation = false;
      for (const edgeId of trunk.memberEdgeIds) {
        const hl = highlightedEdgeIds.has(edgeId);
        const dm = dimmedEdgeIds.has(edgeId);
        if (hl) {
          anyHighlighted = true;
          const rel = edgeRelationById.get(edgeId) ?? null;
          if (!rel) {
            mixedRelation = true;
          } else if (sharedRelation === null) {
            sharedRelation = rel;
          } else if (sharedRelation !== rel) {
            mixedRelation = true;
          }
        }
        if (dm) anyDimmed = true;
        if (!hl && !dm) anyPlainVisible = true;
      }
      const isHighlighted = anyHighlighted && !anyDimmed;
      const isDimmed =
        trunk.memberEdgeIds.length > 0 &&
        !isHighlighted &&
        ((anyDimmed && !anyPlainVisible) ||
          trunk.memberEdgeIds.every((id) => dimmedEdgeIds.has(id)));
      const relation = isHighlighted && !mixedRelation ? sharedRelation : null;
      return { trunk, isHighlighted, isDimmed, relation };
    });

    const junctionStateByKey = new Map<
      string,
      {
        hasHighlighted: boolean;
        hasVisible: boolean;
        relation: "upstream" | "downstream" | null;
        mixedRelation: boolean;
      }
    >();
    for (const st of trunkStates) {
      const existing = junctionStateByKey.get(st.trunk.busGroupKey) ?? {
        hasHighlighted: false,
        hasVisible: false,
        relation: null,
        mixedRelation: false,
      };
      if (st.isHighlighted) {
        existing.hasHighlighted = true;
        if (!st.relation) {
          existing.mixedRelation = true;
        } else if (existing.relation === null) {
          existing.relation = st.relation;
        } else if (existing.relation !== st.relation) {
          existing.mixedRelation = true;
        }
      }
      if (!st.isDimmed) existing.hasVisible = true;
      junctionStateByKey.set(st.trunk.busGroupKey, existing);
    }

    const keyParts: string[] = [];
    for (const st of trunkStates) {
      keyParts.push(
        `T:${st.trunk.busGroupKey}:${st.trunk.kind}:${st.trunk.path}:${st.isHighlighted ? 1 : 0}:${st.isDimmed ? 1 : 0}:${st.relation ?? ""}`,
      );
    }
    for (const j of junctions) {
      const jState = j.busGroupKey
        ? junctionStateByKey.get(j.busGroupKey)
        : undefined;
      const isHl = jState?.hasHighlighted ?? false;
      const isDm = jState ? !jState.hasVisible : false;
      const jRel =
        jState && isHl && !jState.mixedRelation ? jState.relation : null;
      keyParts.push(
        `J:${j.x}:${j.y}:${j.kind}:${isHl ? 1 : 0}:${isDm ? 1 : 0}:${jRel ?? ""}`,
      );
    }
    const nextKey = keyParts.join("\u0001");
    if (nextKey === this.#busRenderKey) return;
    this.#busRenderKey = nextKey;

    if (busTrunks.length === 0 && junctions.length === 0) {
      this.#busLayer.replaceChildren();
      return;
    }

    const children: SVGElement[] = [];
    for (const st of trunkStates) {
      const classes = ["graph-bus-trunk"];
      if (st.isHighlighted) classes.push("is-highlighted");
      if (st.isDimmed) classes.push("is-dimmed");
      const trunkEl = svgEl("path", {
        class: classes.join(" "),
        fill: "none",
        d: st.trunk.path,
        "data-kind": st.trunk.kind,
      });
      if (st.isHighlighted) {
        trunkEl.setAttribute("data-highlighted", "true");
      }
      if (st.relation) {
        trunkEl.setAttribute("data-relation", st.relation);
      }
      if (st.isDimmed) {
        trunkEl.setAttribute("data-dimmed", "true");
      }
      children.push(trunkEl);
    }

    for (const j of junctions) {
      const jState = j.busGroupKey
        ? junctionStateByKey.get(j.busGroupKey)
        : undefined;
      const isHl = jState?.hasHighlighted ?? false;
      const isDm = jState ? !jState.hasVisible : false;
      const jRel =
        jState && isHl && !jState.mixedRelation ? jState.relation : null;
      const classes = ["graph-bus-junction"];
      if (isHl) classes.push("is-highlighted");
      if (isDm) classes.push("is-dimmed");
      const junctionEl = svgEl("circle", {
        class: classes.join(" "),
        stroke: "none",
        cx: j.x,
        cy: j.y,
        r: 2.8,
        "data-kind": j.kind,
      });
      if (isHl) {
        junctionEl.setAttribute("data-highlighted", "true");
      }
      if (jRel) {
        junctionEl.setAttribute("data-relation", jRel);
      }
      if (isDm) {
        junctionEl.setAttribute("data-dimmed", "true");
      }
      children.push(junctionEl);
    }

    this.#busLayer.replaceChildren(...children);
  }

  #renderNodes(
    positioned: ReadonlyArray<PositionedNode>,
    vm: PanelViewModel,
    incomingCountById: ReadonlyMap<number, number>,
    activeSearchMatchId: number | null,
  ): void {
    const selectedId =
      vm.selectedNode && vm.visibleNodeIds.has(vm.selectedNode.id)
        ? vm.selectedNode.id
        : null;
    const activeIds = new Set<number>();

    for (const pos of positioned) {
      const node = pos.node;
      activeIds.add(node.id);
      const hasTwoLines = (pos.formattedTitleLines?.line2 ?? null) !== null;

      let refs = this.#nodeRefs.get(node.id);
      if (
        !refs ||
        refs.kind !== node.kind ||
        refs.width !== pos.width ||
        refs.height !== pos.height ||
        refs.hasTwoLines !== hasTwoLines
      ) {
        const nextRefs = createNodeElement(pos);
        if (refs) {
          refs.group.replaceWith(nextRefs.group);
        } else {
          this.#nodesGroup.appendChild(nextRefs.group);
        }
        refs = nextRefs;
        this.#nodeRefs.set(node.id, refs);
      }

      refs.group.setAttribute("transform", `translate(${pos.x}, ${pos.y})`);

      const isSelected = selectedId === node.id;
      const isCause = selectedId !== null && vm.directCauseIds.has(node.id);
      const isUpstream = selectedId !== null && vm.upstreamIds.has(node.id);
      const isDownstream = selectedId !== null && vm.downstreamIds.has(node.id);
      const isSearchMatch =
        vm.isHighlightQueryActive && vm.searchMatchIds.has(node.id);
      const isActiveMatch =
        activeSearchMatchId !== null &&
        activeSearchMatchId === node.id &&
        vm.searchMatchIds.has(node.id);
      const isDimmed =
        selectedId !== null
          ? !isSelected &&
            !isUpstream &&
            !isDownstream &&
            !isCause &&
            !isSearchMatch
          : vm.isHighlightQueryActive && !isSearchMatch;

      refs.group.setAttribute("aria-pressed", String(isSelected));
      refs.group.setAttribute("data-selected", String(isSelected));
      refs.group.setAttribute("data-error", String(node.error !== null));

      if (isCause) {
        refs.group.setAttribute("data-relation", "cause");
      } else if (isUpstream) {
        refs.group.setAttribute("data-relation", "upstream");
      } else if (isDownstream) {
        refs.group.setAttribute("data-relation", "downstream");
      } else {
        refs.group.removeAttribute("data-relation");
      }

      if (isSearchMatch) {
        refs.group.setAttribute("data-search-match", "true");
      } else {
        refs.group.removeAttribute("data-search-match");
      }

      if (isActiveMatch) {
        refs.group.setAttribute("data-active-match", "true");
      } else {
        refs.group.removeAttribute("data-active-match");
      }

      refs.searchRing.style.display =
        isSearchMatch || isActiveMatch ? "" : "none";

      if (isDimmed) {
        refs.group.setAttribute("data-dimmed", "true");
      } else {
        refs.group.removeAttribute("data-dimmed");
      }

      const w = pos.width;
      const leftPad = node.kind === "state" ? 13 : 11;
      const rightEdge = node.kind === "watcher" ? w - 15 : w - 11;
      const titleX = node.kind === "state" ? 36 : 33;
      const displayName = formatNodeDisplayName(node);
      const incomingCount = incomingCountById.get(node.id) ?? 0;

      refs.group.setAttribute(
        "aria-label",
        `${displayName}, ${node.kind} signal #${node.id}, ${node.live ? "live" : "cold"}${node.error ? `, error: ${node.error}` : ""}`,
      );
      refs.titleEl.textContent = buildNodeTooltip(
        node,
        incomingCount,
        pos.subtitleLabel,
      );

      const idLabel = `#${node.id}`;
      refs.idText.textContent = idLabel;

      const titleLines = pos.formattedTitleLines;
      if (titleLines && titleLines.line2 !== null) {
        const tspan1 = svgEl("tspan", { x: titleX, y: 17 });
        tspan1.textContent = titleLines.line1;
        const tspan2 = svgEl("tspan", { x: titleX, dy: 13 });
        tspan2.textContent = titleLines.line2;
        refs.nameText.replaceChildren(tspan1, tspan2);
      } else {
        const singleTitle =
          pos.formattedTitle ??
          titleLines?.line1 ??
          smartTruncateToPx(
            displayName,
            Math.max(40, rightEdge - titleX - 36),
            TITLE_FONT,
          );
        refs.nameText.textContent = singleTitle;
      }

      // Value / status line
      const availValuePx = Math.max(80, rightEdge - leftPad);
      refs.valueText.setAttribute("class", "node-value");
      if (node.error !== null) {
        refs.valueText.textContent = smartTruncateToPx(
          `! ${node.error}`,
          availValuePx,
          VALUE_FONT,
        );
        refs.valueText.classList.add("is-error");
      } else if (node.kind === "watcher") {
        refs.valueText.textContent =
          incomingCount > 0
            ? `watching ${incomingCount} signal${incomingCount === 1 ? "" : "s"}`
            : "watching 0 signals";
      } else if (node.unread) {
        refs.valueText.textContent = "(unread)";
        refs.valueText.classList.add("is-unread");
      } else if (node.value) {
        refs.valueText.textContent = smartTruncateToPx(
          node.value.text,
          availValuePx,
          VALUE_FONT,
        );
        if (
          node.value.kind === "number" ||
          node.value.kind === "string" ||
          node.value.kind === "boolean"
        ) {
          refs.valueText.classList.add(`is-${node.value.kind}`);
        }
      } else {
        refs.valueText.textContent = "—";
      }

      // Liveness & footer metrics
      const isActive = node.kind === "watcher" ? incomingCount > 0 : node.live;
      refs.liveDot.classList.toggle("is-live", isActive);
      refs.liveLabel.textContent =
        node.kind === "watcher"
          ? incomingCount > 0
            ? "watching"
            : "idle"
          : node.live
            ? "live"
            : "cold";

      if (node.kind === "state") {
        refs.rightMetaText.textContent = `sets ${node.sets}`;
      } else if (node.kind === "computed") {
        const msPart =
          node.lastRunMs !== null
            ? ` · ${formatDurationShort(node.lastRunMs)}`
            : "";
        refs.rightMetaText.textContent = `runs ${node.runs}${msPart}`;
        if (refs.inlineCauseText) {
          refs.inlineCauseText.textContent =
            node.causes.length > 0 ? `←${node.causes.length}` : "";
        }
      } else {
        refs.rightMetaText.textContent = `notifies ${node.notifies}`;
      }

      // Floating status tag (ERR takes precedence, then CAUSE when selected computed blames this node)
      if (node.error !== null) {
        refs.flagGroup.style.display = "";
        refs.flagRect.setAttribute("class", "node-flag-bg is-error");
        refs.flagRect.setAttribute("width", "34");
        refs.flagGroup.setAttribute(
          "transform",
          `translate(${rightEdge - 34}, -8)`,
        );
        refs.flagText.setAttribute("x", "17");
        refs.flagText.textContent = "ERR";
      } else if (isCause) {
        refs.flagGroup.style.display = "";
        refs.flagRect.setAttribute("class", "node-flag-bg is-cause");
        refs.flagRect.setAttribute("width", "44");
        refs.flagGroup.setAttribute(
          "transform",
          `translate(${rightEdge - 44}, -8)`,
        );
        refs.flagText.setAttribute("x", "22");
        refs.flagText.textContent = "CAUSE";
      } else {
        refs.flagGroup.style.display = "none";
      }
    }

    for (const [id, refs] of this.#nodeRefs.entries()) {
      if (!activeIds.has(id)) {
        refs.group.remove();
        this.#nodeRefs.delete(id);
      }
    }
  }

  #applyTransform(): void {
    const scale = this.#viewport.scale;
    const tx = this.#viewport.tx;
    const ty = this.#viewport.ty;
    this.#viewportGroup.setAttribute(
      "transform",
      this.#viewport.getSvgTransformAttribute(),
    );
    this.#gridPattern.setAttribute(
      "patternTransform",
      `translate(${tx.toFixed(1)} ${ty.toFixed(1)}) scale(${scale.toFixed(4)})`,
    );
    const isZoomedOut =
      (scale < 0.45 && (this.#lastLayout?.edges.length ?? 0) > 40) ||
      scale < 0.34;
    this.#svg.classList.toggle("is-zoomed-out", isZoomedOut);
    this.#callbacks.onZoomChange(scale);
  }

  #findNodeIdFromTarget(target: EventTarget | null): number | null {
    if (!(target instanceof Element)) return null;
    const nodeEl = target.closest(".graph-node");
    if (!nodeEl) return null;
    const raw = nodeEl.getAttribute("data-node-id");
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  readonly #onClick = (event: MouseEvent): void => {
    const clickedNodeId = this.#findNodeIdFromTarget(event.target);
    const didPanMove = this.#viewport.consumeDidPanMove();
    if (clickedNodeId !== null) {
      this.#callbacks.onSelectNode(clickedNodeId);
      this.#nodeRefs.get(clickedNodeId)?.group.focus({ preventScroll: true });
      return;
    }
    if (didPanMove) {
      return;
    }
    this.#callbacks.onSelectNode(null);
  };

  readonly #onDoubleClick = (event: MouseEvent): void => {
    if (this.#findNodeIdFromTarget(event.target) === null) {
      this.fitToViewport();
    }
  };

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const layout = this.#lastLayout;
    const focusedId = this.#findNodeIdFromTarget(event.target);

    if (!layout || layout.nodes.length === 0) return;

    const currentId =
      focusedId ??
      this.#lastVm?.selectedNode?.id ??
      layout.nodes[0]?.node.id ??
      null;
    if (currentId === null) return;

    if (event.key === "Enter" || event.key === " ") {
      if (focusedId === null) return;
      event.preventDefault();
      this.#callbacks.onSelectNode(focusedId);
      return;
    }

    if (
      event.key === "ArrowRight" ||
      event.key === "ArrowLeft" ||
      event.key === "ArrowUp" ||
      event.key === "ArrowDown"
    ) {
      event.preventDefault();
      if (focusedId === null && this.#lastVm?.selectedNode == null) {
        this.#callbacks.onSelectNode(currentId);
        this.#nodeRefs.get(currentId)?.group.focus({ preventScroll: true });
        this.panToNode(currentId);
        return;
      }

      const directionalNodes = layout.nodes.map((n) => ({
        id: n.node.id,
        x: n.x,
        y: n.y,
        width: n.width,
        height: n.height,
      }));
      const nextId = findNearestDirectionalNode(
        directionalNodes,
        currentId,
        event.key,
      );
      if (nextId !== null) {
        this.#callbacks.onSelectNode(nextId);
        this.#nodeRefs.get(nextId)?.group.focus({ preventScroll: true });
        this.panToNode(nextId);
      }
    }
  };
}
