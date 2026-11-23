import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test } from "@playwright/test";
import type { PanelToBackgroundMessage } from "../../src/protocol/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const EXT_DIR = join(ROOT, "dist/extension");
const DEMO_DIR = join(ROOT, "dist/demo");
const POLYFILL_JS = join(ROOT, "node_modules/signal-polyfill/dist/index.js");
const SHOTS_DIR = "/var/tmp/tc39-signals-devtools-shots";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

async function startStaticServer(
  handlers: Record<string, { body: string; mime: string }>,
  dir?: string,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const custom = handlers[reqUrl.pathname];
    if (custom) {
      res.writeHead(200, { "Content-Type": custom.mime });
      res.end(custom.body);
      return;
    }
    if (dir) {
      const rel = reqUrl.pathname === "/" ? "/index.html" : reqUrl.pathname;
      const filePath = join(dir, rel);
      if (filePath.startsWith(dir) && existsSync(filePath)) {
        res.writeHead(200, {
          "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
        });
        res.end(readFileSync(filePath));
        return;
      }
    }
    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Expected TCP address");
  }
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

test.describe("TC39 Signals DevTools MV3 Extension E2E", () => {
  test("injects MAIN hook without polluting globalThis.Signal, routes snapshots, and toggles per-origin polyfill injection", async () => {
    const server = await startStaticServer({
      "/clean.html": {
        mime: "text/html; charset=utf-8",
        body: `<!doctype html><html><body><script>
          window.testResults = {
            hasHook: Boolean(globalThis.__SIGNALS_DEVTOOLS_HOOK__ && globalThis.__SIGNALS_DEVTOOLS_HOOK__.version === 1),
            hasSignalKey: "Signal" in globalThis
          };
        </script></body></html>`,
      },
      "/global-app.html": {
        mime: "text/html; charset=utf-8",
        body: `<!doctype html><html><body>
          <div id="out">none</div>
          <script>
            const S = globalThis.Signal;
            window.hasGlobalSignal = Boolean(S);
            if (S) {
              const count = new S.State(10, { name: "extCount" });
              const doubled = new S.Computed(() => count.get() * 2, { name: "extDoubled" });
              const watcher = new S.subtle.Watcher(() => {
                queueMicrotask(() => {
                  document.getElementById("out").textContent = String(doubled.get());
                  watcher.watch();
                });
              });
              globalThis.__SIGNALS_DEVTOOLS_HOOK__?.label(watcher, "extWatcher");
              watcher.watch(doubled);
              window.keepAlive = { count, doubled, watcher };
              document.getElementById("out").textContent = String(doubled.get());
            }
          </script>
        </body></html>`,
      },
      "/signal-polyfill.js": {
        mime: "text/javascript; charset=utf-8",
        body: readFileSync(POLYFILL_JS, "utf-8"),
      },
      "/hook-register.html": {
        mime: "text/html; charset=utf-8",
        body: `<!doctype html><html><body>
          <script type="module">
            import { Signal } from "/signal-polyfill.js";
            const a = new Signal.State(7);
            const b = new Signal.Computed(() => a.get() + 5);
            const w = new Signal.subtle.Watcher(() => {});
            w.watch(b);
            b.get();
            globalThis.__SIGNALS_DEVTOOLS_HOOK__?.label(a, "privateA");
            globalThis.__SIGNALS_DEVTOOLS_HOOK__?.label(b, "privateB");
            globalThis.__SIGNALS_DEVTOOLS_HOOK__?.register({
              name: "private-esm",
              Signal,
              watchers: [w],
            });
          </script>
        </body></html>`,
      },
    });

    const userDataDir = mkdtempSync("/var/tmp/tc39-signals-ext-");
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      args: [
        `--disable-extensions-except=${EXT_DIR}`,
        `--load-extension=${EXT_DIR}`,
      ],
    });

    try {
      let [serviceWorker] = context.serviceWorkers();
      if (!serviceWorker) {
        serviceWorker = await context.waitForEvent("serviceworker");
      }
      const extensionId = serviceWorker.url().split("/")[2];
      expect(extensionId).toBeTruthy();

      const pageErrors: string[] = [];
      const page = await context.newPage();
      page.on("pageerror", (err) => pageErrors.push(err.message));

      // 1. Default state: hook is present, globalThis.Signal is NOT polluted!
      await page.goto(`${server.origin}/clean.html`);
      const cleanRes = await page.evaluate(() =>
        Reflect.get(window, "testResults"),
      );
      expect(cleanRes).toEqual({ hasHook: true, hasSignalKey: false });

      // 2. Global-signal app without toggle: globalThis.Signal is absent
      await page.goto(`${server.origin}/global-app.html`);
      expect(
        await page.evaluate(() => Reflect.get(window, "hasGlobalSignal")),
      ).toBe(false);

      // 3. Connect an extension control page (mimicking devtools:<tabId> port to background SW)
      const extControlPage = await context.newPage();
      await extControlPage.goto(
        `chrome-extension://${extensionId}/devtools.html`,
      );

      await page.bringToFront();
      const targetTabId = await serviceWorker.evaluate(async () => {
        const [activeTab] = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        return activeTab?.id ?? null;
      });
      expect(typeof targetTabId).toBe("number");

      await extControlPage.evaluate((tid) => {
        const msgs: unknown[] = [];
        const port = chrome.runtime.connect({ name: `devtools:${tid}` });
        Reflect.set(window, "portMsgs", msgs);
        Reflect.set(window, "sendPortMsg", (msg: PanelToBackgroundMessage) => {
          port.postMessage(msg);
        });
        port.onMessage.addListener((msg: unknown) => {
          msgs.push(msg);
        });
      }, targetTabId);

      // Navigate `page` to /hook-register.html (private ESM bundle calling register())
      await page.goto(`${server.origin}/hook-register.html`);
      await expect
        .poll(async () => {
          return extControlPage.evaluate(() => {
            const raw: unknown = Reflect.get(window, "portMsgs");
            if (!Array.isArray(raw)) return [];
            const labels: string[] = [];
            for (const item of raw) {
              if (
                item !== null &&
                typeof item === "object" &&
                Reflect.get(item, "type") === "SNAPSHOT"
              ) {
                const snap: unknown = Reflect.get(item, "snapshot");
                const nodes: unknown =
                  snap !== null && typeof snap === "object"
                    ? Reflect.get(snap, "nodes")
                    : null;
                if (Array.isArray(nodes)) {
                  labels.length = 0;
                  for (const n of nodes) {
                    const lbl: unknown =
                      n !== null && typeof n === "object"
                        ? Reflect.get(n, "label")
                        : null;
                    if (typeof lbl === "string") labels.push(lbl);
                  }
                }
              }
            }
            return labels;
          });
        })
        .toContain("privateB");

      // 4. Enable per-origin globalThis.Signal toggle via background port -> reload /global-app.html
      await extControlPage.evaluate(() => {
        const send: unknown = Reflect.get(window, "sendPortMsg");
        if (typeof send === "function") {
          Reflect.apply(send, window, [
            {
              type: "SET_SITE_TOGGLE",
              originKey: "http://127.0.0.1",
              enabled: true,
            },
          ]);
        }
      });

      await expect
        .poll(async () => {
          return extControlPage.evaluate(() => {
            const raw: unknown = Reflect.get(window, "portMsgs");
            if (!Array.isArray(raw)) return false;
            return raw.some(
              (m) =>
                m !== null &&
                typeof m === "object" &&
                Reflect.get(m, "type") === "SITE_TOGGLE_STATE" &&
                Reflect.get(m, "originKey") === "http://127.0.0.1" &&
                Reflect.get(m, "enabled") === true,
            );
          });
        })
        .toBe(true);

      // Navigate to /global-app.html -> polyfill-provider.js must now inject globalThis.Signal at document_start!
      await page.goto(`${server.origin}/global-app.html`);
      expect(
        await page.evaluate(() => Reflect.get(window, "hasGlobalSignal")),
      ).toBe(true);
      await expect(page.locator("#out")).toHaveText("20");

      let extCountNodeId: number | null = null;
      await expect
        .poll(async () => {
          const found = await extControlPage.evaluate(() => {
            const raw: unknown = Reflect.get(window, "portMsgs");
            if (!Array.isArray(raw)) return null;
            let result: { id: number; text: string | null } | null = null;
            for (const item of raw) {
              if (
                item !== null &&
                typeof item === "object" &&
                Reflect.get(item, "type") === "SNAPSHOT"
              ) {
                const snap: unknown = Reflect.get(item, "snapshot");
                const nodes: unknown =
                  snap !== null && typeof snap === "object"
                    ? Reflect.get(snap, "nodes")
                    : null;
                if (Array.isArray(nodes)) {
                  for (const n of nodes) {
                    if (
                      n !== null &&
                      typeof n === "object" &&
                      Reflect.get(n, "label") === "extCount"
                    ) {
                      const id: unknown = Reflect.get(n, "id");
                      const val: unknown = Reflect.get(n, "value");
                      const text: unknown =
                        val !== null && typeof val === "object"
                          ? Reflect.get(val, "text")
                          : null;
                      if (typeof id === "number") {
                        result = {
                          id,
                          text: typeof text === "string" ? text : null,
                        };
                      }
                    }
                  }
                }
              }
            }
            return result;
          });
          if (found) extCountNodeId = found.id;
          return found?.text ?? null;
        })
        .toBe("10");

      await extControlPage.evaluate((nodeId) => {
        const send: unknown = Reflect.get(window, "sendPortMsg");
        if (typeof send === "function") {
          Reflect.apply(send, window, [
            {
              type: "SET_STATE_VALUE",
              nodeId,
              jsonText: "25",
              requestId: "e2e-set-1",
            },
          ]);
        }
      }, extCountNodeId!);

      await expect
        .poll(async () => {
          return extControlPage.evaluate(() => {
            const raw: unknown = Reflect.get(window, "portMsgs");
            if (!Array.isArray(raw)) return null;
            const match = raw.find(
              (m) =>
                m !== null &&
                typeof m === "object" &&
                Reflect.get(m, "type") === "ACTION_RESULT" &&
                Reflect.get(m, "requestId") === "e2e-set-1",
            );
            return match !== null && typeof match === "object"
              ? Reflect.get(match, "result")
              : null;
          });
        })
        .toEqual({ ok: true });

      // Host page DOM updated automatically from 20 -> 50 via extension messaging!
      await expect(page.locator("#out")).toHaveText("50");

      // 5. Disable per-origin toggle -> reload /clean.html -> globalThis.Signal is absent again!
      await extControlPage.evaluate(() => {
        const send: unknown = Reflect.get(window, "sendPortMsg");
        if (typeof send === "function") {
          Reflect.apply(send, window, [
            {
              type: "SET_SITE_TOGGLE",
              originKey: "http://127.0.0.1",
              enabled: false,
            },
          ]);
        }
      });
      await expect
        .poll(async () => {
          return extControlPage.evaluate(() => {
            const raw: unknown = Reflect.get(window, "portMsgs");
            if (!Array.isArray(raw)) return false;
            return raw.some(
              (m) =>
                m !== null &&
                typeof m === "object" &&
                Reflect.get(m, "type") === "SITE_TOGGLE_STATE" &&
                Reflect.get(m, "originKey") === "http://127.0.0.1" &&
                Reflect.get(m, "enabled") === false,
            );
          });
        })
        .toBe(true);

      await page.goto(`${server.origin}/clean.html`);
      const afterToggleOff = await page.evaluate(() =>
        Reflect.get(window, "testResults"),
      );
      expect(afterToggleOff).toEqual({ hasHook: true, hasSignalKey: false });
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
      await server.close();
    }
  });

  test("registers the Signals tab inside a real Chrome DevTools window", async () => {
    const server = await startStaticServer({}, DEMO_DIR);
    const userDataDir = mkdtempSync("/var/tmp/tc39-signals-devtools-win-");
    const prevEnv = process.env.PW_CHROMIUM_ATTACH_TO_OTHER;
    process.env.PW_CHROMIUM_ATTACH_TO_OTHER = "1";

    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      args: [
        `--disable-extensions-except=${EXT_DIR}`,
        `--load-extension=${EXT_DIR}`,
        "--auto-open-devtools-for-tabs",
      ],
    });

    try {
      let [serviceWorker] = context.serviceWorkers();
      if (!serviceWorker) {
        serviceWorker = await context.waitForEvent("serviceworker");
      }

      const initialDevtools = new Set(
        context.pages().filter((p) => p.url().startsWith("devtools://")),
      );
      const page = await context.newPage();
      await page.goto(`${server.origin}/index.html`);

      await expect
        .poll(() =>
          context
            .pages()
            .some(
              (p) =>
                p.url().startsWith("devtools://devtools") &&
                !initialDevtools.has(p),
            ),
        )
        .toBe(true);

      const devtoolsPage = context
        .pages()
        .find(
          (p) =>
            p.url().startsWith("devtools://devtools") &&
            !initialDevtools.has(p),
        );
      expect(devtoolsPage).toBeTruthy();

      await expect
        .poll(async () => {
          const urls = devtoolsPage!.frames().map((f) => f.url());
          return urls.some((u) => u.includes("/devtools.html"));
        })
        .toBe(true);

      const mainNav = devtoolsPage!.getByRole("navigation", {
        name: "Main toolbar",
      });
      await mainNav.getByRole("tab", { name: "Elements" }).click();
      for (let i = 0; i < 15; i++) {
        if (
          (await devtoolsPage!.locator('iframe[src*="panel.html"]').count()) > 0
        ) {
          break;
        }
        await devtoolsPage!.keyboard.press("Control+]");
        await devtoolsPage!.waitForTimeout(80);
      }

      const panelFrame = devtoolsPage!.frameLocator(
        'iframe[src*="panel.html"]',
      );
      await expect(panelFrame.getByTestId("connection-status")).toHaveAttribute(
        "data-state",
        "connected",
      );
      await expect(panelFrame.getByTestId("stat-states")).toHaveText("7");
      await expect(panelFrame.getByTestId("stat-computeds")).toHaveText("5");
      mkdirSync(SHOTS_DIR, { recursive: true });
      await devtoolsPage!.screenshot({
        path: join(SHOTS_DIR, "devtools-window-signals.png"),
      });
    } finally {
      if (prevEnv === undefined) {
        delete process.env.PW_CHROMIUM_ATTACH_TO_OTHER;
      } else {
        process.env.PW_CHROMIUM_ATTACH_TO_OTHER = prevEnv;
      }
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
      await server.close();
    }
  });
});

test.describe("Panel UI & Demo Playground Interactive Verification", () => {
  test("renders reactivity graph, causal path, live State editing, errors, lazy eval, timeline, and multi-viewport screenshots", async () => {
    mkdirSync(SHOTS_DIR, { recursive: true });
    const server = await startStaticServer({}, DEMO_DIR);
    const browser = await chromium.launch({
      channel: "chromium",
      headless: true,
    });

    try {
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];

      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      page.on("pageerror", (err) => pageErrors.push(err.message));

      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(`${server.origin}/index.html`);

      const frame = page.frameLocator("#panel-frame");
      await expect(frame.getByTestId("connection-status")).toHaveAttribute(
        "data-state",
        "connected",
      );
      await expect(frame.getByTestId("stat-states")).toHaveText("7");
      await expect(frame.getByTestId("stat-computeds")).toHaveText("5");
      await expect(frame.getByTestId("stat-watchers")).toHaveText("1");

      await page.click("#price-inc");
      await expect(page.getByTestId("out-subtotal")).toHaveText("$90.00");

      const effectiveTotalNode = frame.locator(
        '.graph-node[aria-label^="effectiveTotal,"]',
      );
      await effectiveTotalNode.click();
      await expect(effectiveTotalNode).toHaveAttribute("data-selected", "true");
      await expect(frame.getByTestId("inspector-causes")).toContainText(
        "subtotal",
      );
      await page.screenshot({ path: join(SHOTS_DIR, "demo-wide-light.png") });

      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: join(SHOTS_DIR, "demo-wide-dark.png") });

      const unitPriceNode = frame.locator(
        '.graph-node[aria-label^="unitPrice,"]',
      );
      await unitPriceNode.click();
      await frame.getByTestId("state-value-input").fill("100");
      await frame.getByTestId("state-set-btn").click();
      await expect(frame.getByTestId("action-feedback")).toContainText(
        "Updated State",
      );
      await expect(page.getByTestId("out-subtotal")).toHaveText("$300.00");

      await page.click("#trigger-error");
      await expect(frame.getByTestId("stat-errors")).toHaveText("1");
      await frame.getByTestId("filter-errors").click();
      await expect(frame.locator(".graph-node")).toHaveCount(1);
      await frame.locator(".graph-node").first().click();
      await expect(frame.getByTestId("inspector-error")).toContainText(
        "splitPeople must be > 0",
      );

      await frame.getByTestId("filter-errors").click();
      const lazyNode = frame.locator(
        '.graph-node[aria-label^="lazyAuditSnapshot,"]',
      );
      await lazyNode.click();
      await expect(frame.getByTestId("inspector-value")).toContainText(
        "unread",
      );
      await frame.getByTestId("evaluate-computed-btn").click();
      await expect(frame.getByTestId("inspector-entries")).toBeVisible();

      const panelOnly = await browser.newPage();
      panelOnly.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      panelOnly.on("pageerror", (err) => pageErrors.push(err.message));

      await panelOnly.setViewportSize({ width: 1000, height: 680 });
      await panelOnly.emulateMedia({ colorScheme: "dark" });
      await panelOnly.goto(`${server.origin}/panel.html`);
      await expect(panelOnly.getByTestId("empty-state")).toBeVisible();
      await expect(panelOnly.getByTestId("site-toggle")).toBeHidden();
      await expect(panelOnly.getByTestId("timeline-view")).toBeHidden();
      const emptyContainment = await panelOnly.evaluate(() => {
        const stage = document
          .getElementById("graph-stage")!
          .getBoundingClientRect();
        const card = document
          .querySelector(".empty-card")!
          .getBoundingClientRect();
        return {
          fitsTop: card.top >= stage.top,
          fitsBottom: card.bottom <= stage.bottom,
        };
      });
      expect(emptyContainment).toEqual({ fitsTop: true, fitsBottom: true });
      await panelOnly.screenshot({
        path: join(SHOTS_DIR, "panel-empty-state-dark.png"),
      });
      await panelOnly.close();

      const panelUrl = `${server.origin}/panel.html`;
      const hostedPanel = await browser.newPage({
        viewport: { width: 1280, height: 440 },
      });
      await hostedPanel.emulateMedia({ colorScheme: "light" });

      const snapPayload = await page.evaluate((): unknown => {
        const hook: unknown = Reflect.get(
          globalThis,
          "__SIGNALS_DEVTOOLS_HOOK__",
        );
        if (hook === null || typeof hook !== "object") {
          throw new Error("Missing global hook");
        }
        const snapshotFn: unknown = Reflect.get(hook, "snapshot");
        if (typeof snapshotFn !== "function") {
          throw new Error("Missing snapshot()");
        }
        return Reflect.apply(snapshotFn, hook, []);
      });

      await hostedPanel.goto(panelUrl);
      await hostedPanel.evaluate((snap) => {
        window.postMessage(
          {
            channel: "tc39-signals-devtools",
            direction: "host-to-panel",
            payload: {
              type: "PAGE_CONNECTED",
              url: "http://127.0.0.1:4173/index.html",
            },
          },
          window.location.origin,
        );
        window.postMessage(
          {
            channel: "tc39-signals-devtools",
            direction: "host-to-panel",
            payload: { type: "SNAPSHOT", snapshot: snap },
          },
          window.location.origin,
        );
      }, snapPayload);

      await expect(hostedPanel.getByTestId("stat-states")).toHaveText("7");
      await hostedPanel
        .locator('.graph-node[aria-label^="effectiveTotal,"]')
        .click();
      await hostedPanel.getByTestId("fit-graph").click();
      await hostedPanel.screenshot({
        path: join(SHOTS_DIR, "panel-docked-bottom-light.png"),
      });

      await hostedPanel.setViewportSize({ width: 1280, height: 800 });
      await hostedPanel.emulateMedia({ colorScheme: "dark" });
      await hostedPanel.getByTestId("fit-graph").click();
      await hostedPanel.screenshot({
        path: join(SHOTS_DIR, "panel-wide-tall-dark.png"),
      });

      await hostedPanel.setViewportSize({ width: 540, height: 900 });
      await hostedPanel.emulateMedia({ colorScheme: "dark" });
      await hostedPanel.getByTestId("fit-graph").click();
      await hostedPanel.screenshot({
        path: join(SHOTS_DIR, "panel-docked-right-dark.png"),
      });

      await hostedPanel.setViewportSize({ width: 420, height: 700 });
      await hostedPanel.getByTestId("tab-timeline").click();
      await expect(hostedPanel.getByTestId("timeline-view")).toBeVisible();
      await hostedPanel.getByTestId("fit-graph").click();
      await hostedPanel.screenshot({
        path: join(SHOTS_DIR, "panel-narrow-timeline-dark.png"),
      });

      const overflowPx = await hostedPanel.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflowPx).toBe(0);

      await hostedPanel.close();
      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
    } finally {
      await browser.close();
      await server.close();
    }
  });
});
