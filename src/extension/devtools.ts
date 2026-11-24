interface PendingSearch {
  readonly action: string;
  readonly queryString: string | undefined;
}

const PENDING_SEARCH_KEY = "__SIGNALS_DEVTOOLS_PENDING_SEARCH__";
const ON_SEARCH_KEY = "__SIGNALS_DEVTOOLS_ON_SEARCH__";
const loadListenerWindows = new WeakSet<Window>();
const latestQueuedByWindow = new WeakMap<Window, PendingSearch>();

let panelWindow: Window | null = null;
let pendingSearch: PendingSearch | null = null;

function forwardSearch(
  win: Window,
  action: string,
  queryString: string | undefined,
): boolean {
  const handler: unknown = Reflect.get(win, ON_SEARCH_KEY);
  if (typeof handler !== "function") {
    return false;
  }
  Reflect.apply(handler, win, [action, queryString]);
  return true;
}

function queueSearchForWindow(win: Window, queued: PendingSearch): void {
  pendingSearch = queued;
  latestQueuedByWindow.set(win, queued);
  Reflect.set(win, PENDING_SEARCH_KEY, queued);
  if (loadListenerWindows.has(win)) return;
  loadListenerWindows.add(win);
  win.addEventListener(
    "load",
    () => {
      loadListenerWindows.delete(win);
      const stillPending: unknown = Reflect.get(win, PENDING_SEARCH_KEY);
      if (
        panelWindow === win &&
        stillPending !== null &&
        typeof stillPending === "object"
      ) {
        const act: unknown = Reflect.get(stillPending, "action");
        const q: unknown = Reflect.get(stillPending, "queryString");
        if (
          typeof act === "string" &&
          forwardSearch(win, act, typeof q === "string" ? q : undefined)
        ) {
          pendingSearch = null;
          Reflect.deleteProperty(win, PENDING_SEARCH_KEY);
        }
      } else if (
        stillPending === undefined &&
        pendingSearch === latestQueuedByWindow.get(win)
      ) {
        pendingSearch = null;
      }
    },
    { once: true },
  );
}

chrome.devtools.panels.create(
  "Signals",
  "icons/icon-32.png",
  "panel.html",
  (panel) => {
    panel.onShown.addListener((win) => {
      panelWindow = win;
      if (pendingSearch) {
        const queued = pendingSearch;
        if (forwardSearch(win, queued.action, queued.queryString)) {
          pendingSearch = null;
          Reflect.deleteProperty(win, PENDING_SEARCH_KEY);
        } else {
          queueSearchForWindow(win, queued);
        }
      }
    });

    panel.onHidden.addListener(() => {
      panelWindow = null;
    });

    panel.onSearch.addListener((action, queryString) => {
      const next: PendingSearch = { action, queryString };
      if (panelWindow) {
        if (forwardSearch(panelWindow, action, queryString)) {
          pendingSearch = null;
          Reflect.deleteProperty(panelWindow, PENDING_SEARCH_KEY);
          return;
        }
        queueSearchForWindow(panelWindow, next);
        return;
      }
      pendingSearch = next;
    });
  },
);
