export type PanelTransportMode = "devtools" | "bridge";

export interface BasePanelTransport<TIn, TOut> {
  readonly mode: PanelTransportMode;
  send(message: TOut): void;
  onMessage(listener: (message: TIn) => void): () => void;
  getDevToolsTheme(): "light" | "dark" | null;
  dispose(): void;
}

export interface BasePanelTransportOptions<TIn, TOut> {
  readonly channel: string;
  readonly isIncomingMessage: (value: unknown) => value is TIn;
  readonly mode?: PanelTransportMode | undefined;
  readonly pingMessage?: TOut | undefined;
  readonly initialBridgeMessage?: TOut | undefined;
  readonly createNavigatedMessage?: ((url: string) => TIn) | undefined;
  readonly enforceSameOrigin?: boolean | undefined;
  readonly origin?: string | undefined;
  readonly incomingDirection?: string | undefined;
  readonly outgoingDirection?: string | undefined;
  readonly portNamePrefix?: string | undefined;
  readonly heartbeatIntervalMs?: number | undefined;
  readonly reconnectDelayMs?: number | undefined;
}

export function isChromeDevToolsContext(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.devtools !== "undefined" &&
    typeof chrome.devtools.inspectedWindow?.tabId === "number"
  );
}

function createChromeDevtoolsBaseTransport<TIn, TOut>(
  options: BasePanelTransportOptions<TIn, TOut>,
): BasePanelTransport<TIn, TOut> {
  const tabId = chrome.devtools.inspectedWindow.tabId;
  const portNamePrefix = options.portNamePrefix ?? "devtools:";
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 18_000;
  const reconnectDelayMs = options.reconnectDelayMs ?? 250;
  const listeners = new Set<(message: TIn) => void>();
  let port: chrome.runtime.Port | null = null;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const emit = (msg: TIn) => {
    for (const listener of listeners) {
      listener(msg);
    }
  };

  const connect = () => {
    if (disposed) return;
    const nextPort = chrome.runtime.connect({
      name: `${portNamePrefix}${tabId}`,
    });
    port = nextPort;

    nextPort.onMessage.addListener((raw: unknown) => {
      if (options.isIncomingMessage(raw)) {
        emit(raw);
      }
    });

    nextPort.onDisconnect.addListener(() => {
      if (port === nextPort) {
        port = null;
      }
      if (!disposed && reconnectTimer === null) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, reconnectDelayMs);
      }
    });
  };

  queueMicrotask(connect);

  if (options.pingMessage !== undefined) {
    const pingMessage = options.pingMessage;
    heartbeatTimer = setInterval(() => {
      if (port && !disposed) {
        try {
          port.postMessage(pingMessage);
        } catch {
          // Ignore transient disconnect
        }
      }
    }, heartbeatIntervalMs);
  }

  const createNavigatedMessage = options.createNavigatedMessage;
  const onNavigated = (url: string) => {
    if (createNavigatedMessage) {
      emit(createNavigatedMessage(url));
    }
  };
  if (createNavigatedMessage) {
    chrome.devtools.network?.onNavigated?.addListener(onNavigated);
  }

  return {
    mode: "devtools",
    send(message) {
      if (disposed) return;
      if (!port) connect();
      try {
        port?.postMessage(message);
      } catch {
        port = null;
        connect();
      }
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getDevToolsTheme() {
      const theme = chrome.devtools.panels?.themeName;
      return theme === "dark" ? "dark" : "light";
    },
    dispose() {
      disposed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (createNavigatedMessage) {
        chrome.devtools.network?.onNavigated?.removeListener(onNavigated);
      }
      port?.disconnect();
      port = null;
      listeners.clear();
    },
  };
}

function createWindowBridgeBaseTransport<TIn, TOut>(
  options: BasePanelTransportOptions<TIn, TOut>,
): BasePanelTransport<TIn, TOut> {
  const listeners = new Set<(message: TIn) => void>();
  const enforceSameOrigin = options.enforceSameOrigin ?? true;
  const expectedOrigin = options.origin ?? window.location.origin;
  const postTargetOrigin = enforceSameOrigin
    ? expectedOrigin
    : (options.origin ?? "*");
  const incomingDirection = options.incomingDirection ?? "host-to-panel";
  const outgoingDirection = options.outgoingDirection ?? "panel-to-host";
  const target: Window | null =
    window.opener ?? (window.parent !== window ? window.parent : null);

  const onWindowMessage = (event: MessageEvent) => {
    if (enforceSameOrigin && event.origin !== expectedOrigin) return;
    if (target && event.source !== target) return;
    if (!target && event.source !== window) return;
    const data: unknown = event.data;
    if (data === null || typeof data !== "object") return;
    if (Reflect.get(data, "channel") !== options.channel) return;
    if (Reflect.get(data, "direction") !== incomingDirection) return;
    const payload: unknown = Reflect.get(data, "payload");
    if (options.isIncomingMessage(payload)) {
      for (const listener of listeners) {
        listener(payload);
      }
    }
  };

  window.addEventListener("message", onWindowMessage);

  const postToHost = (message: TOut) => {
    target?.postMessage(
      {
        channel: options.channel,
        direction: outgoingDirection,
        payload: message,
      },
      postTargetOrigin,
    );
  };

  if (options.initialBridgeMessage !== undefined) {
    postToHost(options.initialBridgeMessage);
  }

  return {
    mode: "bridge",
    send(message) {
      postToHost(message);
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getDevToolsTheme() {
      return null;
    },
    dispose() {
      window.removeEventListener("message", onWindowMessage);
      listeners.clear();
    },
  };
}

export function createBasePanelTransport<TIn, TOut>(
  options: BasePanelTransportOptions<TIn, TOut>,
): BasePanelTransport<TIn, TOut> {
  const mode =
    options.mode ?? (isChromeDevToolsContext() ? "devtools" : "bridge");
  return mode === "devtools"
    ? createChromeDevtoolsBaseTransport(options)
    : createWindowBridgeBaseTransport(options);
}
