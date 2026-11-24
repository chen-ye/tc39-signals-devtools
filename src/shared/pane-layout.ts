export interface PaneLayoutState {
  readonly rightWidthPx: number;
  readonly bottomHeightPx: number;
  readonly bottomCollapsed: boolean;
}

export interface SplitterRange {
  readonly min: number;
  readonly max: number;
}

export interface PaneLayoutBounds {
  readonly minRight?: number | undefined;
  readonly minGraphWidth?: number | undefined;
  readonly minBottom?: number | undefined;
  readonly minGraphHeight?: number | undefined;
}

export interface ContainerSize {
  readonly width: number;
  readonly height: number;
}

export interface PaneRootElement {
  readonly style: {
    setProperty(property: string, value: string | null): void;
  };
  readonly dataset: Record<string, string | undefined>;
}

export interface PaneWorkspaceElement {
  getBoundingClientRect(): { readonly width: number; readonly height: number };
}

export interface PaneSplitterElement {
  setAttribute(qualifiedName: string, value: string): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void;
  setPointerCapture?(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
}

export interface PaneLayoutControllerOptions {
  readonly rootEl: PaneRootElement;
  readonly workspaceEl: PaneWorkspaceElement;
  readonly rightSplitterEl?: PaneSplitterElement | null | undefined;
  readonly bottomSplitterEl?: PaneSplitterElement | null | undefined;
  readonly getRightBounds?:
    ((containerWidth: number) => SplitterRange) | undefined;
  readonly getBottomBounds?:
    ((containerHeight: number) => SplitterRange) | undefined;
  readonly storageKey: string;
  readonly defaultState: PaneLayoutState;
  readonly collapseSnapThresholdPx?: number | undefined;
  readonly onChange?: ((state: PaneLayoutState) => void) | undefined;
}

export interface PaneLayoutController {
  getState(): PaneLayoutState;
  setState(next: Partial<PaneLayoutState>): void;
  setBottomCollapsed(collapsed: boolean): void;
  toggleBottomCollapsed(): boolean;
  resetRightWidth(): void;
  refresh(): void;
  dispose(): void;
}

export const DEFAULT_PANE_BOUNDS = {
  minRight: 240,
  minGraphWidth: 280,
  minBottom: 130,
  minGraphHeight: 180,
} as const;

const DEFAULT_COLLAPSE_SNAP_THRESHOLD_PX = 56;
const KEYBOARD_STEP_PX = 16;
const KEYBOARD_SHIFT_STEP_PX = 48;

function clampToRange(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const effectiveMax = Math.max(min, max);
  return Math.min(effectiveMax, Math.max(min, Math.round(value)));
}

export function getDefaultRightBounds(
  containerWidth: number,
  bounds?: PaneLayoutBounds,
): SplitterRange {
  const min = bounds?.minRight ?? DEFAULT_PANE_BOUNDS.minRight;
  const minGraph = bounds?.minGraphWidth ?? DEFAULT_PANE_BOUNDS.minGraphWidth;
  const max =
    containerWidth > 0
      ? Math.max(min, Math.floor(containerWidth - minGraph))
      : min;
  return { min, max };
}

export function getDefaultBottomBounds(
  containerHeight: number,
  bounds?: PaneLayoutBounds,
): SplitterRange {
  const min = bounds?.minBottom ?? DEFAULT_PANE_BOUNDS.minBottom;
  const minGraph = bounds?.minGraphHeight ?? DEFAULT_PANE_BOUNDS.minGraphHeight;
  const max =
    containerHeight > 0
      ? Math.max(min, Math.floor(containerHeight - minGraph))
      : min;
  return { min, max };
}

export function clampRightWidth(
  widthPx: number,
  containerWidth: number,
  bounds?: PaneLayoutBounds,
): number {
  const range = getDefaultRightBounds(containerWidth, bounds);
  if (containerWidth <= 0) {
    return Number.isFinite(widthPx)
      ? Math.max(range.min, Math.round(widthPx))
      : range.min;
  }
  return clampToRange(widthPx, range.min, range.max);
}

export function clampBottomHeight(
  heightPx: number,
  containerHeight: number,
  bounds?: PaneLayoutBounds,
): number {
  const range = getDefaultBottomBounds(containerHeight, bounds);
  if (containerHeight <= 0) {
    return Number.isFinite(heightPx)
      ? Math.max(range.min, Math.round(heightPx))
      : range.min;
  }
  return clampToRange(heightPx, range.min, range.max);
}

export function clampPaneLayoutState(
  state: PaneLayoutState,
  containerSize: ContainerSize,
  bounds?: PaneLayoutBounds,
): PaneLayoutState {
  return {
    rightWidthPx: clampRightWidth(
      state.rightWidthPx,
      containerSize.width,
      bounds,
    ),
    bottomHeightPx: clampBottomHeight(
      state.bottomHeightPx,
      containerSize.height,
      bounds,
    ),
    bottomCollapsed: state.bottomCollapsed,
  };
}

export function serializePaneLayout(state: PaneLayoutState): string {
  return JSON.stringify({
    rightWidthPx: Math.round(state.rightWidthPx),
    bottomHeightPx: Math.round(state.bottomHeightPx),
    bottomCollapsed: state.bottomCollapsed,
  });
}

export function deserializePaneLayout(
  raw: string | null,
  fallback: PaneLayoutState,
): PaneLayoutState {
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return fallback;
    const rightWidthRaw = Reflect.get(parsed, "rightWidthPx");
    const bottomHeightRaw = Reflect.get(parsed, "bottomHeightPx");
    const bottomCollapsedRaw = Reflect.get(parsed, "bottomCollapsed");

    return {
      rightWidthPx:
        typeof rightWidthRaw === "number" && Number.isFinite(rightWidthRaw)
          ? rightWidthRaw
          : fallback.rightWidthPx,
      bottomHeightPx:
        typeof bottomHeightRaw === "number" && Number.isFinite(bottomHeightRaw)
          ? bottomHeightRaw
          : fallback.bottomHeightPx,
      bottomCollapsed:
        typeof bottomCollapsedRaw === "boolean"
          ? bottomCollapsedRaw
          : fallback.bottomCollapsed,
    };
  } catch {
    return fallback;
  }
}

export function readStoredPaneLayout(
  storageKey: string,
  fallback: PaneLayoutState,
): PaneLayoutState {
  if (typeof window === "undefined") return fallback;
  try {
    return deserializePaneLayout(
      window.localStorage.getItem(storageKey),
      fallback,
    );
  } catch {
    return fallback;
  }
}

export function writeStoredPaneLayout(
  storageKey: string,
  state: PaneLayoutState,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, serializePaneLayout(state));
  } catch {
    // Storage may be unavailable in restricted contexts
  }
}

function isPointerEventLike(evt: Event): evt is Event & {
  readonly button: number;
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
} {
  if (typeof PointerEvent !== "undefined" && evt instanceof PointerEvent) {
    return true;
  }
  return (
    typeof Reflect.get(evt, "pointerId") === "number" &&
    typeof Reflect.get(evt, "clientX") === "number" &&
    typeof Reflect.get(evt, "clientY") === "number"
  );
}

function isKeyboardEventLike(evt: Event): evt is Event & {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
} {
  if (typeof KeyboardEvent !== "undefined" && evt instanceof KeyboardEvent) {
    return true;
  }
  return typeof Reflect.get(evt, "key") === "string";
}

export function createPaneLayoutController(
  options: PaneLayoutControllerOptions,
): PaneLayoutController {
  const {
    rootEl,
    workspaceEl,
    rightSplitterEl,
    bottomSplitterEl,
    getRightBounds,
    getBottomBounds,
    storageKey,
    defaultState,
    onChange,
  } = options;
  const collapseSnapThresholdPx =
    options.collapseSnapThresholdPx ?? DEFAULT_COLLAPSE_SNAP_THRESHOLD_PX;

  const measureWorkspace = (): ContainerSize => {
    const rect = workspaceEl.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  };

  const resolveRightRange = (containerWidth: number): SplitterRange => {
    if (getRightBounds) {
      const custom = getRightBounds(containerWidth);
      return {
        min: custom.min,
        max: Math.max(custom.min, custom.max),
      };
    }
    return getDefaultRightBounds(containerWidth);
  };

  const resolveBottomRange = (containerHeight: number): SplitterRange => {
    if (getBottomBounds) {
      const custom = getBottomBounds(containerHeight);
      return {
        min: custom.min,
        max: Math.max(custom.min, custom.max),
      };
    }
    return getDefaultBottomBounds(containerHeight);
  };

  const clampAgainstWorkspace = (
    candidate: PaneLayoutState,
  ): PaneLayoutState => {
    const size = measureWorkspace();
    const rightRange = resolveRightRange(size.width);
    const bottomRange = resolveBottomRange(size.height);

    const rightWidthPx =
      size.width > 0
        ? clampToRange(candidate.rightWidthPx, rightRange.min, rightRange.max)
        : Number.isFinite(candidate.rightWidthPx)
          ? Math.max(rightRange.min, Math.round(candidate.rightWidthPx))
          : rightRange.min;

    const bottomHeightPx =
      size.height > 0
        ? clampToRange(
            candidate.bottomHeightPx,
            bottomRange.min,
            bottomRange.max,
          )
        : Number.isFinite(candidate.bottomHeightPx)
          ? Math.max(bottomRange.min, Math.round(candidate.bottomHeightPx))
          : bottomRange.min;

    return {
      rightWidthPx,
      bottomHeightPx,
      bottomCollapsed: candidate.bottomCollapsed,
    };
  };

  const clampPreferredMinimums = (
    candidate: PaneLayoutState,
  ): PaneLayoutState => {
    const size = measureWorkspace();
    const rightRange = resolveRightRange(size.width);
    const bottomRange = resolveBottomRange(size.height);

    const rightWidthPx = Number.isFinite(candidate.rightWidthPx)
      ? Math.max(rightRange.min, Math.round(candidate.rightWidthPx))
      : rightRange.min;
    const bottomHeightPx = Number.isFinite(candidate.bottomHeightPx)
      ? Math.max(bottomRange.min, Math.round(candidate.bottomHeightPx))
      : bottomRange.min;

    return {
      rightWidthPx,
      bottomHeightPx,
      bottomCollapsed: candidate.bottomCollapsed,
    };
  };

  let state = clampPreferredMinimums(
    readStoredPaneLayout(storageKey, defaultState),
  );

  const applyDom = (): void => {
    const size = measureWorkspace();
    const rightRange = resolveRightRange(size.width);
    const bottomRange = resolveBottomRange(size.height);
    const applied = clampAgainstWorkspace(state);

    rootEl.style.setProperty("--right-pane-size", `${applied.rightWidthPx}px`);
    rootEl.style.setProperty(
      "--bottom-pane-size",
      applied.bottomCollapsed ? "0px" : `${applied.bottomHeightPx}px`,
    );
    rootEl.dataset.bottomCollapsed = applied.bottomCollapsed ? "true" : "false";

    if (rightSplitterEl) {
      rightSplitterEl.setAttribute("aria-valuemin", String(rightRange.min));
      rightSplitterEl.setAttribute(
        "aria-valuemax",
        String(Math.max(rightRange.min, rightRange.max)),
      );
      rightSplitterEl.setAttribute(
        "aria-valuenow",
        String(applied.rightWidthPx),
      );
    }

    if (bottomSplitterEl) {
      bottomSplitterEl.setAttribute("aria-valuemin", String(bottomRange.min));
      bottomSplitterEl.setAttribute(
        "aria-valuemax",
        String(Math.max(bottomRange.min, bottomRange.max)),
      );
      bottomSplitterEl.setAttribute(
        "aria-valuenow",
        String(applied.bottomCollapsed ? 0 : applied.bottomHeightPx),
      );
    }
  };

  const commitState = (
    next: PaneLayoutState,
    persist = true,
    notify = true,
  ): void => {
    const clamped = clampAgainstWorkspace(next);
    const changed =
      clamped.rightWidthPx !== state.rightWidthPx ||
      clamped.bottomHeightPx !== state.bottomHeightPx ||
      clamped.bottomCollapsed !== state.bottomCollapsed;
    state = clamped;
    applyDom();
    if (persist) {
      writeStoredPaneLayout(storageKey, state);
    }
    if (notify && changed) {
      onChange?.(state);
    }
  };

  applyDom();

  let activeDrag: {
    readonly axis: "right" | "bottom";
    readonly pointerId: number;
    readonly startCoord: number;
    readonly startSize: number;
    readonly splitterEl: PaneSplitterElement;
  } | null = null;

  const endDrag = (pointerId: number): void => {
    if (!activeDrag || activeDrag.pointerId !== pointerId) return;
    const { splitterEl } = activeDrag;
    activeDrag = null;
    delete rootEl.dataset.resizing;
    try {
      splitterEl.releasePointerCapture?.(pointerId);
    } catch {
      // Ignore if pointer capture is unsupported or already released
    }
  };

  const onRightPointerDown = (evt: Event): void => {
    if (!isPointerEventLike(evt) || evt.button !== 0 || !rightSplitterEl) {
      return;
    }
    evt.preventDefault();
    const currentApplied = clampAgainstWorkspace(state);
    activeDrag = {
      axis: "right",
      pointerId: evt.pointerId,
      startCoord: evt.clientX,
      startSize: currentApplied.rightWidthPx,
      splitterEl: rightSplitterEl,
    };
    rootEl.dataset.resizing = "right";
    try {
      rightSplitterEl.setPointerCapture?.(evt.pointerId);
    } catch {
      // Ignore synthetic events in tests
    }
  };

  const onBottomPointerDown = (evt: Event): void => {
    if (!isPointerEventLike(evt) || evt.button !== 0 || !bottomSplitterEl) {
      return;
    }
    evt.preventDefault();
    const currentApplied = clampAgainstWorkspace(state);
    activeDrag = {
      axis: "bottom",
      pointerId: evt.pointerId,
      startCoord: evt.clientY,
      startSize: currentApplied.bottomCollapsed
        ? 0
        : currentApplied.bottomHeightPx,
      splitterEl: bottomSplitterEl,
    };
    rootEl.dataset.resizing = "bottom";
    try {
      bottomSplitterEl.setPointerCapture?.(evt.pointerId);
    } catch {
      // Ignore synthetic events in tests
    }
  };

  const onPointerMove = (evt: Event): void => {
    if (
      !isPointerEventLike(evt) ||
      !activeDrag ||
      evt.pointerId !== activeDrag.pointerId
    ) {
      return;
    }
    if (activeDrag.axis === "right") {
      const dx = activeDrag.startCoord - evt.clientX;
      commitState({
        ...state,
        rightWidthPx: activeDrag.startSize + dx,
      });
      return;
    }

    const dy = activeDrag.startCoord - evt.clientY;
    const rawHeight = activeDrag.startSize + dy;
    if (rawHeight < collapseSnapThresholdPx) {
      commitState({
        ...state,
        bottomCollapsed: true,
      });
    } else {
      commitState({
        ...state,
        bottomCollapsed: false,
        bottomHeightPx: rawHeight,
      });
    }
  };

  const onPointerUp = (evt: Event): void => {
    const pid: unknown = Reflect.get(evt, "pointerId");
    if (typeof pid === "number") {
      endDrag(pid);
    }
  };

  const onRightDoubleClick = (): void => {
    commitState({
      ...state,
      rightWidthPx: defaultState.rightWidthPx,
    });
  };

  const onBottomDoubleClick = (): void => {
    commitState({
      ...state,
      bottomCollapsed: !state.bottomCollapsed,
    });
  };

  const onRightKeyDown = (evt: Event): void => {
    if (!isKeyboardEventLike(evt)) return;
    if (evt.ctrlKey || evt.metaKey || evt.altKey) return;
    const size = measureWorkspace();
    const range = resolveRightRange(size.width);
    const step = evt.shiftKey ? KEYBOARD_SHIFT_STEP_PX : KEYBOARD_STEP_PX;

    const currentApplied = clampAgainstWorkspace(state);
    switch (evt.key) {
      case "ArrowLeft":
        evt.preventDefault();
        commitState({
          ...state,
          rightWidthPx: currentApplied.rightWidthPx + step,
        });
        break;
      case "ArrowRight":
        evt.preventDefault();
        commitState({
          ...state,
          rightWidthPx: currentApplied.rightWidthPx - step,
        });
        break;
      case "Home":
        evt.preventDefault();
        commitState({ ...state, rightWidthPx: range.min });
        break;
      case "End":
        evt.preventDefault();
        commitState({ ...state, rightWidthPx: range.max });
        break;
      case "Enter":
        evt.preventDefault();
        commitState({ ...state, rightWidthPx: defaultState.rightWidthPx });
        break;
    }
  };

  const onBottomKeyDown = (evt: Event): void => {
    if (!isKeyboardEventLike(evt)) return;
    if (evt.ctrlKey || evt.metaKey || evt.altKey) return;
    const size = measureWorkspace();
    const range = resolveBottomRange(size.height);
    const step = evt.shiftKey ? KEYBOARD_SHIFT_STEP_PX : KEYBOARD_STEP_PX;
    const currentApplied = clampAgainstWorkspace(state);

    switch (evt.key) {
      case "ArrowUp":
        evt.preventDefault();
        commitState({
          ...state,
          bottomCollapsed: false,
          bottomHeightPx: currentApplied.bottomCollapsed
            ? range.min
            : currentApplied.bottomHeightPx + step,
        });
        break;
      case "ArrowDown":
        evt.preventDefault();
        if (!currentApplied.bottomCollapsed) {
          commitState({
            ...state,
            bottomHeightPx: currentApplied.bottomHeightPx - step,
          });
        }
        break;
      case "Home":
        evt.preventDefault();
        commitState({
          ...state,
          bottomCollapsed: false,
          bottomHeightPx: range.min,
        });
        break;
      case "End":
        evt.preventDefault();
        commitState({
          ...state,
          bottomCollapsed: false,
          bottomHeightPx: range.max,
        });
        break;
      case "Enter":
      case " ":
        evt.preventDefault();
        commitState({
          ...state,
          bottomCollapsed: !state.bottomCollapsed,
        });
        break;
    }
  };

  rightSplitterEl?.addEventListener("pointerdown", onRightPointerDown);
  rightSplitterEl?.addEventListener("pointermove", onPointerMove);
  rightSplitterEl?.addEventListener("pointerup", onPointerUp);
  rightSplitterEl?.addEventListener("pointercancel", onPointerUp);
  rightSplitterEl?.addEventListener("lostpointercapture", onPointerUp);
  rightSplitterEl?.addEventListener("dblclick", onRightDoubleClick);
  rightSplitterEl?.addEventListener("keydown", onRightKeyDown);

  bottomSplitterEl?.addEventListener("pointerdown", onBottomPointerDown);
  bottomSplitterEl?.addEventListener("pointermove", onPointerMove);
  bottomSplitterEl?.addEventListener("pointerup", onPointerUp);
  bottomSplitterEl?.addEventListener("pointercancel", onPointerUp);
  bottomSplitterEl?.addEventListener("lostpointercapture", onPointerUp);
  bottomSplitterEl?.addEventListener("dblclick", onBottomDoubleClick);
  bottomSplitterEl?.addEventListener("keydown", onBottomKeyDown);

  let resizeObserver: ResizeObserver | null = null;
  if (
    typeof ResizeObserver !== "undefined" &&
    typeof Element !== "undefined" &&
    workspaceEl instanceof Element
  ) {
    resizeObserver = new ResizeObserver(() => {
      applyDom();
    });
    resizeObserver.observe(workspaceEl);
  }

  return {
    getState() {
      return state;
    },
    setState(next) {
      commitState({ ...state, ...next });
    },
    setBottomCollapsed(collapsed) {
      commitState({ ...state, bottomCollapsed: collapsed });
    },
    toggleBottomCollapsed() {
      commitState({ ...state, bottomCollapsed: !state.bottomCollapsed });
      return state.bottomCollapsed;
    },
    resetRightWidth() {
      commitState({ ...state, rightWidthPx: defaultState.rightWidthPx });
    },
    refresh() {
      applyDom();
    },
    dispose() {
      resizeObserver?.disconnect();
      rightSplitterEl?.removeEventListener("pointerdown", onRightPointerDown);
      rightSplitterEl?.removeEventListener("pointermove", onPointerMove);
      rightSplitterEl?.removeEventListener("pointerup", onPointerUp);
      rightSplitterEl?.removeEventListener("pointercancel", onPointerUp);
      rightSplitterEl?.removeEventListener("lostpointercapture", onPointerUp);
      rightSplitterEl?.removeEventListener("dblclick", onRightDoubleClick);
      rightSplitterEl?.removeEventListener("keydown", onRightKeyDown);

      bottomSplitterEl?.removeEventListener("pointerdown", onBottomPointerDown);
      bottomSplitterEl?.removeEventListener("pointermove", onPointerMove);
      bottomSplitterEl?.removeEventListener("pointerup", onPointerUp);
      bottomSplitterEl?.removeEventListener("pointercancel", onPointerUp);
      bottomSplitterEl?.removeEventListener("lostpointercapture", onPointerUp);
      bottomSplitterEl?.removeEventListener("dblclick", onBottomDoubleClick);
      bottomSplitterEl?.removeEventListener("keydown", onBottomKeyDown);

      if (activeDrag) {
        delete rootEl.dataset.resizing;
        activeDrag = null;
      }
    },
  };
}
