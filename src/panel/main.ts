import {
  DEFAULT_FILTER_STATE,
  derivePanelViewModel,
  formatNodeDisplayName,
  type EventTypeFilter,
  type KindFilter,
  type LivenessFilter,
  type PanelFilterState,
  type PanelViewModel,
} from "./graph-state.ts";
import { GraphView } from "./graph-view.ts";
import { InspectorView } from "./inspector-view.ts";
import { TimelineView } from "./timeline-view.ts";
import { createPanelTransport } from "./transport.ts";
import {
  normalizeOriginKey,
  type BackgroundToPanelMessage,
  type GraphSnapshot,
  type SourceLocation,
} from "../protocol/types.ts";
import {
  createPaneLayoutController,
  getDefaultBottomBounds,
  getDefaultRightBounds,
} from "../shared/pane-layout.ts";
import {
  clearRuntimeTokens,
  listExcludedRuntimes,
  listIncludedRuntimes,
  matchGlob,
  parseQuery,
  rewriteFieldInclusionsToExclusions,
  setRuntimeExcludedInQuery,
  setRuntimeOnlyInQuery,
} from "../shared/query-parser.ts";
import { registerPanelShortcuts } from "../shared/shortcuts.ts";
import { createThemeController } from "../shared/theme.ts";

type ConnectionStatus = "connecting" | "connected" | "disconnected";
type DrawerTab = "inspector" | "timeline";

interface PendingAction {
  readonly nodeId: number;
  readonly kind: "set" | "evaluate";
}

const THEME_STORAGE_KEY = "tc39-signals-theme";
const PANE_LAYOUT_STORAGE_KEY = "tc39-signals-pane-layout";

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

function initPanel(): void {
  const transport = createPanelTransport();

  // DOM references
  const panelShellEl = getEl("panel-shell");
  const workspaceEl = getEl("workspace");
  const rightSplitterEl = getEl("splitter-right");
  const bottomSplitterEl = getEl("splitter-bottom");
  const graphStageEl = getEl("graph-stage");
  const graphMountEl = getEl("graph-mount");
  const emptyStateEl = getEl("empty-state");
  const emptyBridgeStatusEl = getEl("empty-bridge-status");
  const emptySiteToggleBtn = getButton("empty-site-toggle");
  const filterEmptyEl = getEl("filter-empty");
  const filterEmptyTitleEl = getEl("filter-empty-title");
  const filterEmptySubEl = getEl("filter-empty-sub");
  const resetFiltersBtn = getButton("reset-filters");

  const searchInput = getInput("search-input");
  const searchNavGroup = getEl("search-nav-group");
  const searchMatchCountEl = getEl("search-match-count");
  const searchPrevBtn = getButton("search-prev-btn");
  const searchNextBtn = getButton("search-next-btn");
  const searchClearBtn = getButton("search-clear-btn");
  const searchModeBtn = getButton("search-mode-btn");
  const filterErrorsBtn = getButton("filter-errors");
  const filterErrorsCountEl = getEl("filter-errors-count");
  const toggleInternalBtn = getButton("toggle-internal");
  const toggleInternalCountEl = getEl("toggle-internal-count");
  const runtimesDropdownWrapEl = getEl("runtimes-dropdown-wrap");
  const runtimesFilterBtn = getButton("runtimes-filter-btn");
  const runtimesPopoverEl = getEl("runtimes-popover");
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
  const focusBreadcrumbEl = getEl("focus-breadcrumb");
  const focusBreadcrumbLabelEl = getEl("focus-breadcrumb-label");
  const focusClearBtn = getButton("focus-clear-btn");

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
  let requestCounter = 0;
  let rafId: number | null = null;
  let lastRenderAt = 0;
  let activeMatchIndex = -1;
  let activeSearchMatchId: number | null = null;
  let lastVm: PanelViewModel | null = null;

  const pendingActions = new Map<string, PendingAction>();
  const startupTimers: Array<ReturnType<typeof setTimeout>> = [];

  // Theme setup (respects Chrome DevTools theme when available, otherwise auto system scheme)
  const themeController = createThemeController({
    storageKey: THEME_STORAGE_KEY,
    getDevToolsTheme: () => transport.getDevToolsTheme(),
    onChange: (preference) => {
      const label =
        preference === "auto"
          ? "Auto"
          : preference === "dark"
            ? "Dark"
            : "Light";
      toggleThemeLabelEl.textContent = label;
      toggleThemeBtn.title = `Panel theme: ${label} (click to switch)`;
    },
  });

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
      transportMode: transport.mode,
      onSelectNode(nodeId) {
        selectNode(nodeId, true);
      },
      onFocusSubgraph(nodeId) {
        filterState = { ...filterState, focusSubgraphNodeId: nodeId };
        if (nodeId !== null) {
          selectedNodeId = nodeId;
        }
        renderNow();
        graphView.fitToViewport();
      },
      onOpenSource(nodeId: number, site: SourceLocation | null) {
        void transport.openSource(nodeId, site).then((result) => {
          inspectorView.showActionResult(nodeId, "open-source", result);
        });
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

  const syncBottomCollapsedUi = (collapsed: boolean): void => {
    workspaceEl.dataset.timelineCollapsed = String(collapsed);
    timelineCollapseBtn.setAttribute("aria-expanded", String(!collapsed));
  };

  const paneLayout = createPaneLayoutController({
    rootEl: panelShellEl,
    workspaceEl,
    rightSplitterEl,
    bottomSplitterEl,
    getRightBounds: (w) => getDefaultRightBounds(Math.max(0, w - 6)),
    getBottomBounds: (h) => getDefaultBottomBounds(Math.max(0, h - 6)),
    storageKey: PANE_LAYOUT_STORAGE_KEY,
    defaultState: {
      rightWidthPx: 340,
      bottomHeightPx: 220,
      bottomCollapsed: false,
    },
    onChange: (state) => {
      syncBottomCollapsedUi(state.bottomCollapsed);
    },
  });
  syncBottomCollapsedUi(paneLayout.getState().bottomCollapsed);

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

  function reconcileActiveMatch(vm: PanelViewModel): number | null {
    const matches = vm.orderedMatchIds;
    if (matches.length === 0) {
      activeMatchIndex = -1;
      activeSearchMatchId = null;
      return null;
    }
    if (activeSearchMatchId !== null) {
      const existingIdx = matches.indexOf(activeSearchMatchId);
      if (existingIdx !== -1) {
        activeMatchIndex = existingIdx;
        return activeSearchMatchId;
      }
    }
    const clampedIdx =
      activeMatchIndex >= 0 && activeMatchIndex < matches.length
        ? activeMatchIndex
        : 0;
    activeMatchIndex = clampedIdx;
    activeSearchMatchId = matches[clampedIdx] ?? null;
    return activeSearchMatchId;
  }

  function updateSearchControls(vm: PanelViewModel): void {
    const isFilterMode = filterState.queryMode === "filter";
    searchModeBtn.textContent = isFilterMode ? "Filter" : "Highlight";
    searchModeBtn.setAttribute("aria-pressed", String(isFilterMode));
    searchModeBtn.title = isFilterMode
      ? "Search mode: Filter graph to matches only (click to switch to Highlight)"
      : "Search mode: Highlight matches in graph (click to switch to Filter)";

    const parsed = parseQuery(filterState.query);
    const hasPositiveInclusions = parsed.inclusions.length > 0;
    const totalMatches = vm.orderedMatchIds.length;

    if (!hasPositiveInclusions) {
      searchNavGroup.hidden = true;
      searchMatchCountEl.textContent = "0/0";
      searchMatchCountEl.classList.remove("is-no-match");
      return;
    }

    searchNavGroup.hidden = false;
    if (totalMatches > 0) {
      const displayIdx = activeMatchIndex >= 0 ? activeMatchIndex + 1 : 1;
      searchMatchCountEl.textContent = `${displayIdx}/${totalMatches}`;
      searchMatchCountEl.classList.remove("is-no-match");
      searchPrevBtn.disabled = false;
      searchNextBtn.disabled = false;
    } else {
      searchMatchCountEl.textContent = "0/0";
      searchMatchCountEl.classList.add("is-no-match");
      searchPrevBtn.disabled = true;
      searchNextBtn.disabled = true;
    }
  }

  function applyQueryUpdate(
    nextQuery: string,
    options: { readonly resetMatch: boolean; readonly fit: boolean },
  ): void {
    if (searchInput.value !== nextQuery) {
      searchInput.value = nextQuery;
    }
    if (options.resetMatch) {
      activeMatchIndex = 0;
      activeSearchMatchId = null;
    }
    filterState = { ...filterState, query: nextQuery };
    renderNow();
    if (options.fit) {
      graphView.fitToViewport();
    }
  }

  function stepSearchMatch(delta: 1 | -1): void {
    const matches = lastVm?.orderedMatchIds ?? [];
    if (matches.length === 0) return;
    const baseIndex = activeMatchIndex < 0 ? 0 : activeMatchIndex;
    const nextIndex = (baseIndex + delta + matches.length) % matches.length;
    activeMatchIndex = nextIndex;
    activeSearchMatchId = matches[nextIndex] ?? null;
    renderNow();
    if (activeSearchMatchId !== null) {
      graphView.panToNode(activeSearchMatchId);
    }
  }

  function clearSearch(): void {
    applyQueryUpdate("", {
      resetMatch: true,
      fit: filterState.queryMode === "filter",
    });
  }

  function updateRuntimesButton(vm: PanelViewModel): void {
    const total = vm.runtimeInventory.length;
    const excludedCount = vm.runtimeInventory.filter((r) => r.excluded).length;
    const includedCount = vm.runtimeInventory.filter((r) => r.included).length;
    const hasRuntimeQuery =
      listExcludedRuntimes(filterState.query).length > 0 ||
      listIncludedRuntimes(filterState.query).length > 0;

    if (hasRuntimeQuery || excludedCount > 0 || includedCount > 0) {
      runtimesFilterBtn.dataset.active = "true";
    } else {
      delete runtimesFilterBtn.dataset.active;
    }

    if (excludedCount > 0 && total > 0) {
      runtimesFilterBtn.textContent = `Runtimes (${total - excludedCount}/${total}) ▾`;
    } else if (includedCount > 0) {
      runtimesFilterBtn.textContent = `Runtimes (${includedCount}) ▾`;
    } else if (total > 0) {
      runtimesFilterBtn.textContent = `Runtimes (${total}) ▾`;
    } else {
      runtimesFilterBtn.textContent = "Runtimes ▾";
    }
  }

  function renderRuntimesPopover(vm: PanelViewModel): void {
    const header = document.createElement("div");
    header.className = "runtimes-popover-header";

    const title = document.createElement("span");
    title.className = "runtimes-popover-title";
    title.textContent = "Signal Runtimes";

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "runtimes-popover-reset";
    resetBtn.textContent = "Show all";
    const hasRuntimeTokens =
      listExcludedRuntimes(filterState.query).length > 0 ||
      listIncludedRuntimes(filterState.query).length > 0;
    resetBtn.disabled = !hasRuntimeTokens;
    resetBtn.addEventListener("click", () => {
      const nextQuery = clearRuntimeTokens(filterState.query);
      applyQueryUpdate(nextQuery, { resetMatch: false, fit: true });
    });

    header.append(title, resetBtn);

    const body = document.createElement("div");
    body.className = "runtimes-popover-body";

    if (vm.runtimeInventory.length === 0) {
      const empty = document.createElement("div");
      empty.className = "runtimes-empty";
      empty.textContent = "No signal runtimes tracked yet.";
      body.append(empty);
      runtimesPopoverEl.replaceChildren(header, body);
      return;
    }

    const includedRuntimes = listIncludedRuntimes(filterState.query);
    const allRuntimeNames = vm.runtimeInventory.map((entry) => entry.name);
    const filterByInclusions =
      filterState.queryMode === "filter" && includedRuntimes.length > 0;
    const isRuntimeChecked = (
      entry: (typeof vm.runtimeInventory)[number],
    ): boolean =>
      !entry.excluded &&
      (!filterByInclusions ||
        includedRuntimes.every((inc) => matchGlob(inc, entry.name)));

    for (const entry of vm.runtimeInventory) {
      const row = document.createElement("div");
      row.className = "runtimes-row";

      const label = document.createElement("label");
      label.className = "runtimes-toggle-label";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "runtimes-checkbox";
      checkbox.checked = isRuntimeChecked(entry);
      checkbox.addEventListener("change", () => {
        if (filterByInclusions) {
          const nextIncluded = vm.runtimeInventory
            .filter((r) =>
              r.name.toLowerCase() === entry.name.toLowerCase()
                ? checkbox.checked
                : isRuntimeChecked(r),
            )
            .map((r) => r.name);
          const nextQuery = rewriteFieldInclusionsToExclusions(
            filterState.query,
            "runtime",
            nextIncluded,
            allRuntimeNames,
          );
          applyQueryUpdate(nextQuery, { resetMatch: false, fit: true });
          return;
        }
        const nextQuery = setRuntimeExcludedInQuery(
          filterState.query,
          entry.name,
          !checkbox.checked,
          allRuntimeNames,
        );
        applyQueryUpdate(nextQuery, { resetMatch: false, fit: true });
      });

      const nameSpan = document.createElement("span");
      nameSpan.className = "runtimes-name";
      nameSpan.textContent = entry.name;
      nameSpan.title = `${entry.name} (${entry.mode})`;

      const modeSpan = document.createElement("span");
      modeSpan.className = "runtimes-mode";
      modeSpan.textContent = entry.mode;

      const countSpan = document.createElement("span");
      countSpan.className = "runtimes-count";
      countSpan.textContent = String(entry.count);

      label.append(checkbox, nameSpan, modeSpan, countSpan);

      const onlyBtn = document.createElement("button");
      onlyBtn.type = "button";
      onlyBtn.className = "runtimes-only-btn";
      onlyBtn.textContent = "Only";
      const isOnly =
        includedRuntimes.length === 1 &&
        includedRuntimes[0]?.toLowerCase() === entry.name.toLowerCase();
      onlyBtn.setAttribute("aria-pressed", String(isOnly));
      onlyBtn.addEventListener("click", () => {
        const nextQuery = isOnly
          ? clearRuntimeTokens(filterState.query)
          : setRuntimeOnlyInQuery(filterState.query, entry.name);
        applyQueryUpdate(nextQuery, {
          resetMatch: true,
          fit: filterState.queryMode === "filter",
        });
      });

      row.append(label, onlyBtn);
      body.append(row);
    }

    runtimesPopoverEl.replaceChildren(header, body);
  }

  function closeRuntimesPopover(): void {
    if (runtimesPopoverEl.hidden) return;
    runtimesPopoverEl.hidden = true;
    runtimesFilterBtn.setAttribute("aria-expanded", "false");
  }

  function openRuntimesPopover(): void {
    const btnRect = runtimesFilterBtn.getBoundingClientRect();
    runtimesPopoverEl.classList.toggle(
      "is-align-end",
      btnRect.left + 260 > window.innerWidth,
    );
    runtimesPopoverEl.hidden = false;
    runtimesFilterBtn.setAttribute("aria-expanded", "true");
    if (lastVm) {
      renderRuntimesPopover(lastVm);
    }
  }

  function resetGraphFilters(): void {
    filterState = {
      ...filterState,
      query: "",
      kindFilter: "all",
      livenessFilter: "all",
      onlyErrored: false,
      showInternal: false,
      focusSubgraphNodeId: null,
    };
    searchInput.value = "";
    activeMatchIndex = -1;
    activeSearchMatchId = null;
    closeRuntimesPopover();
    syncFilterControls();
    renderNow();
    graphView.fitToViewport();
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
    lastVm = vm;
    const activeMatchId = reconcileActiveMatch(vm);

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

    const internalCount = vm.stats.internalCount;
    toggleInternalCountEl.textContent = String(internalCount);
    toggleInternalBtn.hidden = internalCount === 0;
    toggleInternalBtn.setAttribute(
      "aria-pressed",
      String(filterState.showInternal),
    );

    const baselineTotal = filterState.showInternal
      ? vm.stats.totalNodes
      : vm.stats.totalNodes - internalCount;
    const isFiltered =
      baselineTotal > 0 && vm.visibleNodes.length < baselineTotal;
    filteredPillEl.hidden = !isFiltered;
    if (isFiltered) {
      filteredPillTextEl.textContent = `Showing ${vm.visibleNodes.length} / ${baselineTotal}`;
    }

    if (vm.focusedNode) {
      focusBreadcrumbEl.hidden = false;
      focusBreadcrumbLabelEl.textContent = `Focused: ${formatNodeDisplayName(vm.focusedNode)} #${vm.focusedNode.id}`;
    } else {
      focusBreadcrumbEl.hidden = true;
      focusBreadcrumbLabelEl.textContent = "";
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
    panelShellEl.dataset.empty = String(!hasAnySignals);
    workspaceEl.dataset.empty = String(!hasAnySignals);
    emptyStateEl.hidden = hasAnySignals;
    if (graphLegendEl) graphLegendEl.hidden = !hasAnySignals;
    if (graphHudEl) graphHudEl.hidden = !hasAnySignals;

    const showFilterEmpty = hasAnySignals && vm.visibleNodes.length === 0;
    filterEmptyEl.hidden = !showFilterEmpty;
    if (showFilterEmpty) {
      if (
        baselineTotal === 0 &&
        internalCount > 0 &&
        !filterState.showInternal
      ) {
        filterEmptyTitleEl.textContent = "Only internal signals detected";
        filterEmptySubEl.textContent = `${internalCount} internal signal${internalCount === 1 ? "" : "s"} hidden by default.`;
        resetFiltersBtn.textContent = "Show internal signals";
      } else {
        const hiddenCount = filterState.showInternal
          ? vm.stats.totalNodes
          : baselineTotal;
        filterEmptyTitleEl.textContent = "No signals match the active filters";
        filterEmptySubEl.textContent = `${hiddenCount} signal${hiddenCount === 1 ? "" : "s"} hidden by current search or filter pills.`;
        resetFiltersBtn.textContent = "Reset filters";
      }
    }

    syncConnectionAndSiteUI();
    syncFilterControls();
    updateSearchControls(vm);
    updateRuntimesButton(vm);
    if (!runtimesPopoverEl.hidden) {
      renderRuntimesPopover(vm);
    }

    graphView.render(vm, activeMatchId);
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
          if (
            filterState.focusSubgraphNodeId !== null &&
            !msg.snapshot.nodes.some(
              (n) => n.id === filterState.focusSubgraphNodeId,
            )
          ) {
            filterState = { ...filterState, focusSubgraphNodeId: null };
          }
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
          filterState = { ...filterState, focusSubgraphNodeId: null };
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

  // Wire search & filter controls
  searchInput.addEventListener("input", () => {
    applyQueryUpdate(searchInput.value, {
      resetMatch: true,
      fit: filterState.queryMode === "filter",
    });
  });

  searchInput.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Enter") {
      event.preventDefault();
      stepSearchMatch(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      if (searchInput.value.length > 0) {
        event.preventDefault();
        clearSearch();
      } else {
        searchInput.blur();
      }
    }
  });

  searchModeBtn.addEventListener("click", () => {
    filterState = {
      ...filterState,
      queryMode: filterState.queryMode === "highlight" ? "filter" : "highlight",
    };
    renderNow();
    if (parseQuery(filterState.query).inclusions.length > 0) {
      graphView.fitToViewport();
    }
  });

  searchPrevBtn.addEventListener("click", () => stepSearchMatch(-1));
  searchNextBtn.addEventListener("click", () => stepSearchMatch(1));
  searchClearBtn.addEventListener("click", () => {
    clearSearch();
    searchInput.focus();
  });

  for (const btn of kindButtons) {
    btn.addEventListener("click", () => {
      const value = btn.dataset.kindFilter ?? "";
      if (!isKindFilter(value)) return;
      filterState = { ...filterState, kindFilter: value };
      renderNow();
      graphView.fitToViewport();
    });
  }

  for (const btn of livenessButtons) {
    btn.addEventListener("click", () => {
      const value = btn.dataset.livenessFilter ?? "";
      if (!isLivenessFilter(value)) return;
      filterState = { ...filterState, livenessFilter: value };
      renderNow();
      graphView.fitToViewport();
    });
  }

  filterErrorsBtn.addEventListener("click", () => {
    filterState = { ...filterState, onlyErrored: !filterState.onlyErrored };
    renderNow();
    graphView.fitToViewport();
  });

  toggleInternalBtn.addEventListener("click", () => {
    filterState = { ...filterState, showInternal: !filterState.showInternal };
    renderNow();
    graphView.fitToViewport();
  });

  runtimesFilterBtn.addEventListener("click", () => {
    if (runtimesPopoverEl.hidden) {
      openRuntimesPopover();
    } else {
      closeRuntimesPopover();
    }
  });

  runtimesPopoverEl.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeRuntimesPopover();
      runtimesFilterBtn.focus();
    }
  });

  const onDocumentPointerDown = (event: PointerEvent): void => {
    if (runtimesPopoverEl.hidden) return;
    const target = event.target;
    if (target instanceof Node && !runtimesDropdownWrapEl.contains(target)) {
      closeRuntimesPopover();
    }
  };
  document.addEventListener("pointerdown", onDocumentPointerDown);

  focusClearBtn.addEventListener("click", () => {
    filterState = { ...filterState, focusSubgraphNodeId: null };
    renderNow();
    graphView.fitToViewport();
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
    themeController.cycle();
  });

  resetFiltersBtn.addEventListener("click", () => {
    const onlyInternalHidden =
      lastVm !== null &&
      lastVm.stats.totalNodes > 0 &&
      lastVm.stats.internalCount === lastVm.stats.totalNodes &&
      !filterState.showInternal;
    if (onlyInternalHidden) {
      filterState = {
        ...filterState,
        query: "",
        kindFilter: "all",
        livenessFilter: "all",
        onlyErrored: false,
        showInternal: true,
        focusSubgraphNodeId: null,
      };
      searchInput.value = "";
      activeMatchIndex = -1;
      activeSearchMatchId = null;
      closeRuntimesPopover();
      syncFilterControls();
      renderNow();
      graphView.fitToViewport();
      return;
    }
    resetGraphFilters();
  });
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
    paneLayout.toggleBottomCollapsed();
  });

  // Panel-level keyboard shortcuts
  const disposeShortcuts = registerPanelShortcuts(window, {
    onSearch: () => {
      searchInput.focus();
      searchInput.select();
    },
    onEscape: () => {
      if (!runtimesPopoverEl.hidden) {
        closeRuntimesPopover();
        return true;
      }
      if (filterState.focusSubgraphNodeId !== null) {
        filterState = { ...filterState, focusSubgraphNodeId: null };
        renderNow();
        return true;
      }
      if (selectedNodeId !== null) {
        selectedNodeId = null;
        renderNow();
        return true;
      }
      return false;
    },
    onFit: () => graphView.fitToViewport(),
    onZoomIn: () => graphView.zoomBy(1.2),
    onZoomOut: () => graphView.zoomBy(1 / 1.2),
  });

  // DevTools Ctrl+F / Cmd+F integration
  const handleDevtoolsSearch = (action: string, query?: string): void => {
    switch (action) {
      case "performSearch": {
        applyQueryUpdate(query ?? "", {
          resetMatch: true,
          fit: filterState.queryMode === "filter",
        });
        if (
          filterState.queryMode === "highlight" &&
          activeSearchMatchId !== null
        ) {
          graphView.panToNode(activeSearchMatchId);
        }
        break;
      }
      case "nextSearchResult":
        stepSearchMatch(1);
        break;
      case "previousSearchResult":
        stepSearchMatch(-1);
        break;
      case "cancelSearch":
        clearSearch();
        break;
    }
  };

  Reflect.set(window, "__SIGNALS_DEVTOOLS_ON_SEARCH__", handleDevtoolsSearch);

  const pendingSearchRaw: unknown = Reflect.get(
    window,
    "__SIGNALS_DEVTOOLS_PENDING_SEARCH__",
  );
  if (pendingSearchRaw !== null && typeof pendingSearchRaw === "object") {
    const action: unknown = Reflect.get(pendingSearchRaw, "action");
    const queryString: unknown = Reflect.get(pendingSearchRaw, "queryString");
    Reflect.deleteProperty(window, "__SIGNALS_DEVTOOLS_PENDING_SEARCH__");
    if (typeof action === "string") {
      handleDevtoolsSearch(
        action,
        typeof queryString === "string" ? queryString : undefined,
      );
    }
  }

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
    disposeShortcuts();
    document.removeEventListener("pointerdown", onDocumentPointerDown);
    Reflect.deleteProperty(window, "__SIGNALS_DEVTOOLS_ON_SEARCH__");
    themeController.dispose();
    paneLayout.dispose();
    unsubscribeTransport();
    graphView.dispose();
    timelineView.dispose();
    transport.dispose();
  });
}

initPanel();
