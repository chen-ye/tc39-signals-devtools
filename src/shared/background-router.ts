export interface TabChannel {
  content?: chrome.runtime.Port;
  panel?: chrome.runtime.Port;
  url: string | null;
}

export interface BackgroundPanelMessageContext {
  readonly tabId: number;
  readonly port: chrome.runtime.Port;
  readonly sendToPanel: (msg: unknown) => void;
  readonly sendToContent: (msg: unknown) => void;
}

export interface BackgroundPortRouterHooks {
  readonly wakeBridgeOnPanelConnect?: boolean;
  readonly onPanelMessage?: (
    msg: RoutedMessage,
    ctx: BackgroundPanelMessageContext,
  ) => boolean | void;
}

interface RoutedMessage {
  readonly type: string;
}

function isRoutedMessage(msg: unknown): msg is RoutedMessage {
  return (
    msg !== null &&
    typeof msg === "object" &&
    typeof Reflect.get(msg, "type") === "string"
  );
}

export function createBackgroundPortRouter(hooks?: BackgroundPortRouterHooks): {
  readonly dispose: () => void;
} {
  const tabs = new Map<number, TabChannel>();

  function sendToPanel(tabId: number, msg: unknown): void {
    try {
      tabs.get(tabId)?.panel?.postMessage(msg);
    } catch {
      // Port closed mid-send
    }
  }

  function sendToContent(tabId: number, msg: unknown): void {
    try {
      tabs.get(tabId)?.content?.postMessage(msg);
    } catch {
      // Port closed mid-send
    }
  }

  function onConnect(port: chrome.runtime.Port): void {
    if (port.name === "content") {
      const tabId = port.sender?.tab?.id;
      const frameId = port.sender?.frameId ?? 0;
      const lifecycle: unknown = port.sender
        ? Reflect.get(port.sender, "documentLifecycle")
        : undefined;
      if (tabId === undefined || frameId !== 0 || lifecycle === "prerender") {
        try {
          port.disconnect();
        } catch {
          // Ignore disconnect failure
        }
        return;
      }

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
        if (!isRoutedMessage(rawMsg)) return;
        if (rawMsg.type === "BRIDGE_READY") {
          const url: unknown = Reflect.get(rawMsg, "url");
          if (typeof url === "string") {
            entry.url = url;
          }
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
      } else if (hooks?.wakeBridgeOnPanelConnect) {
        // If MV3 SW restarted after 30s idle while DevTools was closed, wake the dormant content bridge.
        void chrome.tabs
          .sendMessage(tabId, { type: "WAKE_BRIDGE" })
          .catch(() => {
            // Tab may not have a content bridge active yet
          });
      }

      port.onMessage.addListener((rawMsg: unknown) => {
        if (tabs.get(tabId)?.panel !== port) return;
        if (!isRoutedMessage(rawMsg)) return;
        if (rawMsg.type === "PING") {
          sendToPanel(tabId, { type: "PONG" });
          return;
        }
        if (
          hooks?.onPanelMessage?.(rawMsg, {
            tabId,
            port,
            sendToPanel: (msg) => sendToPanel(tabId, msg),
            sendToContent: (msg) => sendToContent(tabId, msg),
          }) === true
        ) {
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
  }

  chrome.runtime.onConnect.addListener(onConnect);

  return {
    dispose() {
      chrome.runtime.onConnect.removeListener(onConnect);
    },
  };
}
