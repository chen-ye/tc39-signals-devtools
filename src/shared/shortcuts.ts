export interface PanelShortcutHandlers {
  readonly onSearch?: (() => void) | undefined;
  readonly onEscape?: (() => boolean | void) | undefined;
  readonly onFit?: (() => void) | undefined;
  readonly onZoomIn?: (() => void) | undefined;
  readonly onZoomOut?: (() => void) | undefined;
}

export function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return true;
  }
  return target instanceof HTMLElement && target.isContentEditable;
}

function resolveDeepActiveElement(): Element | null {
  if (typeof document === "undefined") return null;
  let active = document.activeElement;
  while (active instanceof Element) {
    const shadowActive: unknown = active.shadowRoot?.activeElement ?? null;
    if (shadowActive instanceof Element && shadowActive !== active) {
      active = shadowActive;
    } else {
      break;
    }
  }
  return active instanceof Element ? active : null;
}

export function registerPanelShortcuts(
  target: EventTarget,
  handlers: PanelShortcutHandlers,
): () => void {
  const onKeyDown = (evt: Event): void => {
    if (!(evt instanceof KeyboardEvent)) return;
    if (evt.defaultPrevented) return;
    if (evt.metaKey || evt.ctrlKey || evt.altKey) return;

    const pathTarget =
      typeof evt.composedPath === "function"
        ? (evt.composedPath()[0] ?? null)
        : null;
    const active = resolveDeepActiveElement();
    if (
      isEditableElement(evt.target) ||
      isEditableElement(pathTarget) ||
      isEditableElement(active)
    ) {
      return;
    }

    if (evt.key === "/" && handlers.onSearch) {
      evt.preventDefault();
      handlers.onSearch();
    } else if (evt.key === "Escape" && handlers.onEscape) {
      if (handlers.onEscape() !== false) {
        evt.preventDefault();
      }
    } else if (evt.key === "0" && handlers.onFit) {
      evt.preventDefault();
      handlers.onFit();
    } else if ((evt.key === "+" || evt.key === "=") && handlers.onZoomIn) {
      evt.preventDefault();
      handlers.onZoomIn();
    } else if (evt.key === "-" && handlers.onZoomOut) {
      evt.preventDefault();
      handlers.onZoomOut();
    }
  };

  target.addEventListener("keydown", onKeyDown);
  return () => {
    target.removeEventListener("keydown", onKeyDown);
  };
}
