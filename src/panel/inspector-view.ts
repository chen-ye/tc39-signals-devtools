import { formatNodeDisplayName, type PanelViewModel } from "./graph-state.ts";
import type {
  ActionResult,
  SignalKind,
  SignalNodeSnapshot,
  SourceLocation,
  ValuePreview,
} from "../protocol/types.ts";

export interface InspectorViewCallbacks {
  readonly onSelectNode: (nodeId: number) => void;
  readonly onSetStateValue: (nodeId: number, jsonText: string) => void;
  readonly onEvaluateComputed: (nodeId: number) => void;
  readonly onLogNode: (nodeId: number) => void;
}

interface ActionFeedbackState {
  readonly nodeId: number;
  readonly ok: boolean;
  readonly message: string;
}

interface MountedDetailSlots {
  readonly nodeId: number;
  readonly kind: SignalKind;
  readonly headerSlot: HTMLElement;
  readonly errorSlot: HTMLElement;
  readonly valueSlot: HTMLElement;
  readonly editorSlot: HTMLElement;
  readonly feedbackSlot: HTMLElement;
  readonly metricsSlot: HTMLElement;
  readonly causesSlot: HTMLElement;
  readonly connectionsSlot: HTMLElement;
  editorInput: HTMLTextAreaElement | null;
  editorDirty: boolean;
  lastSyncedValue: string;
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

function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 0.01) return "<0.01ms";
  if (ms < 10) return `${ms.toFixed(2)}ms`;
  return `${ms.toFixed(1)}ms`;
}

function formatCallsite(site: SourceLocation): string {
  return `${site.file}:${site.line}:${site.column}`;
}

function deriveInitialJsonInput(value: ValuePreview | null): string {
  if (!value || value.truncated) return "";
  if (
    value.kind === "number" ||
    value.kind === "boolean" ||
    value.kind === "null" ||
    value.kind === "string" ||
    value.kind === "array" ||
    value.kind === "object"
  ) {
    try {
      JSON.parse(value.text);
      return value.text;
    } catch {
      return "";
    }
  }
  return "";
}

function kindShortLetter(kind: SignalKind): string {
  if (kind === "state") return "S";
  if (kind === "computed") return "C";
  return "W";
}

export class InspectorView {
  readonly #bodyEl: HTMLElement;
  readonly #subtitleEl: HTMLElement;
  readonly #callbacks: InspectorViewCallbacks;

  #mounted: MountedDetailSlots | null = null;
  #feedback: ActionFeedbackState | null = null;

  constructor(
    bodyEl: HTMLElement,
    subtitleEl: HTMLElement,
    callbacks: InspectorViewCallbacks,
  ) {
    this.#bodyEl = bodyEl;
    this.#subtitleEl = subtitleEl;
    this.#callbacks = callbacks;
  }

  showActionResult(
    nodeId: number,
    kind: "set" | "evaluate" | "log",
    result: ActionResult,
  ): void {
    if (result.ok) {
      const okMessage =
        kind === "set"
          ? `Updated State #${nodeId}`
          : kind === "evaluate"
            ? `Evaluated Computed #${nodeId}`
            : `Logged #${nodeId} as $signal in Console`;
      this.#feedback = { nodeId, ok: true, message: okMessage };
      if (kind === "set" && this.#mounted && this.#mounted.nodeId === nodeId) {
        this.#mounted.editorDirty = false;
      }
    } else {
      this.#feedback = { nodeId, ok: false, message: result.error };
    }
    this.#renderFeedbackSlot();
  }

  render(vm: PanelViewModel): void {
    const selected = vm.selectedNode;

    if (!selected) {
      this.#mounted = null;
      this.#subtitleEl.textContent = "Overview";
      this.#renderOverview(vm);
      return;
    }

    const displayName = formatNodeDisplayName(selected);
    this.#subtitleEl.textContent = `${displayName} #${selected.id}`;

    const nodeById = new Map<number, SignalNodeSnapshot>();
    if (vm.snapshot) {
      for (const n of vm.snapshot.nodes) {
        nodeById.set(n.id, n);
      }
    }

    // Rebuild skeleton only when selecting a different node (or kind changed) so State Editor keeps focus!
    if (
      !this.#mounted ||
      this.#mounted.nodeId !== selected.id ||
      this.#mounted.kind !== selected.kind
    ) {
      if (this.#feedback && this.#feedback.nodeId !== selected.id) {
        this.#feedback = null;
      }
      this.#mountDetailSkeleton(selected);
    }

    const slots = this.#mounted;
    if (!slots) return;

    this.#renderHeader(slots.headerSlot, selected);
    this.#renderError(slots.errorSlot, selected);
    this.#renderValue(slots.valueSlot, selected);
    this.#syncStateEditor(slots, selected);
    this.#renderFeedbackSlot();
    this.#renderMetrics(slots.metricsSlot, selected, vm.directSourceIds.size);
    this.#renderCauses(slots.causesSlot, selected, nodeById);
    this.#renderConnections(slots.connectionsSlot, vm, nodeById);
  }

  #renderOverview(vm: PanelViewModel): void {
    const container = el("div", "inspector-overview");

    const hint = el(
      "p",
      "inspector-hint",
      vm.stats.totalNodes > 0
        ? "Select any node in the graph or timeline to inspect live values, edit State signals, evaluate unread Computeds, and trace causal re-runs."
        : "Waiting for signal activity. Once signals appear in the graph, select any node to inspect it here.",
    );
    container.appendChild(hint);

    if (vm.snapshot && vm.snapshot.runtimes.length > 0) {
      const rtSection = el("section", "insp-section");
      rtSection.appendChild(el("h3", "insp-section-title", "Runtimes"));
      const list = el("div", "meta-tags");
      for (const rt of vm.snapshot.runtimes) {
        list.appendChild(el("span", "meta-tag", `${rt.name} · ${rt.mode}`));
      }
      rtSection.appendChild(list);
      container.appendChild(rtSection);
    }

    if (vm.snapshot) {
      const errored = vm.snapshot.nodes.filter((n) => n.error !== null);
      if (errored.length > 0) {
        const errSection = el("section", "insp-section");
        errSection.appendChild(
          el("h3", "insp-section-title", `Errored Signals (${errored.length})`),
        );
        const chips = el("div", "chip-list");
        for (const node of errored) {
          chips.appendChild(this.#createNodeChip(node, "is-error"));
        }
        errSection.appendChild(chips);
        container.appendChild(errSection);
      }

      const unread = vm.snapshot.nodes.filter(
        (n) => n.kind === "computed" && n.unread,
      );
      if (unread.length > 0) {
        const unreadSection = el("section", "insp-section");
        unreadSection.appendChild(
          el("h3", "insp-section-title", `Unread Computeds (${unread.length})`),
        );
        const chips = el("div", "chip-list");
        for (const node of unread) {
          chips.appendChild(this.#createNodeChip(node));
        }
        unreadSection.appendChild(chips);
        container.appendChild(unreadSection);
      }
    }

    this.#bodyEl.replaceChildren(container);
  }

  #mountDetailSkeleton(node: SignalNodeSnapshot): void {
    const headerSlot = el("section", "insp-section");
    const errorSlot = el("section", "insp-section");
    const valueSlot = el("section", "insp-section");
    const editorSlot = el("section", "insp-section");
    const feedbackSlot = el("div");
    const metricsSlot = el("section", "insp-section");
    const causesSlot = el("section", "insp-section");
    const connectionsSlot = el("section", "insp-section");

    let editorInput: HTMLTextAreaElement | null = null;
    const initialJson =
      node.kind === "state" ? deriveInitialJsonInput(node.value) : "";

    if (node.kind === "state") {
      editorSlot.dataset.testid = "state-editor";
      const head = el("div", "insp-section-head");
      head.appendChild(el("h3", "insp-section-title", "Edit State Value"));
      editorSlot.appendChild(head);

      const form = el("form", "editor-form");
      const textarea = el("textarea", "editor-input");
      textarea.dataset.testid = "state-value-input";
      textarea.setAttribute(
        "aria-label",
        `JSON value for ${formatNodeDisplayName(node)}`,
      );
      textarea.placeholder = 'JSON value (e.g. 42, "SAVE10", true, {"a":1})';
      textarea.spellcheck = false;
      textarea.value = initialJson;
      editorInput = textarea;

      const submitValue = () => {
        this.#callbacks.onSetStateValue(node.id, textarea.value);
      };

      textarea.addEventListener("input", () => {
        if (this.#mounted && this.#mounted.nodeId === node.id) {
          this.#mounted.editorDirty = true;
        }
      });

      textarea.addEventListener("keydown", (event: KeyboardEvent) => {
        if (
          event.key === "Enter" &&
          (event.metaKey || event.ctrlKey || !event.shiftKey)
        ) {
          event.preventDefault();
          submitValue();
        }
      });

      form.addEventListener("submit", (event: SubmitEvent) => {
        event.preventDefault();
        submitValue();
      });

      const footer = el("div", "editor-footer");
      footer.appendChild(el("span", "editor-hint", "JSON · Enter to apply"));
      const setBtn = el("button", "tool-btn accent-btn", "Set value");
      setBtn.type = "submit";
      setBtn.dataset.testid = "state-set-btn";
      footer.appendChild(setBtn);

      form.appendChild(textarea);
      form.appendChild(footer);
      editorSlot.appendChild(form);
    } else {
      editorSlot.hidden = true;
    }

    this.#mounted = {
      nodeId: node.id,
      kind: node.kind,
      headerSlot,
      errorSlot,
      valueSlot,
      editorSlot,
      feedbackSlot,
      metricsSlot,
      causesSlot,
      connectionsSlot,
      editorInput,
      editorDirty: false,
      lastSyncedValue: initialJson,
    };

    this.#bodyEl.replaceChildren(
      headerSlot,
      errorSlot,
      valueSlot,
      editorSlot,
      feedbackSlot,
      metricsSlot,
      causesSlot,
      connectionsSlot,
    );
  }

  #renderHeader(slot: HTMLElement, node: SignalNodeSnapshot): void {
    const wrap = el("div", "insp-node-header");

    const titleRow = el("div", "insp-title-row");
    const nameWrap = el("div", "insp-name-wrap");
    nameWrap.appendChild(
      el(
        "span",
        `kind-pill is-${node.kind}`,
        `${kindShortLetter(node.kind)} ${node.kind}`,
      ),
    );
    const nameEl = el("h3", "insp-node-name", formatNodeDisplayName(node));
    nameEl.title = formatNodeDisplayName(node);
    nameWrap.appendChild(nameEl);
    nameWrap.appendChild(el("span", "insp-node-id", `#${node.id}`));
    titleRow.appendChild(nameWrap);

    const logBtn = el("button", "tool-btn compact", "Log as $signal");
    logBtn.type = "button";
    logBtn.dataset.testid = "log-node-btn";
    logBtn.title =
      "Expose this signal instance on globalThis.$signal and log to Console";
    logBtn.addEventListener("click", () => {
      this.#callbacks.onLogNode(node.id);
      this.showActionResult(node.id, "log", { ok: true });
    });
    titleRow.appendChild(logBtn);
    wrap.appendChild(titleRow);

    const tags = el("div", "meta-tags");
    tags.appendChild(
      el("span", "meta-tag", `${node.runtime} · ${node.runtimeMode}`),
    );
    tags.appendChild(
      el(
        "span",
        `meta-tag ${node.live ? "is-live" : "is-cold"}`,
        node.live ? "live" : "cold",
      ),
    );
    if (node.lastChangedSeq > 0) {
      tags.appendChild(
        el("span", "meta-tag tabular", `seq #${node.lastChangedSeq}`),
      );
    }
    wrap.appendChild(tags);

    if (node.site) {
      const callsite = el("div", "callsite-row");
      const fullSite = formatCallsite(node.site);
      callsite.title = node.site.fn
        ? `${node.site.fn} (${fullSite})`
        : fullSite;
      if (node.site.fn) {
        callsite.appendChild(el("span", "callsite-fn", node.site.fn));
        callsite.appendChild(document.createTextNode(" · "));
      }
      callsite.appendChild(document.createTextNode(fullSite));
      wrap.appendChild(callsite);
    }

    slot.replaceChildren(wrap);
  }

  #renderError(slot: HTMLElement, node: SignalNodeSnapshot): void {
    if (node.error === null) {
      slot.hidden = true;
      slot.replaceChildren();
      return;
    }

    slot.hidden = false;
    const box = el("div", "error-callout");
    box.dataset.testid = "inspector-error";
    box.appendChild(el("div", "error-callout-title", "Evaluation Error"));
    box.appendChild(el("p", "error-callout-msg", node.error));
    slot.replaceChildren(box);
  }

  #renderValue(slot: HTMLElement, node: SignalNodeSnapshot): void {
    if (node.kind === "watcher") {
      slot.hidden = true;
      slot.replaceChildren();
      return;
    }

    slot.hidden = false;
    const frag = document.createDocumentFragment();

    const head = el("div", "insp-section-head");
    const titleWrap = el("div", "meta-tags");
    titleWrap.appendChild(
      el(
        "h3",
        "insp-section-title",
        node.error !== null ? "Last Cached Value" : "Current Value",
      ),
    );
    if (node.unread) {
      titleWrap.appendChild(el("span", "meta-tag", "unread"));
    } else if (node.value) {
      titleWrap.appendChild(el("span", "meta-tag", node.value.kind));
    }
    head.appendChild(titleWrap);

    if (node.kind === "computed") {
      const evalBtn = el(
        "button",
        node.unread ? "tool-btn compact accent-btn" : "tool-btn compact",
        node.unread ? "Evaluate" : "Re-read",
      );
      evalBtn.type = "button";
      evalBtn.dataset.testid = "evaluate-computed-btn";
      evalBtn.title = "Call computed.get() inside Signal.subtle.untrack()";
      evalBtn.addEventListener("click", () => {
        this.#callbacks.onEvaluateComputed(node.id);
      });
      head.appendChild(evalBtn);
    }
    frag.appendChild(head);

    const valBox = el("div", "value-box");
    valBox.dataset.testid = "inspector-value";
    if (node.unread) {
      valBox.textContent = "(unread — click Evaluate to compute lazily)";
      valBox.classList.add("is-unread");
    } else if (node.value) {
      valBox.textContent = node.value.text;
      if (
        node.value.kind === "number" ||
        node.value.kind === "string" ||
        node.value.kind === "boolean"
      ) {
        valBox.classList.add(`is-${node.value.kind}`);
      }
    } else {
      valBox.textContent = "—";
    }
    frag.appendChild(valBox);

    if (node.value?.entries && node.value.entries.length > 0) {
      const details = el("details", "entries-details");
      details.open = true;
      details.dataset.testid = "inspector-entries";
      const summary = el(
        "summary",
        undefined,
        `Entries (${node.value.entries.length}${node.value.truncated ? "+" : ""})`,
      );
      details.appendChild(summary);

      const table = el("table", "entries-table");
      const tbody = el("tbody");
      for (const [k, v] of node.value.entries) {
        const tr = el("tr");
        const th = el("th", undefined, k);
        th.scope = "row";
        const td = el("td", undefined, v);
        tr.appendChild(th);
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      details.appendChild(table);

      if (node.value.truncated) {
        details.appendChild(
          el("div", "entries-truncated", "Preview truncated at 16 entries"),
        );
      }
      frag.appendChild(details);
    }

    slot.replaceChildren(frag);
  }

  #syncStateEditor(slots: MountedDetailSlots, node: SignalNodeSnapshot): void {
    if (node.kind !== "state" || !slots.editorInput) return;
    const nextJson = deriveInitialJsonInput(node.value);
    if (!slots.editorDirty && nextJson !== slots.lastSyncedValue) {
      slots.editorInput.value = nextJson;
      slots.lastSyncedValue = nextJson;
    }
  }

  #renderFeedbackSlot(): void {
    if (!this.#mounted) return;
    const slot = this.#mounted.feedbackSlot;
    const fb = this.#feedback;
    if (!fb || fb.nodeId !== this.#mounted.nodeId) {
      slot.hidden = true;
      slot.replaceChildren();
      return;
    }
    slot.hidden = false;
    const banner = el(
      "div",
      `action-feedback ${fb.ok ? "is-ok" : "is-error"}`,
      fb.message,
    );
    banner.dataset.testid = "action-feedback";
    banner.setAttribute("role", "status");
    banner.setAttribute("aria-live", "polite");
    slot.replaceChildren(banner);
  }

  #renderMetrics(
    slot: HTMLElement,
    node: SignalNodeSnapshot,
    directSourceCount: number,
  ): void {
    const dl = el("dl", "metrics-strip");

    const addMetric = (label: string, value: string) => {
      const cell = el("div", "metric-cell");
      cell.appendChild(el("dt", undefined, label));
      cell.appendChild(el("dd", undefined, value));
      dl.appendChild(cell);
    };

    if (node.kind === "state") {
      addMetric("Sets", String(node.sets));
      addMetric("Status", node.live ? "Live" : "Cold");
      addMetric(
        "Seq",
        node.lastChangedSeq > 0 ? `#${node.lastChangedSeq}` : "—",
      );
    } else if (node.kind === "computed") {
      addMetric("Runs", String(node.runs));
      addMetric("Last run", formatMs(node.lastRunMs));
      addMetric(
        "State",
        node.error !== null ? "Error" : node.unread ? "Unread" : "Cached",
      );
    } else {
      addMetric("Notifies", String(node.notifies));
      addMetric("Watching", String(directSourceCount));
      addMetric(
        "Seq",
        node.lastChangedSeq > 0 ? `#${node.lastChangedSeq}` : "—",
      );
    }

    slot.replaceChildren(dl);
  }

  #renderCauses(
    slot: HTMLElement,
    node: SignalNodeSnapshot,
    nodeById: ReadonlyMap<number, SignalNodeSnapshot>,
  ): void {
    if (node.kind !== "computed") {
      slot.hidden = true;
      slot.replaceChildren();
      return;
    }

    slot.hidden = false;
    slot.dataset.testid = "inspector-causes";
    const frag = document.createDocumentFragment();
    frag.appendChild(el("h3", "insp-section-title", "Why did it re-run?"));

    if (node.causes.length > 0) {
      const chips = el("div", "chip-list");
      for (const causeId of node.causes) {
        const causeNode = nodeById.get(causeId);
        if (causeNode) {
          chips.appendChild(this.#createNodeChip(causeNode, "is-cause"));
        } else {
          const deadChip = el("span", "meta-tag", `Signal #${causeId} (GC'd)`);
          chips.appendChild(deadChip);
        }
      }
      frag.appendChild(chips);
    } else if (node.unread) {
      frag.appendChild(el("p", "muted-note", "Not yet evaluated."));
    } else if (node.runs <= 1) {
      frag.appendChild(
        el("p", "muted-note", "Initial evaluation (no upstream invalidation)."),
      );
    } else {
      frag.appendChild(
        el("p", "muted-note", "No recorded upstream causes for latest run."),
      );
    }

    slot.replaceChildren(frag);
  }

  #renderConnections(
    slot: HTMLElement,
    vm: PanelViewModel,
    nodeById: ReadonlyMap<number, SignalNodeSnapshot>,
  ): void {
    slot.dataset.testid = "inspector-connections";
    const frag = document.createDocumentFragment();

    const head = el("div", "insp-section-head");
    head.appendChild(el("h3", "insp-section-title", "Connections"));
    head.appendChild(
      el(
        "span",
        "pane-subtitle tabular",
        `${vm.upstreamIds.size} up · ${vm.downstreamIds.size} down`,
      ),
    );
    frag.appendChild(head);

    const sourcesGroup = el("div", "connections-group");
    sourcesGroup.appendChild(
      el("span", "connections-subhead", `Sources (${vm.directSourceIds.size})`),
    );
    if (vm.directSourceIds.size > 0) {
      const list = el("div", "chip-list");
      for (const srcId of vm.directSourceIds) {
        const srcNode = nodeById.get(srcId);
        if (srcNode) {
          const extra = vm.directCauseIds.has(srcId) ? "is-cause" : undefined;
          list.appendChild(this.#createNodeChip(srcNode, extra));
        }
      }
      sourcesGroup.appendChild(list);
    } else {
      sourcesGroup.appendChild(el("p", "muted-note", "None"));
    }
    frag.appendChild(sourcesGroup);

    const sinksGroup = el("div", "connections-group");
    sinksGroup.appendChild(
      el("span", "connections-subhead", `Sinks (${vm.directSinkIds.size})`),
    );
    if (vm.directSinkIds.size > 0) {
      const list = el("div", "chip-list");
      for (const sinkId of vm.directSinkIds) {
        const sinkNode = nodeById.get(sinkId);
        if (sinkNode) {
          list.appendChild(this.#createNodeChip(sinkNode));
        }
      }
      sinksGroup.appendChild(list);
    } else {
      sinksGroup.appendChild(el("p", "muted-note", "None"));
    }
    frag.appendChild(sinksGroup);

    slot.replaceChildren(frag);
  }

  #createNodeChip(
    node: SignalNodeSnapshot,
    extraClass?: string,
  ): HTMLButtonElement {
    const btn = el(
      "button",
      extraClass ? `node-chip ${extraClass}` : "node-chip",
    );
    btn.type = "button";
    btn.dataset.jumpNodeId = String(node.id);
    btn.appendChild(
      el("span", `kind-dot is-${node.kind}`, kindShortLetter(node.kind)),
    );
    btn.appendChild(el("span", "node-chip-label", formatNodeDisplayName(node)));
    btn.appendChild(el("span", "node-chip-id", `#${node.id}`));
    btn.addEventListener("click", () => {
      this.#callbacks.onSelectNode(node.id);
    });
    return btn;
  }
}
