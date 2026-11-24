import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  GraphViewportController,
  MAX_SCALE,
  MIN_SCALE,
  findNearestDirectionalNode,
  type DirectionalNode,
} from "../../src/shared/graph-viewport.ts";
import {
  DEFAULT_PANE_BOUNDS,
  clampBottomHeight,
  clampPaneLayoutState,
  clampRightWidth,
  createPaneLayoutController,
  deserializePaneLayout,
  serializePaneLayout,
  type PaneLayoutState,
} from "../../src/shared/pane-layout.ts";
import {
  isEditableElement,
  registerPanelShortcuts,
} from "../../src/shared/shortcuts.ts";
import {
  findMatchingResource,
  openSourceLocation,
} from "../../src/shared/source-jump.ts";
import {
  createSourceMapResolver,
  decodeInlineSourceMapDataUrl,
  decodeVlqSegment,
  extractSourceMappingUrl,
  parseSourceMap,
  resolveOriginalPosition,
} from "../../src/shared/sourcemap.ts";
import { createThemeController } from "../../src/shared/theme.ts";

describe("sourcemap VLQ decoder and SourceMap v3 resolver", () => {
  test("decodeVlqSegment decodes zero, positive, negative, and multi-byte VLQ values", () => {
    expect(decodeVlqSegment("")).toEqual([]);
    expect(decodeVlqSegment("AAAA")).toEqual([0, 0, 0, 0]);
    expect(decodeVlqSegment("KACEA")).toEqual([5, 0, 1, 2, 0]);
    expect(decodeVlqSegment("ACDEC")).toEqual([0, 1, -1, 2, 1]);
    // Multi-byte: 'gB' => +16, 'hB' => -16
    expect(decodeVlqSegment("gBhB")).toEqual([16, -16]);
    expect(() => decodeVlqSegment("A?")).toThrow();
  });

  test("parseSourceMap and resolveOriginalPosition handle multi-source mappings, sourceRoot, and unmapped segments", () => {
    const rawJson = `)]}'\n${JSON.stringify({
      version: 3,
      sourceRoot: "https://app.test/src/",
      sources: ["a.ts", "b.ts"],
      names: ["foo", "bar"],
      mappings: "AAAA,KACEA;ACDEC;A,EAAA",
    })}`;

    const map = parseSourceMap(rawJson);
    expect(map).not.toBeNull();
    if (!map) return;

    // Line 1, col 1 -> a.ts:1:1
    expect(resolveOriginalPosition(map, 1, 1)).toEqual({
      source: "https://app.test/src/a.ts",
      line: 1,
      column: 1,
      name: null,
    });

    // Line 1, col 4 -> greatest lower bound is segment at col1=1
    expect(resolveOriginalPosition(map, 1, 4)).toEqual({
      source: "https://app.test/src/a.ts",
      line: 1,
      column: 1,
      name: null,
    });

    // Line 1, col 6 (genCol=5) -> a.ts:2:3 (foo)
    expect(resolveOriginalPosition(map, 1, 6)).toEqual({
      source: "https://app.test/src/a.ts",
      line: 2,
      column: 3,
      name: "foo",
    });

    // Line 2, col 1 -> persists state across ';' and switches to b.ts:1:5 (bar)
    expect(resolveOriginalPosition(map, 2, 1)).toEqual({
      source: "https://app.test/src/b.ts",
      line: 1,
      column: 5,
      name: "bar",
    });

    // Line 3, col 1 -> 1-field unmapped segment returns null
    expect(resolveOriginalPosition(map, 3, 1)).toBeNull();
    // Line 3, col 3 (genCol=2) -> 4-field segment has no name field
    expect(resolveOriginalPosition(map, 3, 3)).toEqual({
      source: "https://app.test/src/b.ts",
      line: 1,
      column: 5,
      name: null,
    });
  });

  test("createSourceMapResolver resolves inline base64 data URIs, external .map files, and enforces LRU cache", async () => {
    const inlineMap = {
      version: 3,
      sources: ["../src/widget.ts"],
      names: ["render"],
      mappings: "AAAA,KACEA",
    };
    const encoded = Buffer.from(JSON.stringify(inlineMap), "utf8").toString(
      "base64",
    );
    const inlineDataUrl = `data:application/json;charset=utf-8;base64,${encoded}`;
    expect(decodeInlineSourceMapDataUrl(inlineDataUrl)).toBe(
      JSON.stringify(inlineMap),
    );

    const scriptWithInline = `function x(){}\n//# sourceMappingURL=${inlineDataUrl}\n`;
    expect(extractSourceMappingUrl(scriptWithInline)).toBe(inlineDataUrl);

    const fetchedUrls: string[] = [];
    const files = new Map<string, string>([
      ["http://localhost:5173/dist/inline.js", scriptWithInline],
      [
        "http://localhost:5173/dist/ext.js",
        "const a=1;\n//# sourceMappingURL=ext.js.map\n",
      ],
      [
        "http://localhost:5173/dist/ext.js.map",
        JSON.stringify({
          version: 3,
          sources: ["../src/ext-source.ts"],
          mappings: "AAAA",
        }),
      ],
      [
        "http://localhost:5173/dist/third.js",
        "const b=2;\n//# sourceMappingURL=third.js.map\n",
      ],
      [
        "http://localhost:5173/dist/third.js.map",
        JSON.stringify({
          version: 3,
          sources: ["../src/third.ts"],
          mappings: "AAAA",
        }),
      ],
    ]);

    const fetchText = async (url: string): Promise<string | null> => {
      fetchedUrls.push(url);
      return files.get(url) ?? null;
    };

    const resolver = createSourceMapResolver({ maxEntries: 2 });

    const pos1 = await resolver.resolve(
      "http://localhost:5173/dist/inline.js",
      1,
      6,
      fetchText,
    );
    expect(pos1).toEqual({
      source: "http://localhost:5173/src/widget.ts",
      line: 2,
      column: 3,
      name: "render",
    });

    const pos2 = await resolver.resolve(
      "http://localhost:5173/dist/ext.js",
      1,
      1,
      fetchText,
    );
    expect(pos2).toEqual({
      source: "http://localhost:5173/src/ext-source.ts",
      line: 1,
      column: 1,
      name: null,
    });
    expect(resolver.size()).toBe(2);

    // Touch inline.js again so ext.js becomes least recently used (cache hit -> no fetch)
    const countBeforeHit = fetchedUrls.length;
    await resolver.resolve(
      "http://localhost:5173/dist/inline.js",
      1,
      1,
      fetchText,
    );
    expect(fetchedUrls.length).toBe(countBeforeHit);

    // Insert third.js -> evicts ext.js, keeps inline.js
    await resolver.resolve(
      "http://localhost:5173/dist/third.js",
      1,
      1,
      fetchText,
    );
    expect(resolver.size()).toBe(2);

    const countBeforeInline = fetchedUrls.length;
    await resolver.resolve(
      "http://localhost:5173/dist/inline.js",
      1,
      1,
      fetchText,
    );
    expect(fetchedUrls.length).toBe(countBeforeInline);
  });

  test("extractSourceMappingUrl handles >12KB inline base64 data URIs and block comments", () => {
    const bigMap = {
      version: 3,
      sources: Array.from({ length: 300 }, (_, i) => `src/file-${i}.ts`),
      names: Array.from({ length: 300 }, (_, i) => `symbol_${i}`),
      mappings: "AAAA;".repeat(400),
    };
    const encoded = Buffer.from(JSON.stringify(bigMap), "utf8").toString(
      "base64",
    );
    const inlineDataUrl = `data:application/json;charset=utf-8;base64,${encoded}`;
    expect(inlineDataUrl.length).toBeGreaterThan(12000);

    const script = `function bundle(){return 1;}\n//# sourceMappingURL=${inlineDataUrl}\n`;
    expect(extractSourceMappingUrl(script)).toBe(inlineDataUrl);

    const blockScript = `function x(){}\n/*# sourceMappingURL=app.bundle.js.map */\n`;
    expect(extractSourceMappingUrl(blockScript)).toBe("app.bundle.js.map");
  });
});

function makeMockPaneElement(rect: { width: number; height: number }) {
  const attrs = new Map<string, string>();
  const styles = new Map<string, string>();
  const dataset: Record<string, string | undefined> = {};
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  return {
    dataset,
    style: {
      setProperty(name: string, val: string | null) {
        if (val === null) {
          styles.delete(name);
        } else {
          styles.set(name, val);
        }
      },
      getPropertyValue(name: string) {
        return styles.get(name) ?? "";
      },
    },
    setAttribute(name: string, val: string) {
      attrs.set(name, val);
    },
    getAttribute(name: string) {
      return attrs.get(name) ?? null;
    },
    getBoundingClientRect() {
      return {
        width: rect.width,
        height: rect.height,
      };
    },
    addEventListener(type: string, fn: EventListenerOrEventListenerObject) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener(type: string, fn: EventListenerOrEventListenerObject) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type: string, props: Record<string, unknown>) {
      const evt = new Event(type, { cancelable: true });
      Object.assign(evt, props);
      for (const fn of listeners.get(type) ?? []) {
        if (typeof fn === "function") {
          fn(evt);
        } else {
          fn.handleEvent(evt);
        }
      }
    },
  };
}

describe("pane-layout clamping, serialization, and controller", () => {
  test("clamps rightWidthPx and bottomHeightPx against container bounds", () => {
    expect(DEFAULT_PANE_BOUNDS).toEqual({
      minRight: 240,
      minGraphWidth: 280,
      minBottom: 130,
      minGraphHeight: 180,
    });

    // Container 1000w -> max right = 1000 - 280 = 720
    expect(clampRightWidth(100, 1000)).toBe(240);
    expect(clampRightWidth(800, 1000)).toBe(720);
    expect(clampRightWidth(360, 1000)).toBe(360);
    expect(clampRightWidth(Number.NaN, 1000)).toBe(240);

    // Narrow container 400w -> max = max(240, 400 - 280) = 240
    expect(clampRightWidth(350, 400)).toBe(240);

    // Unmeasured container 0w -> preserves >= minRight
    expect(clampRightWidth(380, 0)).toBe(380);

    // Container 600h -> max bottom = 600 - 180 = 420
    expect(clampBottomHeight(80, 600)).toBe(130);
    expect(clampBottomHeight(500, 600)).toBe(420);
    expect(clampBottomHeight(240, 600)).toBe(240);

    const clamped = clampPaneLayoutState(
      { rightWidthPx: 900, bottomHeightPx: 90, bottomCollapsed: true },
      { width: 1000, height: 600 },
    );
    expect(clamped).toEqual({
      rightWidthPx: 720,
      bottomHeightPx: 130,
      bottomCollapsed: true,
    });
  });

  test("serializes and deserializes pane layout safely with corrupt input fallback", () => {
    const fallback: PaneLayoutState = {
      rightWidthPx: 340,
      bottomHeightPx: 220,
      bottomCollapsed: false,
    };

    const json = serializePaneLayout({
      rightWidthPx: 412.6,
      bottomHeightPx: 199.2,
      bottomCollapsed: true,
    });
    expect(deserializePaneLayout(json, fallback)).toEqual({
      rightWidthPx: 413,
      bottomHeightPx: 199,
      bottomCollapsed: true,
    });

    expect(deserializePaneLayout(null, fallback)).toEqual(fallback);
    expect(deserializePaneLayout("{bad json", fallback)).toEqual(fallback);
    expect(
      deserializePaneLayout(
        JSON.stringify({
          rightWidthPx: "bad",
          bottomHeightPx: 260,
          bottomCollapsed: "nope",
        }),
        fallback,
      ),
    ).toEqual({
      rightWidthPx: 340,
      bottomHeightPx: 260,
      bottomCollapsed: false,
    });
  });

  test("createPaneLayoutController updates CSS vars, data attributes, ARIA, and supports keyboard & collapse", () => {
    const rootEl = makeMockPaneElement({ width: 1000, height: 600 });
    const workspaceEl = makeMockPaneElement({ width: 1000, height: 600 });
    const rightSplitterEl = makeMockPaneElement({ width: 6, height: 600 });
    const bottomSplitterEl = makeMockPaneElement({ width: 1000, height: 6 });

    const changes: PaneLayoutState[] = [];
    const controller = createPaneLayoutController({
      rootEl,
      workspaceEl,
      rightSplitterEl,
      bottomSplitterEl,
      storageKey: "test-pane-layout",
      defaultState: {
        rightWidthPx: 340,
        bottomHeightPx: 220,
        bottomCollapsed: false,
      },
      onChange: (next) => changes.push(next),
    });

    expect(rootEl.style.getPropertyValue("--right-pane-size")).toBe("340px");
    expect(rootEl.style.getPropertyValue("--bottom-pane-size")).toBe("220px");
    expect(rootEl.dataset.bottomCollapsed).toBe("false");
    expect(rightSplitterEl.getAttribute("aria-valuenow")).toBe("340");
    expect(bottomSplitterEl.getAttribute("aria-valuenow")).toBe("220");

    // ArrowLeft on right splitter expands right pane by 16px
    rightSplitterEl.dispatch("keydown", {
      key: "ArrowLeft",
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
    });
    expect(controller.getState().rightWidthPx).toBe(356);
    expect(rootEl.style.getPropertyValue("--right-pane-size")).toBe("356px");

    // Enter on right splitter resets to default width
    rightSplitterEl.dispatch("keydown", {
      key: "Enter",
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
    });
    expect(controller.getState().rightWidthPx).toBe(340);

    // Space on bottom splitter toggles collapse
    bottomSplitterEl.dispatch("keydown", {
      key: " ",
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
    });
    expect(controller.getState().bottomCollapsed).toBe(true);
    expect(rootEl.dataset.bottomCollapsed).toBe("true");
    expect(rootEl.style.getPropertyValue("--bottom-pane-size")).toBe("0px");
    expect(bottomSplitterEl.getAttribute("aria-valuenow")).toBe("0");

    // Double-click bottom splitter restores expanded height
    bottomSplitterEl.dispatch("dblclick", {});
    expect(controller.getState().bottomCollapsed).toBe(false);
    expect(rootEl.style.getPropertyValue("--bottom-pane-size")).toBe("220px");
    expect(changes.length).toBeGreaterThanOrEqual(3);

    // Narrow workspace refresh preserves preferred rightWidthPx in state while clamping CSS var
    const workspaceRect = { width: 1000, height: 600 };
    const dynamicWorkspace = makeMockPaneElement(workspaceRect);
    const dynamicRoot = makeMockPaneElement({ width: 1000, height: 600 });
    const dynamicRight = makeMockPaneElement({ width: 6, height: 600 });
    const dynamicController = createPaneLayoutController({
      rootEl: dynamicRoot,
      workspaceEl: dynamicWorkspace,
      rightSplitterEl: dynamicRight,
      storageKey: "test-pane-layout-dynamic",
      defaultState: {
        rightWidthPx: 340,
        bottomHeightPx: 220,
        bottomCollapsed: false,
      },
    });
    dynamicController.setState({ rightWidthPx: 480 });
    expect(dynamicController.getState().rightWidthPx).toBe(480);
    workspaceRect.width = 520;
    dynamicController.refresh();
    expect(dynamicRoot.style.getPropertyValue("--right-pane-size")).toBe(
      "240px",
    );
    expect(dynamicController.getState().rightWidthPx).toBe(480);

    workspaceRect.width = 1000;
    dynamicController.refresh();
    expect(dynamicRoot.style.getPropertyValue("--right-pane-size")).toBe(
      "480px",
    );

    // lostpointercapture clears active resizing state
    dynamicRight.dispatch("pointerdown", {
      button: 0,
      pointerId: 7,
      clientX: 520,
      clientY: 100,
    });
    expect(dynamicRoot.dataset.resizing).toBe("right");
    dynamicRight.dispatch("lostpointercapture", { pointerId: 7 });
    expect(dynamicRoot.dataset.resizing).toBeUndefined();

    dynamicController.dispose();
    controller.dispose();
  });
});

describe("GraphViewportController and findNearestDirectionalNode", () => {
  test("zoomAtPoint preserves anchor world coordinate invariance and clamps scale", () => {
    const vp = new GraphViewportController();
    expect(vp.MIN_SCALE).toBe(0.18);
    expect(vp.MAX_SCALE).toBe(2.5);
    expect(MIN_SCALE).toBe(0.18);
    expect(MAX_SCALE).toBe(2.5);

    vp.panBy(50, -30);
    const anchorX = 320;
    const anchorY = 180;
    const worldBeforeX = (anchorX - vp.tx) / vp.scale;
    const worldBeforeY = (anchorY - vp.ty) / vp.scale;

    vp.zoomAtPoint(anchorX, anchorY, 1.5);
    expect(vp.scale).toBeCloseTo(1.5, 6);
    expect(vp.userTransformed).toBe(true);

    const worldAfterX = (anchorX - vp.tx) / vp.scale;
    const worldAfterY = (anchorY - vp.ty) / vp.scale;
    expect(worldAfterX).toBeCloseTo(worldBeforeX, 6);
    expect(worldAfterY).toBeCloseTo(worldBeforeY, 6);

    vp.zoomAtPoint(anchorX, anchorY, 0.5);
    const worldAfterZoomOutX = (anchorX - vp.tx) / vp.scale;
    const worldAfterZoomOutY = (anchorY - vp.ty) / vp.scale;
    expect(worldAfterZoomOutX).toBeCloseTo(worldBeforeX, 6);
    expect(worldAfterZoomOutY).toBeCloseTo(worldBeforeY, 6);

    // Clamps to MIN_SCALE / MAX_SCALE
    vp.zoomAtCenter({ width: 800, height: 600 }, 100);
    expect(vp.scale).toBe(MAX_SCALE);
    vp.zoomAtCenter({ width: 800, height: 600 }, 0.001);
    expect(vp.scale).toBe(MIN_SCALE);

    vp.resetZoom();
    expect(vp.getTransform()).toEqual({
      scale: 1,
      tx: 0,
      ty: 0,
      userTransformed: false,
    });
  });

  test("fitToRect and centerOnRect compute expected transforms", () => {
    const vp = new GraphViewportController();

    // Graph 400x200 inside 1000x600 viewport -> centered, scale capped by maxScale
    const fitted = vp.fitToRect(
      { x: 0, y: 0, width: 400, height: 200 },
      { width: 1000, height: 600 },
      { padding: 16, minScale: 0.56, maxScale: 1.08 },
    );
    expect(fitted).toBe(true);
    expect(vp.scale).toBeCloseTo(1.08, 6);
    expect(vp.tx).toBe(Math.round((1000 - 400 * 1.08) / 2));
    expect(vp.ty).toBe(Math.round((600 - 200 * 1.08) / 2));
    expect(vp.userTransformed).toBe(false);

    // Tiny viewport returns false
    expect(
      vp.fitToRect({ width: 400, height: 200 }, { width: 10, height: 10 }),
    ).toBe(false);

    // centerOnRect puts rect center at viewport center
    const centered = vp.centerOnRect(
      { x: 200, y: 100, width: 100, height: 50 },
      { width: 800, height: 600 },
      { scale: 1.5 },
    );
    expect(centered).toBe(true);
    expect(vp.scale).toBe(1.5);
    // Rect center is (250, 125) -> tx = 400 - 250*1.5 = 25, ty = 300 - 125*1.5 = 112.5 -> 113
    expect(vp.tx).toBe(25);
    expect(vp.ty).toBe(Math.round(300 - 125 * 1.5));
    expect(vp.userTransformed).toBe(true);
  });

  test("findNearestDirectionalNode selects closest aligned node in all 4 directions", () => {
    const nodes: DirectionalNode[] = [
      { id: 1, x: 0, y: 100, width: 100, height: 60 },
      { id: 2, x: 0, y: 220, width: 100, height: 60 },
      { id: 3, x: 240, y: 100, width: 100, height: 60 },
      { id: 4, x: 240, y: 220, width: 100, height: 60 },
      { id: 5, x: 480, y: 100, width: 100, height: 60 },
    ];

    expect(findNearestDirectionalNode(nodes, 1, "right")).toBe(3);
    expect(findNearestDirectionalNode(nodes, 3, "right")).toBe(5);
    expect(findNearestDirectionalNode(nodes, 5, "right")).toBeNull();
    expect(findNearestDirectionalNode(nodes, 3, "left")).toBe(1);
    expect(findNearestDirectionalNode(nodes, 1, "left")).toBeNull();
    expect(findNearestDirectionalNode(nodes, 1, "down")).toBe(2);
    expect(findNearestDirectionalNode(nodes, 2, "up")).toBe(1);
    expect(findNearestDirectionalNode(nodes, 1, "up")).toBeNull();
    expect(findNearestDirectionalNode([], 1, "right")).toBeNull();
  });
});

describe("source-jump openSourceLocation", () => {
  test("devtools mode prefers inspect(...) and falls back to getResources + sourcemap + 0-based openResource", async () => {
    // 1. Inspect succeeds -> does not fall back to openResource
    let openCalled = false;
    const inspectResult = await openSourceLocation({
      mode: "devtools",
      site: { file: "http://localhost/app.js", line: 10, column: 5 },
      evalInspectTargetExpr: "globalThis.fn",
      evalInPage: async (expr) => expr.includes("inspect(target)"),
      openResource: () => {
        openCalled = true;
      },
    });
    expect(inspectResult).toEqual({ ok: true });
    expect(openCalled).toBe(false);

    // 2. Inspect returns false -> resolves sourcemap and calls 0-based openResource
    const opened: Array<{ url: string; line0: number; col0: number }> = [];
    const fallbackResult = await openSourceLocation({
      mode: "devtools",
      site: {
        file: "http://localhost:5173/dist/bundle.js?v=1",
        line: 1,
        column: 6,
      },
      evalInspectTargetExpr: async () => false,
      getResources: async () => [
        { url: "http://localhost:5173/src/my-element.ts?t=999" },
      ],
      fetchText: async (url) => {
        if (url.endsWith("bundle.js.map")) {
          return JSON.stringify({
            version: 3,
            sources: ["../src/my-element.ts"],
            mappings: "AAAA,KACEA",
          });
        }
        if (url.includes("bundle.js")) {
          return "code();\n//# sourceMappingURL=bundle.js.map\n";
        }
        return null;
      },
      openResource: (url, line0, col0) => {
        opened.push({ url, line0, col0 });
      },
    });

    expect(fallbackResult).toEqual({ ok: true });
    expect(opened).toEqual([
      {
        url: "http://localhost:5173/src/my-element.ts?t=999",
        line0: 1, // 1-based line 2 -> 0-based 1
        col0: 2, // 1-based col 3 -> 0-based 2
      },
    ]);

    expect(
      findMatchingResource(
        [{ url: "https://example.com/assets/main.ts?t=123" }],
        "https://example.com/assets/main.ts?t=456",
      )?.url,
    ).toBe("https://example.com/assets/main.ts?t=123");
  });

  test("bridge mode copies file:line:column to clipboard", async () => {
    let copied = "";
    const result = await openSourceLocation({
      mode: "bridge",
      site: { file: "src/demo/main.ts", line: 42, column: 7 },
      copyText: (text) => {
        copied = text;
      },
    });
    expect(result).toEqual({ ok: true });
    expect(copied).toBe("src/demo/main.ts:42:7");
  });

  test("devtools wrapper skips [native code] target functions and falls through to openResource", async () => {
    const opened: string[] = [];
    let evaluatedExpr = "";
    const res = await openSourceLocation({
      mode: "devtools",
      site: { file: "http://localhost/app.js", line: 3, column: 4 },
      evalInspectTargetExpr: "(() => Math.max.bind(null))()",
      evalInPage: async (expr) => {
        evaluatedExpr = expr;
        // Simulate real browser behavior where [native code] check returns false
        return !expr.includes("[native code]");
      },
      getResources: async () => [{ url: "http://localhost/app.js" }],
      openResource: (url) => {
        opened.push(url);
      },
    });
    expect(evaluatedExpr).toContain("[native code]");
    expect(res).toEqual({ ok: true });
    expect(opened).toEqual(["http://localhost/app.js"]);
  });
});

describe("theme and shortcuts shared utilities", () => {
  const savedGlobals = new Map<string, PropertyDescriptor | undefined>();

  class MockElement extends EventTarget {
    isContentEditable = false;
  }
  class MockHTMLElement extends MockElement {}
  class MockHTMLInputElement extends MockHTMLElement {}
  class MockHTMLTextAreaElement extends MockHTMLElement {}
  class MockHTMLSelectElement extends MockHTMLElement {}

  class MockKeyboardEvent extends Event {
    readonly key: string;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly #mockTarget: EventTarget | null;

    constructor(
      type: string,
      init: {
        key: string;
        metaKey?: boolean;
        ctrlKey?: boolean;
        altKey?: boolean;
        target?: EventTarget | null;
      },
    ) {
      super(type, { cancelable: true });
      this.key = init.key;
      this.metaKey = init.metaKey ?? false;
      this.ctrlKey = init.ctrlKey ?? false;
      this.altKey = init.altKey ?? false;
      this.#mockTarget = init.target ?? null;
    }

    override get target(): EventTarget | null {
      return this.#mockTarget ?? super.target;
    }
  }

  let storageMap: Map<string, string>;
  let mediaMatches: boolean;
  let mediaListeners: Set<() => void>;
  let docDataset: Record<string, string | undefined>;
  let activeElement: unknown;

  const setGlobal = (key: string, value: unknown): void => {
    if (!savedGlobals.has(key)) {
      savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    Reflect.set(globalThis, key, value);
  };

  beforeEach(() => {
    storageMap = new Map<string, string>();
    mediaMatches = false;
    mediaListeners = new Set<() => void>();
    docDataset = {};
    activeElement = null;

    setGlobal("Element", MockElement);
    setGlobal("HTMLElement", MockHTMLElement);
    setGlobal("HTMLInputElement", MockHTMLInputElement);
    setGlobal("HTMLTextAreaElement", MockHTMLTextAreaElement);
    setGlobal("HTMLSelectElement", MockHTMLSelectElement);
    setGlobal("KeyboardEvent", MockKeyboardEvent);
    setGlobal("document", {
      get activeElement() {
        return activeElement;
      },
      documentElement: {
        dataset: docDataset,
      },
    });
    setGlobal("window", {
      localStorage: {
        getItem(k: string) {
          return storageMap.get(k) ?? null;
        },
        setItem(k: string, v: string) {
          storageMap.set(k, v);
        },
      },
      matchMedia() {
        return {
          get matches() {
            return mediaMatches;
          },
          addEventListener(_type: string, fn: () => void) {
            mediaListeners.add(fn);
          },
          removeEventListener(_type: string, fn: () => void) {
            mediaListeners.delete(fn);
          },
        };
      },
    });
  });

  afterEach(() => {
    for (const [key, desc] of savedGlobals.entries()) {
      if (desc === undefined) {
        Reflect.deleteProperty(globalThis, key);
      } else {
        Object.defineProperty(globalThis, key, desc);
      }
    }
    savedGlobals.clear();
  });

  test("isEditableElement identifies inputs, textareas, selects, and contentEditable", () => {
    expect(isEditableElement(null)).toBe(false);
    expect(isEditableElement(new MockElement())).toBe(false);
    expect(isEditableElement(new MockHTMLInputElement())).toBe(true);
    expect(isEditableElement(new MockHTMLTextAreaElement())).toBe(true);
    expect(isEditableElement(new MockHTMLSelectElement())).toBe(true);

    const editableDiv = new MockHTMLElement();
    editableDiv.isContentEditable = true;
    expect(isEditableElement(editableDiv)).toBe(true);
  });

  test("registerPanelShortcuts dispatches actions, ignores editable targets/modifiers, and unsubscribes", () => {
    const fakeTarget = new EventTarget();

    const calls: string[] = [];
    const dispose = registerPanelShortcuts(fakeTarget, {
      onSearch: () => calls.push("search"),
      onEscape: () => {
        calls.push("escape");
        return true;
      },
      onFit: () => calls.push("fit"),
      onZoomIn: () => calls.push("zoomIn"),
      onZoomOut: () => calls.push("zoomOut"),
    });

    const fire = (init: {
      key: string;
      ctrlKey?: boolean;
      target?: EventTarget | null;
    }) => {
      const evt = new MockKeyboardEvent("keydown", init);
      fakeTarget.dispatchEvent(evt);
      return evt;
    };

    expect(fire({ key: "/" }).defaultPrevented).toBe(true);
    expect(fire({ key: "Escape" }).defaultPrevented).toBe(true);
    expect(fire({ key: "0" }).defaultPrevented).toBe(true);
    expect(fire({ key: "+" }).defaultPrevented).toBe(true);
    expect(fire({ key: "=" }).defaultPrevented).toBe(true);
    expect(fire({ key: "-" }).defaultPrevented).toBe(true);
    expect(calls).toEqual([
      "search",
      "escape",
      "fit",
      "zoomIn",
      "zoomIn",
      "zoomOut",
    ]);

    // Modifier keys are ignored
    expect(fire({ key: "/", ctrlKey: true }).defaultPrevented).toBe(false);
    // Editable target or activeElement is ignored
    expect(
      fire({
        key: "/",
        target: new MockHTMLInputElement(),
      }).defaultPrevented,
    ).toBe(false);
    activeElement = new MockHTMLTextAreaElement();
    expect(fire({ key: "0" }).defaultPrevented).toBe(false);
    activeElement = null;

    dispose();
    expect(fire({ key: "/" }).defaultPrevented).toBe(false);
  });

  test("createThemeController resolves auto/dark/light, persists preference, and cycles cleanly", () => {
    mediaMatches = true;
    let devtoolsTheme: "dark" | "light" | null = "light";
    const changes: Array<readonly [string, string]> = [];

    const controller = createThemeController({
      storageKey: "test-theme-pref",
      getDevToolsTheme: () => devtoolsTheme,
      onChange: (pref, resolved) => changes.push([pref, resolved]),
    });

    expect(controller.getPreference()).toBe("auto");
    expect(controller.getResolvedTheme()).toBe("light");
    expect(docDataset.theme).toBe("light");

    // Without DevTools theme, falls back to matchMedia (dark)
    devtoolsTheme = null;
    controller.apply();
    expect(controller.getResolvedTheme()).toBe("dark");
    expect(docDataset.theme).toBeUndefined();

    // Cycle: auto -> dark -> light -> auto
    expect(controller.cycle()).toBe("dark");
    expect(storageMap.get("test-theme-pref")).toBe("dark");
    expect(docDataset.theme).toBe("dark");

    expect(controller.cycle()).toBe("light");
    expect(controller.getResolvedTheme()).toBe("light");
    expect(docDataset.theme).toBe("light");

    expect(controller.cycle()).toBe("auto");
    expect(storageMap.get("test-theme-pref")).toBe("auto");

    controller.dispose();
    expect(mediaListeners.size).toBe(0);
    expect(changes.length).toBeGreaterThanOrEqual(4);
  });
});
