import {
  NODE_HEIGHT,
  NODE_WIDTH,
  type GraphLayout,
  type PositionedNode,
  type RoutedEdge,
} from "./graph-layout.ts";
import { formatNodeDisplayName, type PanelViewModel } from "./graph-state.ts";
import type { SignalKind, SignalNodeSnapshot } from "../protocol/types.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;
const GRID_STEP = 20;

export interface GraphViewCallbacks {
  readonly onSelectNode: (nodeId: number | null) => void;
  readonly onZoomChange: (scale: number) => void;
}

interface NodeDomRefs {
  readonly group: SVGGElement;
  readonly kind: SignalKind;
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

interface PanSession {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly originTx: number;
  readonly originTy: number;
  readonly clickedNodeId: number | null;
  dragging: boolean;
  captured: boolean;
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
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
): string {
  const parts: string[] = [
    `${formatNodeDisplayName(node)} (#${node.id} · ${node.kind})`,
    `Runtime: ${node.runtime} (${node.runtimeMode}) · ${node.live ? "live" : "cold"}`,
  ];
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

function createNodeElement(node: SignalNodeSnapshot): NodeDomRefs {
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

  const w = NODE_WIDTH;
  const h = NODE_HEIGHT;

  if (node.kind === "state") {
    // Rounded rectangle with crisp left accent bar
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

  const nameText = svgEl("text", {
    class: "node-title",
    x: titleX,
    y: 22,
  });
  group.appendChild(nameText);

  const idText = svgEl("text", {
    class: "node-id",
    x: rightEdge,
    y: 22,
    "text-anchor": "end",
  });
  group.appendChild(idText);

  const valueText = svgEl("text", {
    class: "node-value",
    x: leftPad,
    y: 43,
  });
  group.appendChild(valueText);

  group.appendChild(
    svgEl("line", {
      class: "node-divider",
      x1: leftPad,
      y1: 51,
      x2: rightEdge,
      y2: 51,
    }),
  );

  const liveDot = svgEl("circle", {
    class: "node-live-dot",
    cx: leftPad + 3.5,
    cy: 61.5,
    r: 3,
  });
  group.appendChild(liveDot);

  const liveLabel = svgEl("text", {
    class: "node-meta",
    x: leftPad + 11,
    y: 65,
  });
  group.appendChild(liveLabel);

  let inlineCauseText: SVGTextElement | null = null;
  if (node.kind === "computed") {
    inlineCauseText = svgEl("text", {
      class: "node-cause-inline",
      x: leftPad + 44,
      y: 65,
    });
    group.appendChild(inlineCauseText);
  }

  const rightMetaText = svgEl("text", {
    class: "node-meta-num",
    x: rightEdge,
    y: 65,
    "text-anchor": "end",
  });
  group.appendChild(rightMetaText);

  // Top-right status pill (CAUSE or ERR)
  const flagGroup = svgEl("g", {
    class: "node-flag",
    transform: `translate(${w - 48}, -9)`,
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
  readonly #nodesGroup: SVGGElement;
  readonly #nodeRefs = new Map<number, NodeDomRefs>();
  readonly #resizeObserver: ResizeObserver;

  #tx = 0;
  #ty = 0;
  #scale = 1;
  #hasAutoFitted = false;
  #pendingAutoFit = false;
  #lastLayout: GraphLayout | null = null;
  #panSession: PanSession | null = null;

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
    this.#nodesGroup = svgEl("g", { class: "graph-nodes" });
    this.#viewportGroup.appendChild(this.#edgesGroup);
    this.#viewportGroup.appendChild(this.#nodesGroup);
    this.#svg.appendChild(this.#viewportGroup);

    mountEl.replaceChildren(this.#svg);

    this.#svg.addEventListener("pointerdown", this.#onPointerDown);
    this.#svg.addEventListener("pointermove", this.#onPointerMove);
    this.#svg.addEventListener("pointerup", this.#onPointerUp);
    this.#svg.addEventListener("pointercancel", this.#onPointerCancel);
    this.#svg.addEventListener("wheel", this.#onWheel, { passive: false });
    this.#svg.addEventListener("dblclick", this.#onDoubleClick);
    this.#svg.addEventListener("keydown", this.#onKeyDown);

    this.#resizeObserver = new ResizeObserver(() => {
      if (
        this.#pendingAutoFit &&
        this.#lastLayout &&
        this.#lastLayout.nodes.length > 0
      ) {
        if (this.#stageEl.clientWidth > 0 && this.#stageEl.clientHeight > 0) {
          this.#pendingAutoFit = false;
          this.#hasAutoFitted = true;
          this.fitToViewport();
        }
      }
    });
    this.#resizeObserver.observe(this.#stageEl);
    this.#applyTransform();
  }

  render(vm: PanelViewModel): void {
    const layout = vm.layout;
    this.#lastLayout = layout;

    const incomingCountById = new Map<number, number>();
    if (vm.snapshot) {
      for (const edge of vm.snapshot.edges) {
        incomingCountById.set(
          edge.sinkId,
          (incomingCountById.get(edge.sinkId) ?? 0) + 1,
        );
      }
    }

    this.#renderEdges(layout.edges, vm);
    this.#renderNodes(layout.nodes, vm, incomingCountById);

    if (layout.nodes.length > 0 && !this.#hasAutoFitted) {
      if (this.#stageEl.clientWidth > 0 && this.#stageEl.clientHeight > 0) {
        this.#hasAutoFitted = true;
        this.#pendingAutoFit = false;
        this.fitToViewport();
      } else {
        this.#pendingAutoFit = true;
      }
    }
  }

  fitToViewport(): void {
    const layout = this.#lastLayout;
    if (!layout || layout.nodes.length === 0) {
      this.#tx = 0;
      this.#ty = 0;
      this.#scale = 1;
      this.#applyTransform();
      return;
    }

    const stageW = this.#stageEl.clientWidth;
    const stageH = this.#stageEl.clientHeight;
    if (stageW <= 0 || stageH <= 0) {
      this.#pendingAutoFit = true;
      return;
    }

    const padX = 28;
    const padTop = 24;
    const padBottom = 46;
    const availW = Math.max(80, stageW - padX * 2);
    const availH = Math.max(80, stageH - padTop - padBottom);

    const nextScale = clamp(
      Math.min(availW / layout.width, availH / layout.height),
      MIN_SCALE,
      1.15,
    );
    const contentW = layout.width * nextScale;
    const contentH = layout.height * nextScale;

    this.#scale = nextScale;
    this.#tx = Math.round((stageW - contentW) / 2);
    this.#ty = Math.round(padTop + (availH - contentH) / 2);
    this.#applyTransform();
  }

  zoomBy(factor: number): void {
    const stageW = this.#stageEl.clientWidth;
    const stageH = this.#stageEl.clientHeight;
    this.#zoomAtPoint(stageW / 2, stageH / 2, factor);
  }

  resetZoom(): void {
    const stageW = this.#stageEl.clientWidth;
    const stageH = this.#stageEl.clientHeight;
    const cx = stageW / 2;
    const cy = stageH / 2;
    const wx = (cx - this.#tx) / this.#scale;
    const wy = (cy - this.#ty) / this.#scale;
    this.#scale = 1;
    this.#tx = Math.round(cx - wx);
    this.#ty = Math.round(cy - wy);
    this.#applyTransform();
  }

  panToNode(nodeId: number): void {
    const pos = this.#lastLayout?.nodeById.get(nodeId);
    if (!pos) return;
    const stageW = this.#stageEl.clientWidth;
    const stageH = this.#stageEl.clientHeight;
    if (stageW <= 0 || stageH <= 0) return;

    const screenLeft = pos.x * this.#scale + this.#tx;
    const screenTop = pos.y * this.#scale + this.#ty;
    const screenRight = (pos.x + pos.width) * this.#scale + this.#tx;
    const screenBottom = (pos.y + pos.height) * this.#scale + this.#ty;

    const margin = 36;
    if (
      screenLeft >= margin &&
      screenTop >= margin &&
      screenRight <= stageW - margin &&
      screenBottom <= stageH - 52
    ) {
      return;
    }

    const nodeCenterX = pos.x + pos.width / 2;
    const nodeCenterY = pos.y + pos.height / 2;
    this.#tx = Math.round(stageW / 2 - nodeCenterX * this.#scale);
    this.#ty = Math.round(stageH / 2 - nodeCenterY * this.#scale);
    this.#applyTransform();
  }

  dispose(): void {
    this.#resizeObserver.disconnect();
    this.#svg.removeEventListener("pointerdown", this.#onPointerDown);
    this.#svg.removeEventListener("pointermove", this.#onPointerMove);
    this.#svg.removeEventListener("pointerup", this.#onPointerUp);
    this.#svg.removeEventListener("pointercancel", this.#onPointerCancel);
    this.#svg.removeEventListener("wheel", this.#onWheel);
    this.#svg.removeEventListener("dblclick", this.#onDoubleClick);
    this.#svg.removeEventListener("keydown", this.#onKeyDown);
  }

  #renderEdges(edges: ReadonlyArray<RoutedEdge>, vm: PanelViewModel): void {
    const selectedId = vm.selectedNode?.id ?? null;

    interface ClassifiedEdge {
      readonly edge: RoutedEdge;
      readonly priority: number;
      readonly relation: "upstream" | "downstream" | null;
      readonly causal: boolean;
      readonly dimmed: boolean;
      readonly markerId: string;
    }

    const classified: ClassifiedEdge[] = edges.map((edge) => {
      if (selectedId === null) {
        return {
          edge,
          priority: 1,
          relation: null,
          causal: false,
          dimmed: false,
          markerId: "arrow-default",
        };
      }

      const isCausal =
        edge.sinkId === selectedId && vm.directCauseIds.has(edge.sourceId);
      if (isCausal) {
        return {
          edge,
          priority: 3,
          relation: "upstream",
          causal: true,
          dimmed: false,
          markerId: "arrow-cause",
        };
      }

      const isUpstream =
        (edge.sinkId === selectedId || vm.upstreamIds.has(edge.sinkId)) &&
        vm.upstreamIds.has(edge.sourceId);
      if (isUpstream) {
        return {
          edge,
          priority: 2,
          relation: "upstream",
          causal: false,
          dimmed: false,
          markerId: "arrow-upstream",
        };
      }

      const isDownstream =
        (edge.sourceId === selectedId || vm.downstreamIds.has(edge.sourceId)) &&
        vm.downstreamIds.has(edge.sinkId);
      if (isDownstream) {
        return {
          edge,
          priority: 2,
          relation: "downstream",
          causal: false,
          dimmed: false,
          markerId: "arrow-downstream",
        };
      }

      return {
        edge,
        priority: 0,
        relation: null,
        causal: false,
        dimmed: true,
        markerId: "arrow-dim",
      };
    });

    classified.sort((a, b) => a.priority - b.priority);

    const frag = document.createDocumentFragment();
    for (const item of classified) {
      const pathEl = svgEl("path", {
        class: "graph-edge",
        d: item.edge.path,
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
      frag.appendChild(pathEl);
    }

    this.#edgesGroup.replaceChildren(frag);
  }

  #renderNodes(
    positioned: ReadonlyArray<PositionedNode>,
    vm: PanelViewModel,
    incomingCountById: ReadonlyMap<number, number>,
  ): void {
    const selectedId = vm.selectedNode?.id ?? null;
    const activeIds = new Set<number>();

    for (const pos of positioned) {
      const node = pos.node;
      activeIds.add(node.id);

      let refs = this.#nodeRefs.get(node.id);
      if (!refs || refs.kind !== node.kind) {
        if (refs) {
          refs.group.remove();
        }
        refs = createNodeElement(node);
        this.#nodeRefs.set(node.id, refs);
        this.#nodesGroup.appendChild(refs.group);
      }

      refs.group.setAttribute("transform", `translate(${pos.x}, ${pos.y})`);

      const isSelected = selectedId === node.id;
      const isCause = selectedId !== null && vm.directCauseIds.has(node.id);
      const isUpstream = selectedId !== null && vm.upstreamIds.has(node.id);
      const isDownstream = selectedId !== null && vm.downstreamIds.has(node.id);
      const isDimmed =
        selectedId !== null &&
        !isSelected &&
        !isUpstream &&
        !isDownstream &&
        !isCause;

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

      if (isDimmed) {
        refs.group.setAttribute("data-dimmed", "true");
      } else {
        refs.group.removeAttribute("data-dimmed");
      }

      const displayName = formatNodeDisplayName(node);
      const incomingCount = incomingCountById.get(node.id) ?? 0;

      refs.group.setAttribute(
        "aria-label",
        `${displayName}, ${node.kind} signal #${node.id}, ${node.live ? "live" : "cold"}${node.error ? `, error: ${node.error}` : ""}`,
      );
      refs.titleEl.textContent = buildNodeTooltip(node, incomingCount);

      const idLabel = `#${node.id}`;
      const maxTitleChars = Math.max(10, 21 - idLabel.length);
      refs.nameText.textContent = truncateChars(displayName, maxTitleChars);
      refs.idText.textContent = idLabel;

      // Value / status line
      refs.valueText.setAttribute("class", "node-value");
      if (node.error !== null) {
        refs.valueText.textContent = truncateChars(`! ${node.error}`, 26);
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
        refs.valueText.textContent = truncateChars(node.value.text, 27);
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
          `translate(${NODE_WIDTH - 42}, -8)`,
        );
        refs.flagText.setAttribute("x", "17");
        refs.flagText.textContent = "ERR";
      } else if (isCause) {
        refs.flagGroup.style.display = "";
        refs.flagRect.setAttribute("class", "node-flag-bg is-cause");
        refs.flagRect.setAttribute("width", "44");
        refs.flagGroup.setAttribute(
          "transform",
          `translate(${NODE_WIDTH - 52}, -8)`,
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
    this.#viewportGroup.setAttribute(
      "transform",
      `translate(${this.#tx}, ${this.#ty}) scale(${this.#scale})`,
    );
    this.#gridPattern.setAttribute(
      "patternTransform",
      `translate(${this.#tx} ${this.#ty}) scale(${this.#scale})`,
    );
    this.#callbacks.onZoomChange(this.#scale);
  }

  #zoomAtPoint(px: number, py: number, factor: number): void {
    const nextScale = clamp(this.#scale * factor, MIN_SCALE, MAX_SCALE);
    if (nextScale === this.#scale) return;
    const wx = (px - this.#tx) / this.#scale;
    const wy = (py - this.#ty) / this.#scale;
    this.#scale = nextScale;
    this.#tx = px - wx * nextScale;
    this.#ty = py - wy * nextScale;
    this.#applyTransform();
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

  readonly #onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const clickedNodeId = this.#findNodeIdFromTarget(event.target);
    this.#panSession = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originTx: this.#tx,
      originTy: this.#ty,
      clickedNodeId,
      dragging: false,
      captured: false,
    };
  };

  readonly #onPointerMove = (event: PointerEvent): void => {
    const session = this.#panSession;
    if (!session || session.pointerId !== event.pointerId) return;

    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    if (!session.dragging && Math.hypot(dx, dy) > 4) {
      session.dragging = true;
      this.#svg.classList.add("is-panning");
      try {
        this.#svg.setPointerCapture(session.pointerId);
        session.captured = true;
      } catch {
        // Ignore if pointer capture is unavailable in synthetic test events
      }
    }

    if (session.dragging) {
      this.#tx = session.originTx + dx;
      this.#ty = session.originTy + dy;
      this.#applyTransform();
    }
  };

  readonly #onPointerUp = (event: PointerEvent): void => {
    const session = this.#panSession;
    if (!session || session.pointerId !== event.pointerId) return;
    this.#panSession = null;
    this.#svg.classList.remove("is-panning");

    if (session.captured) {
      try {
        this.#svg.releasePointerCapture(session.pointerId);
      } catch {
        // Ignore release errors
      }
    }

    if (!session.dragging) {
      if (session.clickedNodeId !== null) {
        this.#callbacks.onSelectNode(session.clickedNodeId);
        this.#nodeRefs
          .get(session.clickedNodeId)
          ?.group.focus({ preventScroll: true });
      } else {
        this.#callbacks.onSelectNode(null);
      }
    }
  };

  readonly #onPointerCancel = (event: PointerEvent): void => {
    if (this.#panSession?.pointerId === event.pointerId) {
      this.#panSession = null;
      this.#svg.classList.remove("is-panning");
    }
  };

  readonly #onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rect = this.#svg.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const delta = clamp(-event.deltaY, -180, 180);
    const factor = Math.exp(delta * 0.0022);
    this.#zoomAtPoint(px, py, factor);
  };

  readonly #onDoubleClick = (event: MouseEvent): void => {
    if (this.#findNodeIdFromTarget(event.target) === null) {
      this.fitToViewport();
    }
  };

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    const focusedId = this.#findNodeIdFromTarget(event.target);

    if (event.key === "Escape") {
      event.preventDefault();
      this.#callbacks.onSelectNode(null);
      return;
    }

    if (focusedId === null) return;

    if (event.key === "Enter" || event.key === " ") {
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
      const next = this.#findDirectionalNeighbor(focusedId, event.key);
      if (next) {
        this.#callbacks.onSelectNode(next.node.id);
        this.#nodeRefs.get(next.node.id)?.group.focus({ preventScroll: true });
        this.panToNode(next.node.id);
      }
    }
  };

  #findDirectionalNeighbor(
    currentId: number,
    direction: "ArrowRight" | "ArrowLeft" | "ArrowUp" | "ArrowDown",
  ): PositionedNode | null {
    const layout = this.#lastLayout;
    if (!layout) return null;
    const current = layout.nodeById.get(currentId);
    if (!current) return null;

    let best: PositionedNode | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const candidate of layout.nodes) {
      if (candidate.node.id === currentId) continue;

      const dx = candidate.x - current.x;
      const dy = candidate.y - current.y;

      let primary = 0;
      let orthogonal = 0;
      switch (direction) {
        case "ArrowRight":
          if (dx <= 1) continue;
          primary = dx;
          orthogonal = Math.abs(dy);
          break;
        case "ArrowLeft":
          if (dx >= -1) continue;
          primary = -dx;
          orthogonal = Math.abs(dy);
          break;
        case "ArrowDown":
          if (dy <= 1) continue;
          primary = dy;
          orthogonal = Math.abs(dx);
          break;
        case "ArrowUp":
          if (dy >= -1) continue;
          primary = -dy;
          orthogonal = Math.abs(dx);
          break;
      }

      const score = primary + orthogonal * 2.2;
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    return best;
  }
}
