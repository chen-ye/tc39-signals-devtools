import { formatNodeDisplayName, type PanelViewModel } from "./graph-state.ts";
import type { SignalEvent, SignalNodeSnapshot } from "../protocol/types.ts";

const MAX_DISPLAY_EVENTS = 200;

export interface TimelineViewCallbacks {
  readonly onSelectNode: (nodeId: number) => void;
}

export interface TimelineViewElements {
  readonly listEl: HTMLElement;
  readonly countEl: HTMLElement;
  readonly tabCountEl: HTMLElement;
  readonly droppedEl: HTMLElement;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatDelta(deltaMs: number | null): string {
  if (deltaMs === null) return "—";
  if (deltaMs < 1) return "+0ms";
  if (deltaMs < 1000) return `+${Math.round(deltaMs)}ms`;
  if (deltaMs < 60_000) return `+${(deltaMs / 1000).toFixed(1)}s`;
  return `+${Math.round(deltaMs / 60_000)}m`;
}

function formatClock(timestamp: number): string {
  const d = new Date(timestamp);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatDuration(ms: number): string {
  if (ms < 0.05) return "<0.1ms";
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms)}ms`;
}

const TYPE_BADGE_LABEL: Record<SignalEvent["type"], string> = {
  set: "SET",
  run: "RUN",
  error: "ERR",
  notify: "NTFY",
  create: "NEW",
};

function typeBadgeLabel(type: SignalEvent["type"]): string {
  return TYPE_BADGE_LABEL[type];
}

export class TimelineView {
  readonly #els: TimelineViewElements;
  readonly #callbacks: TimelineViewCallbacks;

  constructor(els: TimelineViewElements, callbacks: TimelineViewCallbacks) {
    this.#els = els;
    this.#callbacks = callbacks;
    this.#els.listEl.addEventListener("click", this.#onListClick);
  }

  render(vm: PanelViewModel): void {
    const events = vm.filteredEvents;
    const totalCount = events.length;
    this.#els.countEl.textContent = String(totalCount);
    this.#els.tabCountEl.textContent = String(totalCount);

    const dropped = vm.snapshot?.droppedEvents ?? 0;
    if (dropped > 0) {
      this.#els.droppedEl.hidden = false;
      this.#els.droppedEl.textContent = `+${dropped} dropped`;
      this.#els.droppedEl.title = `${dropped} older events evicted from the ring buffer`;
    } else {
      this.#els.droppedEl.hidden = true;
      this.#els.droppedEl.textContent = "";
    }

    if (totalCount === 0) {
      const paused = vm.snapshot?.settings.paused ?? false;
      const totalRecorded = vm.snapshot?.events.length ?? 0;
      const msg = paused
        ? "Recording is paused. Resume recording in the toolbar to capture new reactivity events."
        : totalRecorded > 0
          ? "No events match the active timeline filters."
          : "No events recorded yet. Mutate a signal to trace updates and causal re-runs.";
      this.#els.listEl.replaceChildren(el("div", "timeline-empty", msg));
      return;
    }

    const nodeById = new Map<number, SignalNodeSnapshot>();
    if (vm.snapshot) {
      for (const node of vm.snapshot.nodes) {
        nodeById.set(node.id, node);
      }
    }

    const selectedId = vm.selectedNode?.id ?? null;
    const slice = events.slice(0, MAX_DISPLAY_EVENTS);
    const frag = document.createDocumentFragment();

    for (let i = 0; i < slice.length; i++) {
      const event = slice[i];
      if (!event) continue;

      const olderEvent = events[i + 1];
      const deltaMs = olderEvent
        ? Math.max(0, event.timestamp - olderEvent.timestamp)
        : null;

      const row = el("div", "timeline-row");
      row.setAttribute("role", "listitem");
      row.dataset.testid = "timeline-row";
      row.dataset.eventType = event.type;
      row.dataset.nodeId = String(event.nodeId);

      if (selectedId !== null && event.nodeId === selectedId) {
        row.dataset.selected = "true";
      } else if (vm.directCauseIds.has(event.nodeId)) {
        row.dataset.cause = "true";
      }

      const seqEl = el("span", "tl-seq", `#${event.seq}`);
      row.appendChild(seqEl);

      const deltaEl = el("span", "tl-delta", formatDelta(deltaMs));
      deltaEl.title = formatClock(event.timestamp);
      row.appendChild(deltaEl);

      const badge = el(
        "span",
        `tl-type is-${event.type}`,
        typeBadgeLabel(event.type),
      );
      row.appendChild(badge);

      const node = nodeById.get(event.nodeId);
      const nodeName = node
        ? formatNodeDisplayName(node)
        : event.type === "create" && event.label
          ? event.label
          : `#${event.nodeId}`;

      const nodeBtn = el("button", "tl-node-btn");
      nodeBtn.type = "button";
      nodeBtn.dataset.selectNodeId = String(event.nodeId);
      nodeBtn.title = `${nodeName} (#${event.nodeId})`;
      nodeBtn.appendChild(el("span", "tl-node-name", nodeName));
      row.appendChild(nodeBtn);

      const detail = el("div", "tl-detail");
      let durationText = "";

      switch (event.type) {
        case "set": {
          const summary = `${event.from.text} → ${event.to.text}`;
          const textEl = el("span", "tl-detail-text", summary);
          textEl.title = summary;
          detail.appendChild(textEl);
          if (!event.changed) {
            detail.appendChild(el("span", "tl-tag", "no-op"));
          }
          if (event.site) {
            const siteLabel = `${event.site.file}:${event.site.line}`;
            const siteTag = el("span", "tl-tag", siteLabel);
            siteTag.title = event.site.fn
              ? `${event.site.fn} @ ${siteLabel}:${event.site.column}`
              : `${siteLabel}:${event.site.column}`;
            detail.appendChild(siteTag);
          }
          break;
        }
        case "run": {
          const summary = `→ ${event.to.text}`;
          const textEl = el("span", "tl-detail-text", summary);
          textEl.title = summary;
          detail.appendChild(textEl);
          if (event.first) {
            detail.appendChild(el("span", "tl-tag", "init"));
          } else if (!event.changed) {
            detail.appendChild(el("span", "tl-tag", "same"));
          }
          if (event.causes.length > 0) {
            const causeTag = el(
              "span",
              "tl-tag is-cause",
              `causes: ${event.causes.length}`,
            );
            causeTag.title = event.causes
              .map((id) => {
                const c = nodeById.get(id);
                return c ? `${formatNodeDisplayName(c)} (#${id})` : `#${id}`;
              })
              .join(", ");
            detail.appendChild(causeTag);
          }
          durationText = formatDuration(event.durationMs);
          break;
        }
        case "error": {
          const textEl = el("span", "tl-detail-text is-error", event.error);
          textEl.title = event.error;
          detail.appendChild(textEl);
          if (event.causes.length > 0) {
            detail.appendChild(
              el("span", "tl-tag is-cause", `causes: ${event.causes.length}`),
            );
          }
          durationText = formatDuration(event.durationMs);
          break;
        }
        case "notify": {
          const pendingNames = event.pendingIds
            .map((id) => {
              const p = nodeById.get(id);
              return p ? formatNodeDisplayName(p) : `#${id}`;
            })
            .join(", ");
          const summary =
            event.pendingIds.length > 0
              ? `pending (${event.pendingIds.length}): ${pendingNames}`
              : "notified";
          const textEl = el("span", "tl-detail-text", summary);
          textEl.title = summary;
          detail.appendChild(textEl);
          break;
        }
        case "create": {
          const summary = `created ${event.kind}`;
          detail.appendChild(el("span", "tl-detail-text", summary));
          break;
        }
      }

      row.appendChild(detail);
      row.appendChild(el("span", "tl-duration", durationText));
      frag.appendChild(row);
    }

    if (totalCount > MAX_DISPLAY_EVENTS) {
      frag.appendChild(
        el(
          "div",
          "timeline-cap-note",
          `Showing latest ${MAX_DISPLAY_EVENTS} of ${totalCount} matching events`,
        ),
      );
    }

    this.#els.listEl.replaceChildren(frag);
  }

  dispose(): void {
    this.#els.listEl.removeEventListener("click", this.#onListClick);
  }

  readonly #onListClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest<HTMLElement>("[data-node-id]");
    if (!row) return;
    const rawId = row.dataset.nodeId;
    if (!rawId) return;
    const nodeId = Number(rawId);
    if (Number.isFinite(nodeId)) {
      this.#callbacks.onSelectNode(nodeId);
    }
  };
}
