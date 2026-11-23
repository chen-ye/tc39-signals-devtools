import { Signal as RawSignal } from "signal-polyfill";
import { getOrInstallGlobalHook } from "../hook/hook.ts";
import {
  BRIDGE_CHANNEL,
  type BackgroundToPanelMessage,
  type PanelToBackgroundMessage,
  type SignalNamespace,
} from "../protocol/types.ts";

function isSignalNamespaceLike(value: unknown): value is SignalNamespace {
  if (value === null || typeof value !== "object") return false;
  const subtle: unknown = Reflect.get(value, "subtle");
  return (
    typeof Reflect.get(value, "State") === "function" &&
    typeof Reflect.get(value, "Computed") === "function" &&
    subtle !== null &&
    typeof subtle === "object" &&
    typeof Reflect.get(subtle, "Watcher") === "function"
  );
}

function getInputElement(id: string): HTMLInputElement | null {
  const el = document.getElementById(id);
  return el instanceof HTMLInputElement ? el : null;
}

function getSelectElement(id: string): HTMLSelectElement | null {
  const el = document.getElementById(id);
  return el instanceof HTMLSelectElement ? el : null;
}

// Install hook in-page as well so embedded iframe preview works even without the extension installed,
// while also cooperating seamlessly when the extension's MAIN-world hook is already present.
const hook = getOrInstallGlobalHook();
const existingGlobal: unknown = Reflect.get(globalThis, "Signal");
const Signal: SignalNamespace = isSignalNamespaceLike(existingGlobal)
  ? hook.wrap(existingGlobal, "demo")
  : hook.wrap(RawSignal, "demo");

const unitPrice = new Signal.State(25, { name: "unitPrice" });
const quantity = new Signal.State(3, { name: "quantity" });
const pricingMode = new Signal.State<"standard" | "wholesale">("standard", {
  name: "pricingMode",
});
const taxRate = new Signal.State(8, { name: "taxRate" });
const bulkDiscount = new Signal.State(15, { name: "bulkDiscount" });
const splitPeople = new Signal.State(2, { name: "splitPeople" });

const couponCode = new Signal.State("SAVE10", {
  name: "couponCode",
  equals: (prev, next) =>
    prev.trim().toUpperCase() === next.trim().toUpperCase(),
});

const subtotal = new Signal.Computed(() => unitPrice.get() * quantity.get(), {
  name: "subtotal",
});

const couponSavings = new Signal.Computed(
  () => {
    const code = couponCode.get().trim().toUpperCase();
    if (code === "SAVE10") return 10;
    if (code === "VIP25") return 25;
    return 0;
  },
  { name: "couponSavings" },
);

const effectiveTotal = new Signal.Computed(
  () => {
    const base = Math.max(0, subtotal.get() - couponSavings.get());
    if (pricingMode.get() === "wholesale") {
      return Number((base * (1 - bulkDiscount.get() / 100)).toFixed(2));
    }
    return Number((base * (1 + taxRate.get() / 100)).toFixed(2));
  },
  { name: "effectiveTotal" },
);

const perPersonCost = new Signal.Computed(
  () => {
    const people = splitPeople.get();
    if (people <= 0) {
      throw new RangeError("splitPeople must be > 0");
    }
    return Number((effectiveTotal.get() / people).toFixed(2));
  },
  { name: "perPersonCost" },
);

const lazyAuditSnapshot = new Signal.Computed(
  () => ({
    mode: pricingMode.get(),
    subtotal: subtotal.get(),
    total: effectiveTotal.get(),
    coupon: couponCode.get().toUpperCase(),
  }),
  { name: "lazyAuditSnapshot" },
);

let notifyCount = 0;
let watching = true;
let scheduledFlush = false;

const renderDom = () => {
  scheduledFlush = false;
  const subEl = document.getElementById("out-subtotal");
  const totalEl = document.getElementById("out-total");
  const perPersonEl = document.getElementById("out-per-person");
  const notifiesEl = document.getElementById("out-notifies");

  if (subEl) subEl.textContent = `$${subtotal.get().toFixed(2)}`;
  if (totalEl) totalEl.textContent = `$${effectiveTotal.get().toFixed(2)}`;
  if (notifiesEl) notifiesEl.textContent = String(notifyCount);

  if (perPersonEl) {
    try {
      perPersonEl.textContent = `$${perPersonCost.get().toFixed(2)}`;
      perPersonEl.classList.remove("is-error");
    } catch (err) {
      perPersonEl.textContent =
        err instanceof Error ? err.message : String(err);
      perPersonEl.classList.add("is-error");
    }
  }

  watcher.watch();
};

const watcher = new Signal.subtle.Watcher(() => {
  notifyCount++;
  if (!scheduledFlush) {
    scheduledFlush = true;
    queueMicrotask(renderDom);
  }
});
hook.label(watcher, "domRenderer");

watcher.watch(subtotal, effectiveTotal, perPersonCost);
renderDom();

// Wire demo UI controls
const priceInput = getInputElement("unit-price");
const qtyInput = getInputElement("quantity");
const modeSelect = getSelectElement("discount-mode");
const taxInput = getInputElement("tax-rate");
const bulkInput = getInputElement("bulk-discount");
const couponInput = getInputElement("coupon-input");
const divisorInput = getInputElement("divisor-input");

priceInput?.addEventListener("input", () => {
  const v = Number(priceInput.value);
  if (Number.isFinite(v)) unitPrice.set(v);
});
document.getElementById("price-inc")?.addEventListener("click", () => {
  const next = Signal.subtle.untrack(() => unitPrice.get()) + 5;
  unitPrice.set(next);
  if (priceInput) priceInput.value = String(next);
});
document.getElementById("price-dec")?.addEventListener("click", () => {
  const next = Math.max(1, Signal.subtle.untrack(() => unitPrice.get()) - 5);
  unitPrice.set(next);
  if (priceInput) priceInput.value = String(next);
});

qtyInput?.addEventListener("input", () => {
  const v = Number(qtyInput.value);
  if (Number.isFinite(v)) quantity.set(v);
});
document.getElementById("qty-inc")?.addEventListener("click", () => {
  const next = Signal.subtle.untrack(() => quantity.get()) + 1;
  quantity.set(next);
  if (qtyInput) qtyInput.value = String(next);
});
document.getElementById("qty-dec")?.addEventListener("click", () => {
  const next = Math.max(0, Signal.subtle.untrack(() => quantity.get()) - 1);
  quantity.set(next);
  if (qtyInput) qtyInput.value = String(next);
});

modeSelect?.addEventListener("change", () => {
  pricingMode.set(modeSelect.value === "wholesale" ? "wholesale" : "standard");
});
taxInput?.addEventListener("input", () => {
  const v = Number(taxInput.value);
  if (Number.isFinite(v)) taxRate.set(v);
});
bulkInput?.addEventListener("input", () => {
  const v = Number(bulkInput.value);
  if (Number.isFinite(v)) bulkDiscount.set(v);
});
document.getElementById("apply-coupon")?.addEventListener("click", () => {
  if (couponInput) couponCode.set(couponInput.value);
});
divisorInput?.addEventListener("input", () => {
  const v = Number(divisorInput.value);
  if (Number.isFinite(v)) splitPeople.set(v);
});
document.getElementById("trigger-error")?.addEventListener("click", () => {
  splitPeople.set(0);
  if (divisorInput) divisorInput.value = "0";
});

document.getElementById("read-lazy")?.addEventListener("click", () => {
  const lazyEl = document.getElementById("out-lazy");
  if (lazyEl) {
    lazyEl.textContent = JSON.stringify(lazyAuditSnapshot.get());
  }
});

document.getElementById("burst-updates")?.addEventListener("click", () => {
  for (let step = 1; step <= 5; step++) {
    setTimeout(() => {
      quantity.set(step);
      if (qtyInput) qtyInput.value = String(step);
    }, step * 60);
  }
});

const toggleWatcherBtn = document.getElementById("toggle-watcher");
toggleWatcherBtn?.addEventListener("click", () => {
  watching = !watching;
  if (watching) {
    watcher.watch(subtotal, effectiveTotal, perPersonCost);
    toggleWatcherBtn.textContent = "Watcher Active";
  } else {
    watcher.unwatch(subtotal, effectiveTotal, perPersonCost);
    toggleWatcherBtn.textContent = "Watcher Paused";
  }
  toggleWatcherBtn.setAttribute("aria-pressed", String(watching));
});

const toggleInspectorBtn = document.getElementById("toggle-inspector");
const shell = document.querySelector(".playground-shell");
toggleInspectorBtn?.addEventListener("click", () => {
  const isHidden = shell?.classList.toggle("inspector-hidden") ?? false;
  toggleInspectorBtn.textContent = isHidden
    ? "Show Embedded Graph"
    : "Hide Embedded Graph";
  toggleInspectorBtn.setAttribute("aria-expanded", String(!isHidden));
});

// Bridge embedded panel iframe <-> in-page SignalsDevtoolsHook
const panelFrameEl = document.getElementById("panel-frame");
const panelFrame =
  panelFrameEl instanceof HTMLIFrameElement ? panelFrameEl : null;
let bridgeSubscription: (() => void) | null = null;
let bridgeFlushTimer: ReturnType<typeof setTimeout> | null = null;

function postToEmbeddedPanel(payload: BackgroundToPanelMessage): void {
  panelFrame?.contentWindow?.postMessage(
    {
      channel: BRIDGE_CHANNEL,
      direction: "host-to-panel",
      payload,
    },
    "*",
  );
}

function scheduleBridgePush(): void {
  if (bridgeFlushTimer !== null) return;
  bridgeFlushTimer = setTimeout(() => {
    bridgeFlushTimer = null;
    postToEmbeddedPanel({ type: "SNAPSHOT", snapshot: hook.snapshot() });
  }, 30);
}

function isPanelToHostEnvelope(data: unknown): data is {
  channel: string;
  direction: string;
  payload: PanelToBackgroundMessage;
} {
  return (
    data !== null &&
    typeof data === "object" &&
    Reflect.get(data, "channel") === BRIDGE_CHANNEL &&
    Reflect.get(data, "direction") === "panel-to-host" &&
    typeof Reflect.get(data, "payload") === "object"
  );
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== panelFrame?.contentWindow) return;
  if (!isPanelToHostEnvelope(event.data)) return;

  const msg = event.data.payload;
  switch (msg.type) {
    case "START_INSPECTION":
      bridgeSubscription?.();
      bridgeSubscription = hook.subscribe(() => scheduleBridgePush());
      postToEmbeddedPanel({
        type: "PAGE_CONNECTED",
        url: window.location.href,
      });
      postToEmbeddedPanel({ type: "SNAPSHOT", snapshot: hook.snapshot() });
      break;
    case "STOP_INSPECTION":
      bridgeSubscription?.();
      bridgeSubscription = null;
      break;
    case "REQUEST_SNAPSHOT":
      postToEmbeddedPanel({ type: "SNAPSHOT", snapshot: hook.snapshot() });
      break;
    case "SET_STATE_VALUE": {
      const result = hook.setValue(msg.nodeId, msg.jsonText);
      postToEmbeddedPanel({
        type: "ACTION_RESULT",
        requestId: msg.requestId,
        result,
      });
      postToEmbeddedPanel({ type: "SNAPSHOT", snapshot: hook.snapshot() });
      break;
    }
    case "EVALUATE_COMPUTED": {
      const result = hook.evaluate(msg.nodeId);
      postToEmbeddedPanel({
        type: "ACTION_RESULT",
        requestId: msg.requestId,
        result,
      });
      postToEmbeddedPanel({ type: "SNAPSHOT", snapshot: hook.snapshot() });
      break;
    }
    case "LOG_NODE":
      hook.logToConsole(msg.nodeId);
      break;
    case "CONFIGURE_HOOK":
      hook.configure(msg.settings);
      postToEmbeddedPanel({ type: "SNAPSHOT", snapshot: hook.snapshot() });
      break;
    case "CLEAR_EVENTS":
      hook.clearEvents();
      postToEmbeddedPanel({ type: "SNAPSHOT", snapshot: hook.snapshot() });
      break;
    case "PING":
      postToEmbeddedPanel({ type: "PONG" });
      break;
    case "GET_SITE_TOGGLE":
      postToEmbeddedPanel({
        type: "SITE_TOGGLE_STATE",
        originKey: msg.originKey,
        enabled: false,
      });
      break;
    case "SET_SITE_TOGGLE":
      postToEmbeddedPanel({
        type: "SITE_TOGGLE_STATE",
        originKey: msg.originKey,
        enabled: msg.enabled,
      });
      break;
  }
});
