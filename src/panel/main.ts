import {
  DEFAULT_FILTER_STATE,
  derivePanelViewModel,
  type EventTypeFilter,
  type KindFilter,
  type LivenessFilter,
  type PanelFilterState,
} from "./graph-state.ts";
import { GraphView } from "./graph-view.ts";
import { InspectorView } from "./inspector-view.ts";
import { TimelineView } from "./timeline-view.ts";
import { createPanelTransport } from "./transport.ts";
import {
  normalizeOriginKey,
  type BackgroundToPanelMessage,
  type GraphSnapshot,
} from "../protocol/types.ts";

type ThemeMode = "auto" | "light" | "dark";
type ConnectionStatus = "connecting" | "connected" | "disconnected";
type DrawerTab = "inspector" | "timeline";

interface PendingAction {
  readonly nodeId: number;
  readonly kind: "set" | "evaluate";
}

function getEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing required panel element #${id}`);
  }
  return el;
}

function getButton(id: string): HTMLButtonElement {
  const el = getEl(id);
  if (!(el instanceof HTMLButtonElement)) {
    throw new Error(`Expected #${id} to be a <button>`);
  }
  return el;
}

function getInput(id: string): HTMLInputElement {
  const el = getEl(id);
  if (!(el instanceof HTMLInputElement)) {
    throw new Error(`Expected #${id} to be an <input>`);
  }
  return el;
}

function isKindFilter(value: string): value is KindFilter {
  return (
    value === "all" ||
    value === "state" ||
    value === "computed" ||
    value === "watcher"
  );
}

function isLivenessFilter(value: string): value is LivenessFilter {
  return value === "all" || value === "live" || value === "cold";
}

function isEventTypeFilter(value: string): value is EventTypeFilter {
  return (
    value === "all" ||
    value === "set" ||
    value === "run" ||
    value === "error" ||
    value === "notify" ||
    value === "create"
  );
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function initPanel(): void {
  const transport = createPanelTransport();

  // DOM references
  const workspaceEl = getEl("workspace");
  const graphStageEl = getEl("graph-stage");
  const graphMountEl = getEl("graph-mount");
  const emptyStateEl = getEl("empty-state");
  const emptyBridgeStatusEl = getEl("empty-bridge-status");
  const emptySiteToggleBtn = getButton("empty-site-toggle");
  const filterEmptyEl = getEl("filter-empty");
  const filterEmptySubEl = getEl("filter-empty-sub");
  const resetFiltersBtn = getButton("reset-filters");

  const searchInput = getInput("search-input");
  const filterErrorsBtn = getButton("filter-errors");
  const filterErrorsCountEl = getEl("filter-errors-count");
  const togglePauseBtn = getButton("toggle-pause");
  const togglePauseLabelEl = getEl("toggle-pause-label");
  const toggleStacksBtn = getButton("toggle-stacks");
  const clearTimelineBtn = getButton("clear-timeline");
  const fitGraphBtn = getButton("fit-graph");
  const toggleThemeBtn = getButton("toggle-theme");
  const toggleThemeLabelEl = getEl("toggle-theme-label");

  const connectionStatusEl = getEl("connection-status");
  const connectionStatusTextEl = getEl("connection-status-text");
  const runtimeBadgesEl = getEl("runtime-badges");
  const statStatesEl = getEl("stat-states");
  const statComputedsEl = getEl("stat-computeds");
  const statWatchersEl = getEl("stat-watchers");
  const statEdgesEl = getEl("stat-edges");
  const statErrorsWrapEl = getEl("stat-errors-wrap");
  const statErrorsEl = getEl("stat-errors");
  const filteredPillEl = getEl("filtered-pill");
  const filteredPillTextEl = getEl("filtered-pill-text");
  const filteredResetBtn = getButton("filtered-reset-btn");

  const modeBadgeEl = getEl("mode-badge");
  const siteToggleBtn = getButton("site-toggle");
  const siteOriginLabelEl = getEl("site-origin-label");
  const reloadTabBtn = getButton("reload-tab");

  const graphLegendEl =
    graphStageEl.querySelector<HTMLElement>(".graph-legend");
  const graphHudEl = graphStageEl.querySelector<HTMLElement>(".graph-hud");

  const zoomOutBtn = getButton("zoom-out");
  const zoomLevelBtn = getButton("zoom-level");
  const zoomInBtn = getButton("zoom-in");
  const graphFitBtn = getButton("graph-fit-btn");

  const tabInspectorBtn = getButton("tab-inspector");
  const tabTimelineBtn = getButton("tab-timeline");
  const tabTimelineCountEl = getEl("tab-timeline-count");

  const inspectorBodyEl = getEl("inspector-body");
  const inspectorSubtitleEl = getEl("inspector-subtitle");

  const timelineBodyEl = getEl("timeline-body");
  const timelineCountEl = getEl("timeline-count");
  const timelineDroppedEl = getEl("timeline-dropped");
  const timelineFollowBtn = getButton("timeline-follow-selection");
  const timelineClearBtn = getButton("timeline-clear-btn");
  const timelineCollapseBtn = getButton("timeline-collapse-btn");

  const kindButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-kind-filter]"),
  );
  const livenessButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-liveness-filter]"),
  );
  const eventFilterButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-event-filter]"),
  );

  // Panel state
  let latestSnapshot: GraphSnapshot | null = null;
  let filterState: PanelFilterState = { ...DEFAULT_FILTER_STATE };
  let selectedNodeId: number | null = null;
  let connectionStatus: ConnectionStatus = "connecting";
  let connectedUrl: string | null = null;
  let siteOriginKey: string | null = null;
  let siteToggleEnabled = false;
  let siteToggleDirty = false;
  let activeTab: DrawerTab = "inspector";
  let timelineCollapsed = false;
  let requestCounter = 0;
  let rafId: number | null = null;
  let lastRenderAt = 0;

  const pendingActions = new Map<string, PendingAction>();
  const startupTimers: Array<ReturnType<typeof setTimeout>> = [];

  // Theme setup (respects Chrome DevTools theme when available, otherwise auto system scheme)
  let themeMode: ThemeMode = "auto";

  const applyTheme = (mode: ThemeMode): void => {
    themeMode = mode;
    if (mode === "auto") {
      const dtTheme = transport.getDevToolsTheme();
      if (dtTheme) {
        document.documentElement.dataset.theme = dtTheme;
      } else {
        document.documentElement.removeAttribute("data-theme");
      }
      toggleThemeLabelEl.textContent = "Auto";
    } else {
      document.documentElement.dataset.theme = mode;
      toggleThemeLabelEl.textContent = mode === "dark" ? "Dark" : "Light";
    }
    toggleThemeBtn.title = `Panel theme: ${toggleThemeLabelEl.textContent} (click to switch)`;
  };
  applyTheme(themeMode);

  if (transport.mode === "bridge") {
    modeBadgeEl.hidden = false;
  }

  // Child views
  const graphView = new GraphView(graphStageEl, graphMountEl, {
    onSelectNode(nodeId) {
      selectNode(nodeId, false);
    },
    onZoomChange(scale) {
      zoomLevelBtn.textContent = `${Math.round(scale * 100)}%`;
    },
  });

  const inspectorView = new InspectorView(
    inspectorBodyEl,
    inspectorSubtitleEl,
    {
      onSelectNode(nodeId) {
        selectNode(nodeId, true);
      },
      onSetStateValue(nodeId, jsonText) {
        const requestId = `req-${++requestCounter}`;
        pendingActions.set(requestId, { nodeId, kind: "set" });
        transport.send({
          type: "SET_STATE_VALUE",
          nodeId,
          jsonText,
          requestId,
        });
      },
      onEvaluateComputed(nodeId) {
        const requestId = `req-${++requestCounter}`;
        pendingActions.set(requestId, { nodeId, kind: "evaluate" });
        transport.send({
          type: "EVALUATE_COMPUTED",
          nodeId,
          requestId,
        });
      },
      onLogNode(nodeId) {
        transport.send({ type: "LOG_NODE", nodeId });
      },
    },
  );

  const timelineView = new TimelineView(
    {
      listEl: timelineBodyEl,
      countEl: timelineCountEl,
      tabCountEl: tabTimelineCountEl,
      droppedEl: timelineDroppedEl,
    },
    {
      onSelectNode(nodeId) {
        selectNode(nodeId, true);
      },
    },
  );

  function selectNode(nodeId: number | null, panIntoView: boolean): void {
    selectedNodeId = nodeId;
    renderNow();
    if (panIntoView && nodeId !== null) {
      graphView.panToNode(nodeId);
    }
  }

  function setActiveTab(tab: DrawerTab): void {
    activeTab = tab;
    workspaceEl.dataset.activeTab = tab;
    tabInspectorBtn.setAttribute("aria-selected", String(tab === "inspector"));
    tabTimelineBtn.setAttribute("aria-selected", String(tab === "timeline"));
  }

  function clearStartupTimers(): void {
    while (startupTimers.length > 0) {
      const timer = startupTimers.pop();
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  function syncFilterControls(): void {
    for (const btn of kindButtons) {
      const val = btn.dataset.kindFilter;
      btn.setAttribute("aria-pressed", String(val === filterState.kindFilter));
    }
    for (const btn of livenessButtons) {
      const val = btn.dataset.livenessFilter;
      btn.setAttribute(
        "aria-pressed",
        String(val === filterState.livenessFilter),
      );
    }
    for (const btn of eventFilterButtons) {
      const val = btn.dataset.eventFilter;
      btn.setAttribute(
        "aria-pressed",
        String(val === filterState.eventTypeFilter),
      );
    }
    filterErrorsBtn.setAttribute(
      "aria-pressed",
      String(filterState.onlyErrored),
    );
    timelineFollowBtn.setAttribute(
      "aria-pressed",
      String(filterState.followSelectionInTimeline),
    );
  }

  function syncConnectionAndSiteUI(): void {
    connectionStatusEl.dataset.state = connectionStatus;
    if (connectionStatus === "connected") {
      connectionStatusTextEl.textContent = "Connected";
      emptyBridgeStatusEl.textContent = siteOriginKey
        ? `Connected · ${siteOriginKey}`
        : "Connected to page";
    } else if (connectionStatus === "disconnected") {
      connectionStatusTextEl.textContent = "Disconnected";
      emptyBridgeStatusEl.textContent =
        "Page disconnected — waiting for navigation";
    } else {
      connectionStatusTextEl.textContent = "Connecting…";
      emptyBridgeStatusEl.textContent = "Waiting for page bridge…";
    }

    const canToggleSite =
      transport.mode === "devtools" && siteOriginKey !== null;
    if (canToggleSite && siteOriginKey) {
      siteToggleBtn.hidden = false;
      siteToggleBtn.setAttribute("aria-pressed", String(siteToggleEnabled));
      siteOriginLabelEl.textContent = siteOriginKey;
      siteOriginLabelEl.title = connectedUrl ?? siteOriginKey;

      emptySiteToggleBtn.hidden = false;
      emptySiteToggleBtn.setAttribute(
        "aria-pressed",
        String(siteToggleEnabled),
      );
      emptySiteToggleBtn.textContent = siteToggleEnabled
        ? `Enabled for ${siteOriginKey}`
        : `Enable for ${siteOriginKey}`;

      reloadTabBtn.hidden = !siteToggleDirty;
    } else {
      siteToggleBtn.hidden = true;
      emptySiteToggleBtn.hidden = true;
      reloadTabBtn.hidden = true;
    }
  }

  function toggleSiteInjection(): void {
    if (!siteOriginKey) return;
    const nextEnabled = !siteToggleEnabled;
    siteToggleEnabled = nextEnabled;
    siteToggleDirty = true;
    syncConnectionAndSiteUI();
    transport.send({
      type: "SET_SITE_TOGGLE",
      originKey: siteOriginKey,
      enabled: nextEnabled,
    });
  }

  function resetGraphFilters(): void {
    filterState = {
      ...filterState,
      query: "",
      kindFilter: "all",
      livenessFilter: "all",
      onlyErrored: false,
    };
    searchInput.value = "";
    syncFilterControls();
    renderNow();
  }

  function renderNow(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    lastRenderAt = performance.now();

    const vm = derivePanelViewModel(
      latestSnapshot,
      filterState,
      selectedNodeId,
    );

    // If previously selected node was GC'd, clear selection cleanly
    if (selectedNodeId !== null && vm.selectedNode === null) {
      selectedNodeId = null;
    }

    // Stats & hook settings
    statStatesEl.textContent = String(vm.stats.stateCount);
    statComputedsEl.textContent = String(vm.stats.computedCount);
    statWatchersEl.textContent = String(vm.stats.watcherCount);
    statEdgesEl.textContent = String(vm.stats.edgeCount);
    statErrorsEl.textContent = String(vm.stats.erroredCount);
    filterErrorsCountEl.textContent = String(vm.stats.erroredCount);

    const hasErrors = vm.stats.erroredCount > 0;
    statErrorsWrapEl.classList.toggle("has-errors", hasErrors);
    filterErrorsBtn.classList.toggle("has-errors", hasErrors);

    const isFiltered =
      vm.stats.totalNodes > 0 && vm.visibleNodes.length < vm.stats.totalNodes;
    filteredPillEl.hidden = !isFiltered;
    if (isFiltered) {
      filteredPillTextEl.textContent = `Showing ${vm.visibleNodes.length} / ${vm.stats.totalNodes}`;
    }

    const paused = vm.snapshot?.settings.paused ?? false;
    togglePauseBtn.setAttribute("aria-pressed", String(paused));
    togglePauseLabelEl.textContent = paused ? "Resume" : "Pause";

    const writeStacks = vm.snapshot?.settings.writeStacks ?? false;
    toggleStacksBtn.setAttribute("aria-pressed", String(writeStacks));

    // Runtime badges
    const rtFrag = document.createDocumentFragment();
    for (const rt of vm.snapshot?.runtimes ?? []) {
      const chip = document.createElement("span");
      chip.className = "runtime-chip";
      chip.textContent = rt.name;
      chip.title = `Runtime "${rt.name}" (${rt.mode})`;
      rtFrag.appendChild(chip);
    }
    runtimeBadgesEl.replaceChildren(rtFrag);

    // Empty state overlays & workspace empty layout
    const hasAnySignals = vm.stats.totalNodes > 0;
    workspaceEl.dataset.empty = String(!hasAnySignals);
    emptyStateEl.hidden = hasAnySignals;
    if (graphLegendEl) graphLegendEl.hidden = !hasAnySignals;
    if (graphHudEl) graphHudEl.hidden = !hasAnySignals;

    const showFilterEmpty = hasAnySignals && vm.visibleNodes.length === 0;
    filterEmptyEl.hidden = !showFilterEmpty;
    if (showFilterEmpty) {
      filterEmptySubEl.textContent = `${vm.stats.totalNodes} signal${vm.stats.totalNodes === 1 ? "" : "s"} hidden by current search or filter pills.`;
    }

    syncConnectionAndSiteUI();
    syncFilterControls();

    graphView.render(vm);
    inspectorView.render(vm);
    timelineView.render(vm);
  }

  function scheduleRender(): void {
    const elapsed = performance.now() - lastRenderAt;
    if (elapsed >= 16 && rafId === null) {
      renderNow();
      return;
    }
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      renderNow();
    });
  }

  // Transport message handling
  const unsubscribeTransport = transport.onMessage(
    (msg: BackgroundToPanelMessage) => {
      clearStartupTimers();

      switch (msg.type) {
        case "SNAPSHOT":
          latestSnapshot = msg.snapshot;
          if (connectionStatus !== "connected") {
            connectionStatus = "connected";
          }
          scheduleRender();
          break;
        case "ACTION_RESULT": {
          const pending = pendingActions.get(msg.requestId);
          if (pending) {
            pendingActions.delete(msg.requestId);
            inspectorView.showActionResult(
              pending.nodeId,
              pending.kind,
              msg.result,
            );
          }
          break;
        }
        case "PAGE_NAVIGATING": {
          latestSnapshot = null;
          selectedNodeId = null;
          connectionStatus = "connecting";
          connectedUrl = msg.url;
          const nextOrigin = normalizeOriginKey(msg.url);
          if (nextOrigin !== siteOriginKey) {
            siteOriginKey = nextOrigin;
            siteToggleEnabled = false;
            siteToggleDirty = false;
          }
          renderNow();
          break;
        }
        case "PAGE_CONNECTED": {
          connectionStatus = "connected";
          connectedUrl = msg.url;
          const nextOrigin = normalizeOriginKey(msg.url);
          if (nextOrigin !== siteOriginKey) {
            siteOriginKey = nextOrigin;
            siteToggleEnabled = false;
            siteToggleDirty = false;
          }
          if (transport.mode === "devtools" && siteOriginKey) {
            transport.send({
              type: "GET_SITE_TOGGLE",
              originKey: siteOriginKey,
            });
          }
          syncConnectionAndSiteUI();
          break;
        }
        case "PAGE_DISCONNECTED":
          connectionStatus = "disconnected";
          syncConnectionAndSiteUI();
          break;
        case "SITE_TOGGLE_STATE":
          if (msg.originKey === siteOriginKey) {
            siteToggleEnabled = msg.enabled;
            syncConnectionAndSiteUI();
          }
          break;
        case "PONG":
          break;
      }
    },
  );

  // Wire toolbar & controls
  searchInput.addEventListener("input", () => {
    filterState = { ...filterState, query: searchInput.value };
    renderNow();
  });

  for (const btn of kindButtons) {
    btn.addEventListener("click", () => {
      const value = btn.dataset.kindFilter ?? "";
      if (!isKindFilter(value)) return;
      filterState = { ...filterState, kindFilter: value };
      renderNow();
    });
  }

  for (const btn of livenessButtons) {
    btn.addEventListener("click", () => {
      const value = btn.dataset.livenessFilter ?? "";
      if (!isLivenessFilter(value)) return;
      filterState = { ...filterState, livenessFilter: value };
      renderNow();
    });
  }

  filterErrorsBtn.addEventListener("click", () => {
    filterState = { ...filterState, onlyErrored: !filterState.onlyErrored };
    renderNow();
  });

  togglePauseBtn.addEventListener("click", () => {
    const currentlyPaused = latestSnapshot?.settings.paused ?? false;
    transport.send({
      type: "CONFIGURE_HOOK",
      settings: { paused: !currentlyPaused },
    });
  });

  toggleStacksBtn.addEventListener("click", () => {
    const currentlyStacks = latestSnapshot?.settings.writeStacks ?? false;
    transport.send({
      type: "CONFIGURE_HOOK",
      settings: { writeStacks: !currentlyStacks },
    });
  });

  const handleClearTimeline = (): void => {
    transport.send({ type: "CLEAR_EVENTS" });
  };
  clearTimelineBtn.addEventListener("click", handleClearTimeline);
  timelineClearBtn.addEventListener("click", handleClearTimeline);

  fitGraphBtn.addEventListener("click", () => graphView.fitToViewport());
  graphFitBtn.addEventListener("click", () => graphView.fitToViewport());
  zoomInBtn.addEventListener("click", () => graphView.zoomBy(1.2));
  zoomOutBtn.addEventListener("click", () => graphView.zoomBy(1 / 1.2));
  zoomLevelBtn.addEventListener("click", () => graphView.resetZoom());

  toggleThemeBtn.addEventListener("click", () => {
    const next: ThemeMode =
      themeMode === "auto" ? "dark" : themeMode === "dark" ? "light" : "auto";
    applyTheme(next);
  });

  resetFiltersBtn.addEventListener("click", resetGraphFilters);
  filteredResetBtn.addEventListener("click", resetGraphFilters);

  siteToggleBtn.addEventListener("click", toggleSiteInjection);
  emptySiteToggleBtn.addEventListener("click", toggleSiteInjection);
  reloadTabBtn.addEventListener("click", () => {
    siteToggleDirty = false;
    syncConnectionAndSiteUI();
    transport.reloadPage();
  });

  tabInspectorBtn.addEventListener("click", () => setActiveTab("inspector"));
  tabTimelineBtn.addEventListener("click", () => setActiveTab("timeline"));

  for (const btn of eventFilterButtons) {
    btn.addEventListener("click", () => {
      const value = btn.dataset.eventFilter ?? "";
      if (!isEventTypeFilter(value)) return;
      filterState = { ...filterState, eventTypeFilter: value };
      renderNow();
    });
  }

  timelineFollowBtn.addEventListener("click", () => {
    filterState = {
      ...filterState,
      followSelectionInTimeline: !filterState.followSelectionInTimeline,
    };
    renderNow();
  });

  timelineCollapseBtn.addEventListener("click", () => {
    timelineCollapsed = !timelineCollapsed;
    workspaceEl.dataset.timelineCollapsed = String(timelineCollapsed);
    timelineCollapseBtn.setAttribute(
      "aria-expanded",
      String(!timelineCollapsed),
    );
  });

  // Panel-level keyboard shortcuts
  const onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (isEditableElement(event.target)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === "/") {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if (event.key === "0") {
      event.preventDefault();
      graphView.fitToViewport();
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      graphView.zoomBy(1.2);
    } else if (event.key === "-") {
      event.preventDefault();
      graphView.zoomBy(1 / 1.2);
    }
  };
  document.addEventListener("keydown", onDocumentKeyDown);

  // Initial render & inspection handshake (with gentle startup retry for iframe load race)
  setActiveTab(activeTab);
  renderNow();
  transport.send({ type: "START_INSPECTION" });

  for (const delayMs of [200, 700]) {
    startupTimers.push(
      setTimeout(() => {
        if (connectionStatus === "connecting") {
          transport.send({ type: "START_INSPECTION" });
        }
      }, delayMs),
    );
  }

  window.addEventListener("beforeunload", () => {
    clearStartupTimers();
    if (rafId !== null) cancelAnimationFrame(rafId);
    document.removeEventListener("keydown", onDocumentKeyDown);
    unsubscribeTransport();
    graphView.dispose();
    timelineView.dispose();
    transport.dispose();
  });
}

initPanel();
