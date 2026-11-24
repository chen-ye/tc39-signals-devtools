import {
  toMatchPattern,
  type PanelToBackgroundMessage,
} from "../protocol/types.ts";
import { createBackgroundPortRouter } from "../shared/background-router.ts";

const STORAGE_KEY = "enabledSiteOrigins";
const POLYFILL_SCRIPT_ID = "tc39-signals-polyfill-provider";

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

function isPanelToggleMessage(
  msg: unknown,
): msg is Extract<
  PanelToBackgroundMessage,
  { readonly type: "GET_SITE_TOGGLE" | "SET_SITE_TOGGLE" }
> {
  if (msg === null || typeof msg !== "object") return false;
  const type = Reflect.get(msg, "type");
  return (
    (type === "GET_SITE_TOGGLE" || type === "SET_SITE_TOGGLE") &&
    typeof Reflect.get(msg, "originKey") === "string"
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

createBackgroundPortRouter({
  wakeBridgeOnPanelConnect: true,
  onPanelMessage(rawMsg, { sendToPanel }) {
    if (!isPanelToggleMessage(rawMsg)) return false;

    if (rawMsg.type === "GET_SITE_TOGGLE") {
      void readEnabledOrigins().then((origins) => {
        sendToPanel({
          type: "SITE_TOGGLE_STATE",
          originKey: rawMsg.originKey,
          enabled: origins.includes(rawMsg.originKey),
        });
      });
      return true;
    }

    const enabled = rawMsg.enabled;
    void enqueueToggleSync(async () => {
      const origins = await readEnabledOrigins();
      const nextSet = new Set(origins);
      if (enabled) {
        if (toMatchPattern(rawMsg.originKey) === null) {
          sendToPanel({
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
        sendToPanel({
          type: "SITE_TOGGLE_STATE",
          originKey: rawMsg.originKey,
          enabled,
        });
      } catch {
        sendToPanel({
          type: "SITE_TOGGLE_STATE",
          originKey: rawMsg.originKey,
          enabled: origins.includes(rawMsg.originKey),
        });
      }
    });
    return true;
  },
});
