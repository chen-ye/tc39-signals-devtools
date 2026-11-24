import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test } from "@playwright/test";
import type {
  GraphSnapshot,
  SignalEdgeSnapshot,
  SignalNodeSnapshot,
} from "../../src/protocol/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const DEMO_DIR = join(ROOT, "dist/demo");
const SHOTS_DIR = join(ROOT, "test-results/shots");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

async function startStaticServer(
  handlers: Record<string, { body: string | Uint8Array; mime: string }>,
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

function buildLargeSignalStressSnapshot(): GraphSnapshot {
  const nodes: SignalNodeSnapshot[] = [];
  const edges: SignalEdgeSnapshot[] = [];
  let nextId = 1;

  const mkNode = (
    overrides: Partial<SignalNodeSnapshot> &
      Pick<SignalNodeSnapshot, "kind" | "label">,
  ): SignalNodeSnapshot => {
    const id = nextId++;
    const node: SignalNodeSnapshot = {
      id,
      runtime: id % 5 === 0 ? "worker" : "app",
      runtimeMode: "instrumented",
      site: {
        file: `src/stores/signal-${id % 10}.ts`,
        line: 20 + (id % 80),
        column: 3,
        fn: overrides.label,
      },
      value:
        overrides.kind === "watcher"
          ? null
          : { kind: "number", text: String(id * 2) },
      error: null,
      unread: false,
      live: true,
      sets: overrides.kind === "state" ? (id % 5) + 1 : 0,
      runs: overrides.kind === "computed" ? (id % 4) + 1 : 0,
      notifies: overrides.kind === "watcher" ? 3 : 0,
      lastRunMs: overrides.kind === "computed" ? 0.12 : null,
      lastChangedSeq: id,
      causes: [],
      ...overrides,
    };
    nodes.push(node);
    return node;
  };

  // Hub state fanning out to 10 computed signals (triggers yEd bus trunk >= 5)
  const rootState = mkNode({ kind: "state", label: "telemetryFrame" });
  const branchComputeds: SignalNodeSnapshot[] = [];
  for (let i = 0; i < 10; i++) {
    const comp = mkNode({
      kind: "computed",
      label: `branchMetric${i}`,
      computeSource: `() => telemetryFrame.get().channels[${i}]`,
      computeSignature: `() => telemetryFrame.get().channels[${i}]`,
    });
    branchComputeds.push(comp);
    edges.push({ sourceId: rootState.id, sinkId: comp.id });
  }

  // Chain downstream computeds + watchers up to 380 active nodes
  let idx = 0;
  while (nodes.length < 370) {
    const upstream = branchComputeds[idx % branchComputeds.length]!;
    const derived = mkNode({
      kind: "computed",
      label: `formattedMetric${idx}`,
      computeSource: `() => Math.round(branchMetric${idx % 10}.get())`,
      computeSignature: `() => Math.round(...)`,
    });
    edges.push({ sourceId: upstream.id, sinkId: derived.id });
    if (nodes.length < 369) {
      const watch = mkNode({
        kind: "watcher",
        label: `renderTile${idx}`,
      });
      edges.push({ sourceId: derived.id, sinkId: watch.id });
    }
    idx++;
  }

  // 30 isolated nodes + 4 internal plumbing signals (= 404 total, 400 visible by default)
  while (nodes.length < 400) {
    mkNode({
      kind: "state",
      label: `isolatedFlag${nodes.length}`,
      live: false,
    });
  }
  for (let i = 0; i < 4; i++) {
    const internalSig = mkNode({
      kind: "state",
      label: "__forceUpdateSignal",
      internal: true,
    });
    edges.push({
      sourceId: internalSig.id,
      sinkId: branchComputeds[i]!.id,
    });
  }

  return {
    version: 1,
    seq: 404,
    baseSeq: 0,
    droppedEvents: 0,
    settings: { writeStacks: false, paused: false },
    runtimes: [
      { name: "app", mode: "instrumented" },
      { name: "worker", mode: "instrumented" },
    ],
    nodes,
    edges,
    events: [],
  };
}

test.describe("TC39 Signals Wave 3 Feature E2E & Stress Verification", () => {
  test("splitters, bottom timeline collapse/restore, Compute Expression, Open Source, Highlight/Filter, Focus Subgraph, and Runtimes popover", async () => {
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

      await page
        .context()
        .grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.goto(`${server.origin}/index.html`);

      const frame = page.frameLocator("#panel-frame");
      await expect(frame.getByTestId("connection-status")).toHaveAttribute(
        "data-state",
        "connected",
      );

      // 1. Verify Compute Expression & Open Source & Focus Subgraph in Inspector
      await frame.locator('.graph-node[aria-label^="effectiveTotal,"]').click();
      await expect(
        frame.getByTestId("compute-expression-section"),
      ).toBeVisible();
      await expect(
        frame.getByTestId("compute-expression-section"),
      ).toContainText("pricingMode.get()");

      await frame.getByTestId("open-source-btn").click();
      await expect(frame.getByTestId("action-feedback")).toContainText(
        "Copied source location to clipboard",
      );
      await frame.getByTestId("inspector-site-btn").click();
      await expect(frame.getByTestId("action-feedback")).toContainText(
        "Copied source location to clipboard",
      );

      // Focus subgraph scopes down from 13 to subgraph around effectiveTotal, and Escape exits even while a node is focused
      await frame.getByTestId("focus-subgraph-btn").click();
      await expect(frame.getByTestId("focus-breadcrumb")).toBeVisible();
      const focusedCount = await frame.locator(".graph-node").count();
      expect(focusedCount).toBeLessThan(13);
      expect(focusedCount).toBeGreaterThan(5);
      await frame.locator(".graph-node").first().focus();
      await page.keyboard.press("Escape");
      await expect(frame.getByTestId("focus-breadcrumb")).toBeHidden();
      await expect(frame.locator(".graph-node")).toHaveCount(13);

      // 2. Standalone panel test for splitters, Wide & Tall corner ownership, collapse, Highlight/Filter, Runtimes popover
      const snapPayload = await page.evaluate((): unknown => {
        const hook: unknown = Reflect.get(
          globalThis,
          "__SIGNALS_DEVTOOLS_HOOK__",
        );
        const fn: unknown =
          hook && typeof hook === "object"
            ? Reflect.get(hook, "snapshot")
            : null;
        if (typeof fn !== "function") throw new Error("Missing hook.snapshot");
        return Reflect.apply(fn, hook, []);
      });

      const panelPage = await browser.newPage({
        viewport: { width: 1280, height: 800 },
      });
      panelPage.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      panelPage.on("pageerror", (err) => pageErrors.push(err.message));

      await panelPage.goto(`${server.origin}/panel.html`);
      await panelPage.evaluate((snap) => {
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

      await expect(panelPage.locator(".graph-node")).toHaveCount(13);

      // Verify Wide & Tall corner ownership: inspector spans full height right, timeline is bottom-left!
      const geometry = await panelPage.evaluate(() => {
        const insp = document
          .getElementById("inspector-pane")!
          .getBoundingClientRect();
        const tl = document
          .getElementById("timeline-pane")!
          .getBoundingClientRect();
        const stage = document
          .getElementById("graph-stage")!
          .getBoundingClientRect();
        return { insp, tl, stage };
      });
      expect(geometry.insp.left).toBeGreaterThanOrEqual(geometry.tl.right);
      expect(geometry.insp.height).toBeGreaterThan(geometry.tl.height + 200);
      expect(geometry.tl.width).toBeCloseTo(geometry.stage.width, 0);

      // Drag right splitter left by 90px
      const rightSplitter = panelPage.getByTestId("splitter-right");
      const rsBox = await rightSplitter.boundingBox();
      expect(rsBox).toBeTruthy();
      const beforeInspW = geometry.insp.width;
      await panelPage.mouse.move(
        rsBox!.x + rsBox!.width / 2,
        rsBox!.y + rsBox!.height / 2,
      );
      await panelPage.mouse.down();
      await panelPage.mouse.move(
        rsBox!.x + rsBox!.width / 2 - 90,
        rsBox!.y + rsBox!.height / 2,
      );
      await panelPage.mouse.up();
      const afterInspW = await panelPage
        .getByTestId("inspector-view")
        .evaluate((el) => el.getBoundingClientRect().width);
      expect(afterInspW).toBeGreaterThan(beforeInspW + 70);

      // Collapse timeline via button -> timeline-body hidden, header remains clickable to restore
      await panelPage.getByTestId("timeline-collapse-btn").click();
      await expect(panelPage.locator("#panel-shell")).toHaveAttribute(
        "data-bottom-collapsed",
        "true",
      );
      await expect(panelPage.locator("#timeline-body")).toBeHidden();
      await expect(
        panelPage.getByTestId("timeline-collapse-btn"),
      ).toBeVisible();
      await panelPage.getByTestId("timeline-collapse-btn").click();
      await expect(panelPage.locator("#panel-shell")).toHaveAttribute(
        "data-bottom-collapsed",
        "false",
      );
      await expect(panelPage.locator("#timeline-body")).toBeVisible();

      // Drag bottom splitter down past snap threshold (< 56px) -> collapses bottom timeline
      const bottomSplitter = panelPage.getByTestId("splitter-bottom");
      const bsBox = await bottomSplitter.boundingBox();
      expect(bsBox).toBeTruthy();
      await panelPage.mouse.move(
        bsBox!.x + bsBox!.width / 2,
        bsBox!.y + bsBox!.height / 2,
      );
      await panelPage.mouse.down();
      await panelPage.mouse.move(bsBox!.x + bsBox!.width / 2, 790);
      await panelPage.mouse.up();
      await expect(panelPage.locator("#panel-shell")).toHaveAttribute(
        "data-bottom-collapsed",
        "true",
      );
      await panelPage.getByTestId("timeline-collapse-btn").click();

      // Verify Highlight (default) vs Filter query mode + N/M stepper
      // "coupon" matches couponCode, couponSavings, plus effectiveTotal & lazyAuditSnapshot via computeSource!
      const searchInput = panelPage.getByTestId("search-input");
      await searchInput.fill("coupon");
      await expect(panelPage.locator(".graph-node")).toHaveCount(13); // Highlight keeps all 13 visible
      await expect(panelPage.getByTestId("search-match-count")).toHaveText(
        "1/4",
      );
      await expect(
        panelPage.locator('.graph-node[data-search-match="true"]'),
      ).toHaveCount(4);
      await expect(
        panelPage.locator('.graph-node[data-dimmed="true"]'),
      ).toHaveCount(9);
      await panelPage.getByTestId("search-next-btn").click();
      await expect(panelPage.getByTestId("search-match-count")).toHaveText(
        "2/4",
      );

      // Toggle to Filter mode -> only 4 matching nodes visible
      await panelPage.getByTestId("search-mode-btn").click();
      await expect(panelPage.getByTestId("search-mode-btn")).toHaveText(
        "Filter",
      );
      await expect(panelPage.locator(".graph-node")).toHaveCount(4);

      // Structured query "kind:state coupon" -> 1 match (couponCode)
      await searchInput.fill("kind:state coupon");
      await expect(panelPage.getByTestId("search-match-count")).toHaveText(
        "1/1",
      );
      await expect(panelPage.locator(".graph-node")).toHaveCount(1);

      await panelPage.getByTestId("search-mode-btn").click();
      await panelPage.getByTestId("search-clear-btn").click();
      await expect(panelPage.locator(".graph-node")).toHaveCount(13);

      // Verify Runtimes popover -runtime: exclusion, Only toggle, & Show all
      await panelPage.getByTestId("runtimes-filter-btn").click();
      await expect(panelPage.getByTestId("runtimes-popover")).toBeVisible();
      const onlyBtn = panelPage
        .getByTestId("runtimes-popover")
        .getByRole("button", { name: "Only" });
      await onlyBtn.click();
      await expect(searchInput).toHaveValue("runtime:demo");
      await expect(onlyBtn).toHaveAttribute("aria-pressed", "true");
      await onlyBtn.click();
      await expect(searchInput).toHaveValue("");
      await panelPage
        .getByTestId("runtimes-popover")
        .locator('label:has-text("demo") input[type="checkbox"]')
        .uncheck();
      await expect(searchInput).toHaveValue("-runtime:demo");
      await expect(panelPage.locator(".graph-node")).toHaveCount(0);
      await panelPage
        .getByTestId("runtimes-popover")
        .getByRole("button", { name: "Show all" })
        .click();
      await expect(panelPage.locator(".graph-node")).toHaveCount(13);
      await panelPage.keyboard.press("Escape");
      await expect(panelPage.getByTestId("runtimes-popover")).toBeHidden();

      // Verify internal-only snapshot offers "Show internal signals" CTA instead of dead-end Reset filters
      await panelPage.evaluate(() => {
        window.postMessage(
          {
            channel: "tc39-signals-devtools",
            direction: "host-to-panel",
            payload: {
              type: "SNAPSHOT",
              snapshot: {
                version: 1,
                seq: 1,
                baseSeq: 0,
                droppedEvents: 0,
                settings: { writeStacks: false, paused: false },
                runtimes: [{ name: "demo", mode: "instrumented" }],
                nodes: [
                  {
                    id: 901,
                    kind: "state",
                    label: "__forceUpdateSignal",
                    internal: true,
                    runtime: "demo",
                    runtimeMode: "instrumented",
                    site: null,
                    value: { kind: "number", text: "0" },
                    error: null,
                    unread: false,
                    live: false,
                    sets: 0,
                    runs: 0,
                    notifies: 0,
                    lastRunMs: null,
                    lastChangedSeq: 0,
                    causes: [],
                  },
                ],
                edges: [],
                events: [],
              },
            },
          },
          window.location.origin,
        );
      });
      await expect(panelPage.getByTestId("filter-empty")).toBeVisible();
      await expect(panelPage.getByTestId("reset-filters")).toHaveText(
        "Show internal signals",
      );
      await panelPage.getByTestId("reset-filters").click();
      await expect(panelPage.getByTestId("filter-empty")).toBeHidden();
      await expect(panelPage.locator(".graph-node")).toHaveCount(1);

      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
      await panelPage.close();
    } finally {
      await browser.close();
      await server.close();
    }
  });

  test("eliminates 'computed · new Mi...' truncation on unlabeled class Computeds and hides __forceUpdateSignal behind [Internal]", async () => {
    const fixtureEntry = join(ROOT, "tests/e2e/fixtures-unlabeled-signals.ts");
    const bundledJs = execFileSync(
      "bun",
      ["build", fixtureEntry, "--format=esm", "--target=browser"],
      {
        cwd: ROOT,
        encoding: "utf-8",
      },
    );

    const server = await startStaticServer(
      {
        "/fixture.html": {
          mime: "text/html; charset=utf-8",
          body: `<!doctype html><html><body><script type="module" src="/fixture.js"></script></body></html>`,
        },
        "/fixture.js": {
          mime: "text/javascript; charset=utf-8",
          body: bundledJs,
        },
      },
      DEMO_DIR,
    );
    const browser = await chromium.launch({
      channel: "chromium",
      headless: true,
    });

    try {
      const page = await browser.newPage();
      await page.goto(`${server.origin}/fixture.html`);

      const snapPayload = await page.evaluate(() => {
        const fixture: unknown = Reflect.get(window, "__SIGNALS_FIXTURE__");
        const hook: unknown =
          fixture && typeof fixture === "object"
            ? Reflect.get(fixture, "hook")
            : null;
        const snapFn: unknown =
          hook && typeof hook === "object"
            ? Reflect.get(hook, "snapshot")
            : null;
        if (typeof snapFn !== "function") {
          throw new Error("Missing hook.snapshot");
        }
        return Reflect.apply(snapFn, hook, []);
      });

      const panelPage = await browser.newPage({
        viewport: { width: 1280, height: 800 },
      });
      await panelPage.goto(`${server.origin}/panel.html`);
      await panelPage.evaluate((snap) => {
        window.postMessage(
          {
            channel: "tc39-signals-devtools",
            direction: "host-to-panel",
            payload: {
              type: "PAGE_CONNECTED",
              url: "http://127.0.0.1:4173/fixture.html",
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

      // 4 signals total (rows, visibleRows, __forceUpdateSignal, watcher) -> 3 visible by default!
      await expect(panelPage.locator(".graph-node")).toHaveCount(3);
      await expect(panelPage.getByTestId("toggle-internal")).toBeVisible();
      await expect(panelPage.getByTestId("toggle-internal-count")).toHaveText(
        "1",
      );

      // None of the rendered SVG titles may contain "computed · new" or "Mi…" truncation!
      const titles = await panelPage
        .locator(".graph-node .node-title")
        .allTextContents();
      for (const title of titles) {
        expect(title).not.toContain("computed ·");
        expect(title).not.toContain("new Mi");
      }

      // Clicking [Internal] chip reveals __forceUpdateSignal (4 nodes)
      await panelPage.getByTestId("toggle-internal").click();
      await expect(panelPage.locator(".graph-node")).toHaveCount(4);
      await expect(
        panelPage.locator('.graph-node[aria-label^="__forceUpdateSignal,"]'),
      ).toHaveCount(1);

      await panelPage.close();
    } finally {
      await browser.close();
      await server.close();
    }
  });

  test("renders 400-node stress Signals graph with bus routing, LOD zoom, [Internal] hiding, and zero overflow", async () => {
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

      const stressSnapshot = buildLargeSignalStressSnapshot();
      await page.goto(`${server.origin}/panel.html`);

      const renderMs = await page.evaluate((snap) => {
        const t0 = performance.now();
        window.postMessage(
          {
            channel: "tc39-signals-devtools",
            direction: "host-to-panel",
            payload: {
              type: "PAGE_CONNECTED",
              url: "http://127.0.0.1:4173/stress.html",
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
        return performance.now() - t0;
      }, stressSnapshot);

      // 404 total nodes, 4 __forceUpdateSignal internal nodes hidden by default => 400 rendered!
      await expect(page.locator(".graph-node")).toHaveCount(400);
      expect(renderMs).toBeLessThan(1500);

      expect(await page.locator(".graph-bus-trunk").count()).toBeGreaterThan(0);
      expect(await page.locator(".graph-bus-junction").count()).toBeGreaterThan(
        5,
      );

      await page.screenshot({
        path: join(SHOTS_DIR, "stress-400-wide.png"),
        animations: "disabled",
      });

      // Toggle [Internal (4)] shows all 404
      await page.getByTestId("toggle-internal").click();
      await expect(page.locator(".graph-node")).toHaveCount(404);

      // LOD toggles .is-zoomed-out below 45% zoom on dense graphs
      for (let i = 0; i < 4; i++) {
        await page.locator("#zoom-out").click();
      }
      await expect(page.getByTestId("graph-svg")).toHaveClass(/is-zoomed-out/);

      const overflowPx = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflowPx).toBe(0);
      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
    } finally {
      await browser.close();
      await server.close();
    }
  });
});
