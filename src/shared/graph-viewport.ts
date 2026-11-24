export const MIN_SCALE = 0.18;
export const MAX_SCALE = 2.5;

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface ViewportRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FitBounds {
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly width: number;
  readonly height: number;
}

export interface FitToRectOptions {
  readonly padding?: number | undefined;
  readonly minScale?: number | undefined;
  readonly maxScale?: number | undefined;
  readonly anchorRect?: ViewportRect | undefined;
  readonly anchorBiasX?: number | undefined;
  readonly anchorBiasY?: number | undefined;
  readonly markUserTransformed?: boolean | undefined;
}

export interface CenterOnRectOptions {
  readonly scale?: number | undefined;
  readonly markUserTransformed?: boolean | undefined;
}

export interface ViewportTransform {
  readonly scale: number;
  readonly tx: number;
  readonly ty: number;
  readonly userTransformed: boolean;
}

export interface GraphViewportOptions {
  readonly minScale?: number | undefined;
  readonly maxScale?: number | undefined;
  readonly onChange?: ((transform: ViewportTransform) => void) | undefined;
}

export interface BindPointerPanOptions {
  readonly shouldIgnoreTarget?:
    ((target: EventTarget | null) => boolean) | undefined;
  readonly activeClass?: string | undefined;
  readonly dragThresholdPx?: number | undefined;
  readonly onPanStart?: (() => void) | undefined;
  readonly onPanEnd?: ((didMove: boolean) => void) | undefined;
}

export interface BindWheelZoomOptions {
  readonly getViewportOrigin?:
    (() => { readonly left: number; readonly top: number }) | undefined;
  readonly zoomStep?: number | undefined;
}

export type NavigationDirection =
  | "up"
  | "down"
  | "left"
  | "right"
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight";

export interface DirectionalNode {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export class GraphViewportController {
  static readonly MIN_SCALE = MIN_SCALE;
  static readonly MAX_SCALE = MAX_SCALE;

  readonly MIN_SCALE: number;
  readonly MAX_SCALE: number;
  readonly #onChange: ((transform: ViewportTransform) => void) | undefined;

  #scale = 1;
  #tx = 0;
  #ty = 0;
  #userTransformed = false;
  #lastPanDidMove = false;

  constructor(options?: GraphViewportOptions) {
    this.MIN_SCALE = options?.minScale ?? MIN_SCALE;
    this.MAX_SCALE = options?.maxScale ?? MAX_SCALE;
    this.#onChange = options?.onChange;
  }

  get scale(): number {
    return this.#scale;
  }

  get tx(): number {
    return this.#tx;
  }

  get ty(): number {
    return this.#ty;
  }

  get userTransformed(): boolean {
    return this.#userTransformed;
  }

  getTransform(): ViewportTransform {
    return {
      scale: this.#scale,
      tx: this.#tx,
      ty: this.#ty,
      userTransformed: this.#userTransformed,
    };
  }

  getSvgTransformAttribute(): string {
    return `translate(${this.#tx.toFixed(1)}, ${this.#ty.toFixed(1)}) scale(${this.#scale.toFixed(4)})`;
  }

  consumeDidPanMove(): boolean {
    const moved = this.#lastPanDidMove;
    this.#lastPanDidMove = false;
    return moved;
  }

  zoomAtPoint(offsetX: number, offsetY: number, factor: number): boolean {
    if (!Number.isFinite(factor) || factor <= 0) return false;
    const nextScale = Math.max(
      this.MIN_SCALE,
      Math.min(this.MAX_SCALE, this.#scale * factor),
    );
    if (nextScale === this.#scale) return false;

    const worldX = (offsetX - this.#tx) / this.#scale;
    const worldY = (offsetY - this.#ty) / this.#scale;
    this.#scale = nextScale;
    this.#tx = offsetX - worldX * nextScale;
    this.#ty = offsetY - worldY * nextScale;
    this.#userTransformed = true;
    this.#emit();
    return true;
  }

  zoomAtCenter(viewport: ViewportSize, factor: number): boolean {
    return this.zoomAtPoint(viewport.width / 2, viewport.height / 2, factor);
  }

  resetZoom(): void {
    this.#scale = 1;
    this.#tx = 0;
    this.#ty = 0;
    this.#userTransformed = false;
    this.#emit();
  }

  panBy(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.#tx += dx;
    this.#ty += dy;
    this.#userTransformed = true;
    this.#emit();
  }

  fitToRect(
    bounds: FitBounds,
    viewport: ViewportSize,
    options?: FitToRectOptions,
  ): boolean {
    if (bounds.width <= 0 || bounds.height <= 0) {
      this.#scale = 1;
      this.#tx = 0;
      this.#ty = 0;
      this.#userTransformed = false;
      this.#emit();
      return true;
    }

    if (viewport.width < 20 || viewport.height < 20) {
      return false;
    }

    const pad = options?.padding ?? 16;
    const availW = Math.max(1, viewport.width - pad * 2);
    const availH = Math.max(1, viewport.height - pad * 2);
    const rawScale = Math.min(availW / bounds.width, availH / bounds.height);

    const minFloor = Math.max(
      this.MIN_SCALE,
      options?.minScale ?? this.MIN_SCALE,
    );
    const maxCeil = Math.min(
      this.MAX_SCALE,
      options?.maxScale ?? this.MAX_SCALE,
    );
    const effectiveMax = Math.max(minFloor, maxCeil);
    const scale = Math.max(minFloor, Math.min(effectiveMax, rawScale));

    const bx = bounds.x ?? 0;
    const by = bounds.y ?? 0;
    const fitsW = bounds.width * scale <= viewport.width;
    const fitsH = bounds.height * scale <= viewport.height;

    let tx: number;
    let ty: number;

    if (fitsW && fitsH) {
      tx = Math.round((viewport.width - bounds.width * scale) / 2 - bx * scale);
      ty = Math.round(
        (viewport.height - bounds.height * scale) / 2 - by * scale,
      );
    } else if (options?.anchorRect) {
      const cx = options.anchorRect.x + options.anchorRect.width / 2;
      const cy = options.anchorRect.y + options.anchorRect.height / 2;
      const biasX = options.anchorBiasX ?? 0.36;
      const biasY = options.anchorBiasY ?? 0.5;
      tx = fitsW
        ? Math.round((viewport.width - bounds.width * scale) / 2 - bx * scale)
        : Math.round(viewport.width * biasX - cx * scale);
      ty = fitsH
        ? Math.round((viewport.height - bounds.height * scale) / 2 - by * scale)
        : Math.round(viewport.height * biasY - cy * scale);
    } else {
      tx = fitsW
        ? Math.round((viewport.width - bounds.width * scale) / 2 - bx * scale)
        : Math.round(pad - bx * scale);
      ty = fitsH
        ? Math.round((viewport.height - bounds.height * scale) / 2 - by * scale)
        : Math.round(pad - by * scale);
    }

    this.#scale = scale;
    this.#tx = tx;
    this.#ty = ty;
    this.#userTransformed = options?.markUserTransformed ?? false;
    this.#emit();
    return true;
  }

  centerOnRect(
    rect: ViewportRect,
    viewport: ViewportSize,
    options?: CenterOnRectOptions,
  ): boolean {
    if (viewport.width < 20 || viewport.height < 20) {
      return false;
    }

    if (options?.scale !== undefined && Number.isFinite(options.scale)) {
      this.#scale = Math.max(
        this.MIN_SCALE,
        Math.min(this.MAX_SCALE, options.scale),
      );
    }

    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    this.#tx = Math.round(viewport.width / 2 - cx * this.#scale);
    this.#ty = Math.round(viewport.height / 2 - cy * this.#scale);
    this.#userTransformed = options?.markUserTransformed ?? true;
    this.#emit();
    return true;
  }

  bindPointerPan(target: Element, options?: BindPointerPanOptions): () => void {
    const activeClass = options?.activeClass ?? "is-panning";
    const threshold = options?.dragThresholdPx ?? 3;

    let panning = false;
    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let originTx = 0;
    let originTy = 0;
    let didMove = false;

    const onPointerDown = (evt: Event): void => {
      if (!(evt instanceof PointerEvent)) return;
      if (evt.button !== 0) return;
      if (options?.shouldIgnoreTarget?.(evt.target)) return;

      panning = true;
      didMove = false;
      this.#lastPanDidMove = false;
      pointerId = evt.pointerId;
      startX = evt.clientX;
      startY = evt.clientY;
      originTx = this.#tx;
      originTy = this.#ty;
      target.classList.add(activeClass);
      try {
        target.setPointerCapture(evt.pointerId);
      } catch {
        // Synthetic pointer events in tests may not support capture
      }
      options?.onPanStart?.();
    };

    const onPointerMove = (evt: Event): void => {
      if (!(evt instanceof PointerEvent)) return;
      if (!panning || evt.pointerId !== pointerId) return;
      const dx = evt.clientX - startX;
      const dy = evt.clientY - startY;
      if (Math.abs(dx) > threshold || Math.abs(dy) > threshold) {
        didMove = true;
      }
      this.#tx = originTx + dx;
      this.#ty = originTy + dy;
      this.#userTransformed = true;
      this.#emit();
    };

    const onPointerEnd = (evt: Event): void => {
      if (!(evt instanceof PointerEvent)) return;
      if (!panning || evt.pointerId !== pointerId) return;
      panning = false;
      pointerId = null;
      this.#lastPanDidMove = didMove;
      target.classList.remove(activeClass);
      try {
        target.releasePointerCapture(evt.pointerId);
      } catch {
        // Ignore if not captured
      }
      options?.onPanEnd?.(didMove);
    };

    target.addEventListener("pointerdown", onPointerDown);
    target.addEventListener("pointermove", onPointerMove);
    target.addEventListener("pointerup", onPointerEnd);
    target.addEventListener("pointercancel", onPointerEnd);

    return () => {
      target.removeEventListener("pointerdown", onPointerDown);
      target.removeEventListener("pointermove", onPointerMove);
      target.removeEventListener("pointerup", onPointerEnd);
      target.removeEventListener("pointercancel", onPointerEnd);
      target.classList.remove(activeClass);
      panning = false;
      pointerId = null;
    };
  }

  bindWheelZoom(target: Element, options?: BindWheelZoomOptions): () => void {
    const zoomStep = options?.zoomStep ?? 1.12;

    const onWheel = (evt: Event): void => {
      if (!(evt instanceof WheelEvent)) return;
      evt.preventDefault();
      const origin =
        options?.getViewportOrigin?.() ?? target.getBoundingClientRect();
      const offsetX = evt.clientX - origin.left;
      const offsetY = evt.clientY - origin.top;
      if (evt.deltaY === 0) return;

      const factor = evt.ctrlKey
        ? Math.exp(-evt.deltaY * 0.01)
        : evt.deltaY < 0
          ? zoomStep
          : 1 / zoomStep;
      this.zoomAtPoint(offsetX, offsetY, factor);
    };

    target.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      target.removeEventListener("wheel", onWheel);
    };
  }

  #emit(): void {
    this.#onChange?.(this.getTransform());
  }
}

const DIRECTION_MAP: Record<
  NavigationDirection,
  "up" | "down" | "left" | "right"
> = {
  ArrowUp: "up",
  up: "up",
  ArrowDown: "down",
  down: "down",
  ArrowLeft: "left",
  left: "left",
  ArrowRight: "right",
  right: "right",
};

function normalizeDirection(
  direction: NavigationDirection,
): "up" | "down" | "left" | "right" {
  return DIRECTION_MAP[direction];
}

export function findNearestDirectionalNode(
  nodes: ReadonlyArray<DirectionalNode>,
  currentId: number,
  direction: NavigationDirection,
): number | null {
  if (nodes.length === 0) return null;
  const current = nodes.find((node) => node.id === currentId);
  if (!current) return nodes[0]?.id ?? null;

  const dir = normalizeDirection(direction);
  const cx = current.x + current.width / 2;
  const cy = current.y + current.height / 2;

  let bestId: number | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of nodes) {
    if (candidate.id === currentId) continue;
    const nx = candidate.x + candidate.width / 2;
    const ny = candidate.y + candidate.height / 2;
    const dx = nx - cx;
    const dy = ny - cy;

    let primary: number;
    let secondary: number;

    switch (dir) {
      case "right":
        if (dx <= 1) continue;
        primary = dx;
        secondary = Math.abs(dy);
        break;
      case "left":
        if (dx >= -1) continue;
        primary = -dx;
        secondary = Math.abs(dy);
        break;
      case "down":
        if (dy <= 1) continue;
        primary = dy;
        secondary = Math.abs(dx);
        break;
      case "up":
        if (dy >= -1) continue;
        primary = -dy;
        secondary = Math.abs(dx);
        break;
    }

    const score = primary + secondary * 2;
    if (
      score < bestScore ||
      (score === bestScore && (bestId === null || candidate.id < bestId))
    ) {
      bestScore = score;
      bestId = candidate.id;
    }
  }

  return bestId;
}
