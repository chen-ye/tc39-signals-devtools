import type { Plugin } from "vite";

const VIRTUAL_ID = "\0tc39-signals-devtools:signal-polyfill";
const RAW_QUERY = "?tc39-signals-devtools-raw";

export interface SignalsDevtoolsPluginOptions {
  readonly runtimeName?: string;
  readonly apply?: "serve" | "build" | "all";
}

export function signalsDevtoolsPlugin(
  options: SignalsDevtoolsPluginOptions = {},
): Plugin {
  const runtimeName = options.runtimeName ?? "vite";
  const applyMode = options.apply ?? "serve";
  const resolvedRawBySsr = new Map<boolean, string>();

  return {
    name: "tc39-signals-devtools",
    enforce: "pre",
    ...(applyMode === "all" ? {} : { apply: applyMode }),

    config() {
      return {
        optimizeDeps: {
          exclude: ["signal-polyfill"],
        },
      };
    },

    async resolveId(source, importer, resolveOptions) {
      if (source === VIRTUAL_ID) {
        return VIRTUAL_ID;
      }

      if (source.endsWith(RAW_QUERY)) {
        const bare = source.slice(0, -RAW_QUERY.length);
        const rawImporter = importer === VIRTUAL_ID ? undefined : importer;
        return this.resolve(bare, rawImporter, {
          ...resolveOptions,
          skipSelf: true,
        });
      }

      if (source === "signal-polyfill" && importer !== VIRTUAL_ID) {
        const isSsr = Boolean(resolveOptions?.ssr);
        if (!resolvedRawBySsr.has(isSsr)) {
          const resolved = await this.resolve(source, importer, {
            ...resolveOptions,
            skipSelf: true,
          });
          if (!resolved) return null;
          resolvedRawBySsr.set(isSsr, resolved.id);
        }
        return VIRTUAL_ID;
      }

      return null;
    },

    load(id, loadOptions) {
      if (id !== VIRTUAL_ID) return null;
      const isSsr = Boolean(loadOptions?.ssr);
      const target =
        resolvedRawBySsr.get(isSsr) ?? `signal-polyfill${RAW_QUERY}`;
      return [
        `import { Signal as RawSignal } from ${JSON.stringify(target)};`,
        `const hook = globalThis.__SIGNALS_DEVTOOLS_HOOK__;`,
        `export const Signal = hook && hook.version === 1 ? hook.wrap(RawSignal, ${JSON.stringify(runtimeName)}) : RawSignal;`,
      ].join("\n");
    },
  };
}
