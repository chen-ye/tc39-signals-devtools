import {
  toMatchPattern,
  type BackgroundToPanelMessage,
  type IsolatedToBackgroundMessage,
  type PanelToBackgroundMessage,
  type PanelToPageMessage,
} from "../protocol/types.ts";

const STORAGE_KEY = "enabledSiteOrigins";
const POLYFILL_SCRIPT_ID = "tc39-signals-polyfill-provider";

interface TabChannel {
  content?: chrome.runtime.Port;
  panel?: chrome.runtime.Port;
  url: string | null;
}

const tabs = new Map<number, TabChannel>();
let toggleSyncQueue: Promise<void> = Promise.resolve();

function enqueueToggleSync<T>(task: () => Promise<T>): Promise<T> {
  const run = toggleSyncQueue.then(task, task);
  toggleSyncQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readEnabledOrigins(): Promise<string[]> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const raw: unknown = stored[STORAGE_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

async function syncDynamicPolyfillScripts(
  origins: ReadonlyArray<string>,
): Promise<void> {
  const matches = Array.from(
    new Set(
      origins
        .map(toMatchPattern)
        .filter((pattern): pattern is string => pattern !== null),
    ),
  );

  try {
    await chrome.scripting.unregisterContentScripts({
      ids: [POLYFILL_SCRIPT_ID],
    });
  } catch {
    // Ignore when script was not previously registered
  }

  if (matches.length === 0) return;

  await chrome.scripting.registerContentScripts([
    {
      id: POLYFILL_SCRIPT_ID,
      matches,
      js: ["polyfill-provider.js"],
      runAt: "document_start",
      world: "MAIN",
      persistAcrossSessions: true,
    },
  ]);
}

function sendToPanel(tabId: number, msg: BackgroundToPanelMessage): void {
  try {
    tabs.get(tabId)?.panel?.postMessage(msg);
  } catch {
    // Port closed mid-send
  }
}

function sendToContent(tabId: number, msg: PanelToPageMessage): void {
  try {
    tabs.get(tabId)?.content?.postMessage(msg);
  } catch {
    // Port closed mid-send
  }
}

function isIsolatedMessage(msg: unknown): msg is IsolatedToBackgroundMessage {
  return (
    msg !== null &&
    typeof msg === "object" &&
    typeof Reflect.get(msg, "type") === "string"
  );
}

function isPanelMessage(msg: unknown): msg is PanelToBackgroundMessage {
  return (
    msg !== null &&
    typeof msg === "object" &&
    typeof Reflect.get(msg, "type") === "string"
  );
}

chrome.runtime.onInstalled.addListener(() => {
  void enqueueToggleSync(async () => {
    const origins = await readEnabledOrigins();
    await syncDynamicPolyfillScripts(origins);
  });
});

chrome.runtime.onStartup.addListener(() => {
  void enqueueToggleSync(async () => {
    const origins = await readEnabledOrigins();
    await syncDynamicPolyfillScripts(origins);
  });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "content") {
    const tabId = port.sender?.tab?.id;
    const frameId = port.sender?.frameId ?? 0;
    const lifecycle: unknown = port.sender
      ? Reflect.get(port.sender, "documentLifecycle")
      : undefined;
    if (tabId === undefined || frameId !== 0 || lifecycle === "prerender")
      return;

    const entry = tabs.get(tabId) ?? { url: port.sender?.tab?.url ?? null };
    entry.content = port;
    if (port.sender?.tab?.url) {
      entry.url = port.sender.tab.url;
    }
    tabs.set(tabId, entry);

    if (entry.panel && entry.url) {
      sendToPanel(tabId, { type: "PAGE_CONNECTED", url: entry.url });
      sendToContent(tabId, { type: "START_INSPECTION" });
    }

    port.onMessage.addListener((rawMsg: unknown) => {
      if (tabs.get(tabId)?.content !== port) return;
      if (!isIsolatedMessage(rawMsg)) return;
      if (rawMsg.type === "BRIDGE_READY") {
        entry.url = rawMsg.url;
        if (entry.panel) {
          sendToPanel(tabId, { type: "PAGE_CONNECTED", url: entry.url });
          sendToContent(tabId, { type: "START_INSPECTION" });
        }
        return;
      }
      sendToPanel(tabId, rawMsg);
    });

    port.onDisconnect.addListener(() => {
      const current = tabs.get(tabId);
      if (current?.content !== port) return;
      delete current.content;
      if (!current.panel) {
        tabs.delete(tabId);
      } else {
        sendToPanel(tabId, { type: "PAGE_DISCONNECTED" });
      }
    });
    return;
  }

  if (port.name.startsWith("devtools:")) {
    const tabId = Number(port.name.slice("devtools:".length));
    if (!Number.isFinite(tabId)) return;

    const entry = tabs.get(tabId) ?? { url: null };
    entry.panel = port;
    tabs.set(tabId, entry);

    if (entry.content) {
      sendToPanel(tabId, { type: "PAGE_CONNECTED", url: entry.url });
      sendToContent(tabId, { type: "START_INSPECTION" });
    }

    port.onMessage.addListener((rawMsg: unknown) => {
      if (tabs.get(tabId)?.panel !== port) return;
      if (!isPanelMessage(rawMsg)) return;
      if (rawMsg.type === "PING") {
        sendToPanel(tabId, { type: "PONG" });
        return;
      }
      if (rawMsg.type === "GET_SITE_TOGGLE") {
        void readEnabledOrigins().then((origins) => {
          sendToPanel(tabId, {
            type: "SITE_TOGGLE_STATE",
            originKey: rawMsg.originKey,
            enabled: origins.includes(rawMsg.originKey),
          });
        });
        return;
      }
      if (rawMsg.type === "SET_SITE_TOGGLE") {
        void enqueueToggleSync(async () => {
          const origins = await readEnabledOrigins();
          const nextSet = new Set(origins);
          if (rawMsg.enabled) {
            if (toMatchPattern(rawMsg.originKey) === null) {
              sendToPanel(tabId, {
                type: "SITE_TOGGLE_STATE",
                originKey: rawMsg.originKey,
                enabled: false,
              });
              return;
            }
            nextSet.add(rawMsg.originKey);
          } else {
            nextSet.delete(rawMsg.originKey);
          }
          const nextList = Array.from(nextSet);
          try {
            await syncDynamicPolyfillScripts(nextList);
            await chrome.storage.local.set({ [STORAGE_KEY]: nextList });
            sendToPanel(tabId, {
              type: "SITE_TOGGLE_STATE",
              originKey: rawMsg.originKey,
              enabled: rawMsg.enabled,
            });
          } catch {
            sendToPanel(tabId, {
              type: "SITE_TOGGLE_STATE",
              originKey: rawMsg.originKey,
              enabled: origins.includes(rawMsg.originKey),
            });
          }
        });
        return;
      }

      sendToContent(tabId, rawMsg);
    });

    port.onDisconnect.addListener(() => {
      const current = tabs.get(tabId);
      if (current?.panel !== port) return;
      delete current.panel;
      sendToContent(tabId, { type: "STOP_INSPECTION" });
      if (!current.content) {
        tabs.delete(tabId);
      }
    });
  }
});
