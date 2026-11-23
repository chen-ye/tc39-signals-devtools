import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { build, createServer } from "vite";
import { signalsDevtoolsPlugin } from "../../src/client/vite.ts";
import { createSignalsHook, GLOBAL_HOOK_KEY } from "../../src/hook/hook.ts";

describe("signalsDevtoolsPlugin (real Vite build & dev server)", () => {
  test("redirects signal-polyfill import through __SIGNALS_DEVTOOLS_HOOK__ in Vite build", async () => {
    const dir = mkdtempSync(join(tmpdir(), "signals-vite-test-"));
    try {
      symlinkSync(
        resolve(process.cwd(), "node_modules"),
        join(dir, "node_modules"),
      );
      const entryPath = join(dir, "entry.js");
      writeFileSync(
        entryPath,
        [
          `import { Signal } from "signal-polyfill";`,
          `export function runTest() {`,
          `  const s = new Signal.State(3);`,
          `  const c = new Signal.Computed(() => s.get() * 4);`,
          `  return { s, c, val: c.get() };`,
          `}`,
        ].join("\n"),
      );

      const output = await build({
        root: dir,
        logLevel: "silent",
        plugins: [
          signalsDevtoolsPlugin({ apply: "all", runtimeName: "vite-demo" }),
        ],
        build: {
          write: false,
          minify: false,
          lib: {
            entry: entryPath,
            formats: ["es"],
            fileName: "bundle",
          },
        },
      });

      const chunks = Array.isArray(output) ? output : [output];
      const firstOutput = chunks[0];
      expect(firstOutput && "output" in firstOutput).toBe(true);
      if (!firstOutput || !("output" in firstOutput)) {
        throw new Error("Unexpected Vite build output shape");
      }

      const code =
        firstOutput.output[0]?.type === "chunk"
          ? firstOutput.output[0].code
          : "";
      expect(code).toContain(GLOBAL_HOOK_KEY);
      expect(code).toContain(`"vite-demo"`);

      const hook = createSignalsHook();
      const host = globalThis as Record<string, unknown>;
      const prev = host[GLOBAL_HOOK_KEY];
      host[GLOBAL_HOOK_KEY] = hook;
      try {
        const modUrl = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
        const mod: unknown = await import(modUrl);
        const runTest: unknown =
          mod !== null && typeof mod === "object"
            ? Reflect.get(mod, "runTest")
            : null;
        expect(typeof runTest).toBe("function");
        if (typeof runTest !== "function") {
          throw new Error("Expected runTest export");
        }
        const result: unknown = runTest();
        const val: unknown =
          result !== null && typeof result === "object"
            ? Reflect.get(result, "val")
            : undefined;
        expect(val).toBe(12);

        const snap = hook.snapshot();
        expect(snap.runtimes).toEqual([
          { name: "vite-demo", mode: "instrumented" },
        ]);
        expect(snap.nodes.length).toBe(2);
        expect(snap.edges.length).toBe(1);
      } finally {
        if (prev === undefined) {
          delete host[GLOBAL_HOOK_KEY];
        } else {
          host[GLOBAL_HOOK_KEY] = prev;
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("excludes signal-polyfill from optimizeDeps and transforms imports in Vite dev server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "signals-vite-dev-"));
    symlinkSync(
      resolve(process.cwd(), "node_modules"),
      join(dir, "node_modules"),
    );
    writeFileSync(
      join(dir, "app.js"),
      `import { Signal } from "signal-polyfill";\nexport const s = new Signal.State(1);\n`,
    );

    const server = await createServer({
      root: dir,
      logLevel: "silent",
      server: { middlewareMode: true },
      plugins: [signalsDevtoolsPlugin()],
    });

    try {
      expect(server.config.optimizeDeps.exclude).toContain("signal-polyfill");
      const transformed = await server.transformRequest("/app.js");
      expect(transformed?.code).toContain(
        "/@id/__x00__tc39-signals-devtools:signal-polyfill",
      );
      const virtualLoaded = await server.transformRequest(
        "\0tc39-signals-devtools:signal-polyfill",
      );
      expect(virtualLoaded?.code).toContain(GLOBAL_HOOK_KEY);
      expect(virtualLoaded?.code).toContain("node_modules/signal-polyfill");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
