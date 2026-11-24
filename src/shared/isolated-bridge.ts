export interface IsolatedBridgeMessage {
  readonly type: string;
}

export interface IsolatedBridgeConfig<
  TPageToPanel extends IsolatedBridgeMessage = IsolatedBridgeMessage,
  TPanelToPage extends IsolatedBridgeMessage = IsolatedBridgeMessage,
> {
  readonly channel: string;
  readonly isValidPageToPanelMessage: (value: unknown) => value is TPageToPanel;
  readonly isValidPanelToPageMessage: (value: unknown) => value is TPanelToPage;
  readonly shouldForwardToBackground?: (
    payload: TPageToPanel,
    inspectionActive: boolean,
  ) => boolean;
  readonly wakeOnRuntimeMessage?: boolean;
  readonly handlePrerenderingChange?: boolean;
}

export function startIsolatedBridge<
  TPageToPanel extends IsolatedBridgeMessage,
  TPanelToPage extends IsolatedBridgeMessage,
>(config: IsolatedBridgeConfig<TPageToPanel, TPanelToPage>): void {
  let port: chrome.runtime.Port | null = null;
  let inspectionActive = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let contextInvalidated = false;

  const shouldForward =
    config.shouldForwardToBackground ??
    ((_payload: TPageToPanel, active: boolean) => active);

  function postToMain(
    payload: TPanelToPage | { readonly type: "START_INSPECTION" },
  ): void {
    window.postMessage(
      {
        channel: config.channel,
        direction: "isolated-to-main" as const,
        payload,
      },
      "*",
    );
  }

  function extractMainPayload(data: unknown): TPageToPanel | null {
    if (data === null || typeof data !== "object") return null;
    if (Reflect.get(data, "channel") !== config.channel) return null;
    if (Reflect.get(data, "direction") !== "main-to-isolated") return null;
    const payload: unknown = Reflect.get(data, "payload");
    return config.isValidPageToPanelMessage(payload) ? payload : null;
  }

  function safePostToBackground(
    msg: TPageToPanel | { readonly type: "BRIDGE_READY"; readonly url: string },
  ): void {
    if (contextInvalidated) return;
    if (!port) {
      connectPort();
    }
    try {
      port?.postMessage(msg);
    } catch {
      port = null;
      scheduleReconnect();
    }
  }

  function scheduleReconnect(): void {
    if (contextInvalidated || reconnectTimer !== null) return;
    const delay = Math.min(3000, 150 * Math.pow(2, reconnectAttempts));
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectPort();
    }, delay);
  }

  function connectPort(): void {
    if (contextInvalidated || port !== null) return;
    if (!chrome.runtime?.id) {
      contextInvalidated = true;
      return;
    }

    let nextPort: chrome.runtime.Port;
    try {
      nextPort = chrome.runtime.connect({ name: "content" });
    } catch {
      contextInvalidated = true;
      return;
    }

    port = nextPort;
    reconnectAttempts = 0;

    nextPort.onMessage.addListener((msg: unknown) => {
      if (!config.isValidPanelToPageMessage(msg)) return;
      if (msg.type === "START_INSPECTION") {
        inspectionActive = true;
      } else if (msg.type === "STOP_INSPECTION") {
        inspectionActive = false;
      }
      postToMain(msg);
    });

    nextPort.onDisconnect.addListener(() => {
      if (port === nextPort) {
        port = null;
      }
      if (!chrome.runtime?.id) {
        contextInvalidated = true;
        return;
      }
      if (inspectionActive) {
        scheduleReconnect();
      }
    });

    safePostToBackground({ type: "BRIDGE_READY", url: window.location.href });
  }

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const payload = extractMainPayload(event.data);
    if (!payload) return;
    if (!shouldForward(payload, inspectionActive)) return;
    safePostToBackground(payload);
  });

  if (config.wakeOnRuntimeMessage) {
    chrome.runtime.onMessage.addListener((msg: unknown) => {
      if (
        msg !== null &&
        typeof msg === "object" &&
        Reflect.get(msg, "type") === "WAKE_BRIDGE"
      ) {
        connectPort();
      }
    });
  }

  if (config.handlePrerenderingChange) {
    document.addEventListener("prerenderingchange", () => {
      if (!Reflect.get(document, "prerendering")) {
        connectPort();
        if (inspectionActive) {
          postToMain({ type: "START_INSPECTION" });
        }
      }
    });
  }

  window.addEventListener("pageshow", (event: PageTransitionEvent) => {
    if (event.persisted) {
      connectPort();
      if (inspectionActive) {
        postToMain({ type: "START_INSPECTION" });
      }
    }
  });

  connectPort();
}
