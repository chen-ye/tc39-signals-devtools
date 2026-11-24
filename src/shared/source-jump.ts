import {
  createSourceMapResolver,
  type SourceMapResolver,
} from "./sourcemap.ts";

export interface SourceSite {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly fn?: string | null | undefined;
}

export type SourceJumpResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface InspectedResourceLike {
  readonly url: string;
  getContent?(callback: (content: string, encoding: string) => void): void;
}

export interface OpenSourceLocationOptions {
  readonly mode: "devtools" | "bridge";
  readonly site: SourceSite | null;
  readonly evalInspectTargetExpr?:
    string | (() => Promise<boolean>) | undefined;
  readonly evalInPage?: ((expression: string) => Promise<boolean>) | undefined;
  readonly getResources?:
    (() => Promise<ReadonlyArray<InspectedResourceLike>>) | undefined;
  readonly openResource?:
    | ((url: string, line0: number, column0: number) => Promise<void> | void)
    | undefined;
  readonly fetchText?: ((url: string) => Promise<string | null>) | undefined;
  readonly copyText?: ((text: string) => Promise<void> | void) | undefined;
  readonly openTab?: ((url: string) => Promise<void> | void) | undefined;
  readonly viteOpenInEditor?: boolean | undefined;
  readonly sourceMapResolver?: SourceMapResolver | undefined;
}

const sharedSourceMapResolver = createSourceMapResolver({ maxEntries: 50 });

function stripQueryAndHash(rawUrl: string): string {
  const hashIdx = rawUrl.indexOf("#");
  const withoutHash = hashIdx === -1 ? rawUrl : rawUrl.slice(0, hashIdx);
  const queryIdx = withoutHash.indexOf("?");
  return queryIdx === -1 ? withoutHash : withoutHash.slice(0, queryIdx);
}

function getOriginAndPathname(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.origin && parsed.origin !== "null") {
      return `${parsed.origin}${parsed.pathname}`;
    }
    return parsed.pathname;
  } catch {
    return null;
  }
}

function getPathname(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return stripQueryAndHash(rawUrl);
  }
}

export function findMatchingResource(
  resources: ReadonlyArray<InspectedResourceLike>,
  targetFile: string,
): InspectedResourceLike | null {
  if (!targetFile || resources.length === 0) return null;

  // 1. Exact URL match
  for (const res of resources) {
    if (res.url === targetFile) return res;
  }

  // 2. Stripped query/hash match
  const cleanTarget = stripQueryAndHash(targetFile);
  for (const res of resources) {
    if (stripQueryAndHash(res.url) === cleanTarget) return res;
  }

  // 3. Origin + pathname match
  const targetOriginPath = getOriginAndPathname(targetFile);
  if (targetOriginPath) {
    for (const res of resources) {
      if (getOriginAndPathname(res.url) === targetOriginPath) return res;
    }
  }

  // 4. Pathname suffix fallback
  const normalizedSuffix = cleanTarget.replace(/^\.?\//, "");
  if (normalizedSuffix.length > 0) {
    for (const res of resources) {
      const resPath = getPathname(res.url).replace(/^\//, "");
      if (
        resPath === normalizedSuffix ||
        resPath.endsWith(`/${normalizedSuffix}`)
      ) {
        return res;
      }
    }
  }

  return null;
}

function defaultEvalInPage(expression: string): Promise<boolean> {
  if (
    typeof chrome === "undefined" ||
    !chrome.devtools?.inspectedWindow?.eval
  ) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    chrome.devtools.inspectedWindow.eval<boolean>(
      expression,
      (result, exceptionInfo) => {
        if (exceptionInfo?.isException || exceptionInfo?.isError) {
          resolve(false);
          return;
        }
        resolve(result);
      },
    );
  });
}

function defaultGetResources(): Promise<ReadonlyArray<InspectedResourceLike>> {
  if (
    typeof chrome === "undefined" ||
    !chrome.devtools?.inspectedWindow?.getResources
  ) {
    return Promise.resolve([]);
  }
  return new Promise<ReadonlyArray<InspectedResourceLike>>((resolve) => {
    chrome.devtools.inspectedWindow.getResources((resources) => {
      resolve(resources ?? []);
    });
  });
}

function defaultOpenResource(
  url: string,
  line0: number,
  column0: number,
): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.devtools?.panels?.openResource) {
    return Promise.reject(
      new Error("chrome.devtools.panels.openResource is unavailable"),
    );
  }
  return new Promise<void>((resolve) => {
    chrome.devtools.panels.openResource(url, line0, column0, () => {
      resolve();
    });
  });
}

function readResourceContent(
  resource: InspectedResourceLike,
): Promise<string | null> {
  if (!resource.getContent) return Promise.resolve(null);
  return new Promise<string | null>((resolve) => {
    try {
      resource.getContent?.((content) => {
        resolve(typeof content === "string" ? content : null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function defaultFetchText(
  url: string,
  resources: ReadonlyArray<InspectedResourceLike>,
): Promise<string | null> {
  const matched = findMatchingResource(resources, url);
  if (matched?.getContent) {
    const content = await readResourceContent(matched);
    if (content !== null) return content;
  }
  if (typeof fetch !== "function") return null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

function formatLocationText(site: SourceSite): string {
  return `${site.file}:${site.line}:${site.column}`;
}

function isHttpUrl(raw: string): boolean {
  return raw.startsWith("http://") || raw.startsWith("https://");
}

function toViteEditorFileParam(site: SourceSite): string {
  let filePath = site.file;
  if (isHttpUrl(filePath)) {
    try {
      const parsed = new URL(filePath);
      filePath = parsed.pathname.replace(/^\/+/, "");
    } catch {
      // Keep original string if URL parsing fails
    }
  }
  return `${filePath}:${Math.max(1, site.line)}:${Math.max(1, site.column)}`;
}

async function tryViteOpenInEditor(site: SourceSite): Promise<boolean> {
  if (typeof fetch !== "function") return false;
  try {
    const fileParam = encodeURIComponent(toViteEditorFileParam(site));
    const res = await fetch(`/__open-in-editor?file=${fileParam}`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function openSourceLocation(
  options: OpenSourceLocationOptions,
): Promise<SourceJumpResult> {
  const { mode, site } = options;

  if (mode === "devtools") {
    // 1. Prefer live V8 [[FunctionLocation]] inspect(...) when a target expression is supplied
    if (options.evalInspectTargetExpr !== undefined) {
      try {
        let inspected = false;
        if (typeof options.evalInspectTargetExpr === "function") {
          inspected = await options.evalInspectTargetExpr();
        } else if (options.evalInspectTargetExpr.trim().length > 0) {
          const expr = `(() => { const target = (${options.evalInspectTargetExpr}); if (target == null) return false; if (typeof target === "function" && Function.prototype.toString.call(target).includes("[native code]")) return false; inspect(target); return true; })()`;
          const evalFn = options.evalInPage ?? defaultEvalInPage;
          inspected = await evalFn(expr);
        }
        if (inspected) {
          return { ok: true };
        }
      } catch {
        // Fall through to resource + sourcemap fallback
      }
    }

    if (!site || !site.file) {
      return { ok: false, error: "No source location available" };
    }

    // 2. Fallback: match inspected resources, optionally resolving through source maps
    const getResourcesFn = options.getResources ?? defaultGetResources;
    const resources = await getResourcesFn();
    const fetchTextFn =
      options.fetchText ?? ((url: string) => defaultFetchText(url, resources));
    const resolver = options.sourceMapResolver ?? sharedSourceMapResolver;

    let targetFile = site.file;
    let targetLine = site.line;
    let targetCol = site.column;

    const resolved = await resolver.resolve(
      site.file,
      site.line,
      site.column,
      fetchTextFn,
    );

    let matched: InspectedResourceLike | null = null;
    if (resolved) {
      const mappedResource = findMatchingResource(resources, resolved.source);
      if (mappedResource) {
        matched = mappedResource;
        targetFile = resolved.source;
        targetLine = resolved.line;
        targetCol = resolved.column;
      }
    }

    if (!matched) {
      matched = findMatchingResource(resources, targetFile);
    }

    if (!matched) {
      return {
        ok: false,
        error: `Resource not found in inspected page: ${site.file}`,
      };
    }

    const openResourceFn = options.openResource ?? defaultOpenResource;
    try {
      await openResourceFn(
        matched.url,
        Math.max(0, Math.floor(targetLine) - 1),
        Math.max(0, Math.floor(targetCol) - 1),
      );
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : "Failed to open resource in DevTools",
      };
    }
  }

  // Bridge mode (standalone/demo)
  if (!site || !site.file) {
    return { ok: false, error: "No source location available" };
  }

  if (options.viteOpenInEditor) {
    const openedInEditor = await tryViteOpenInEditor(site);
    if (openedInEditor) {
      return { ok: true };
    }
  }

  const locationText = formatLocationText(site);
  const copyFn =
    options.copyText ??
    (typeof navigator !== "undefined" && navigator.clipboard?.writeText
      ? (text: string) => navigator.clipboard.writeText(text)
      : undefined);

  if (copyFn) {
    try {
      await copyFn(locationText);
      return { ok: true };
    } catch {
      // Fall through to openTab if available
    }
  }

  if (options.openTab && isHttpUrl(site.file)) {
    try {
      await options.openTab(site.file);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to open source tab",
      };
    }
  }

  return {
    ok: false,
    error: "Clipboard copy unavailable for source location",
  };
}
