import type { SourceLocation } from "../protocol/types.ts";

const DEFAULT_IGNORED_PATTERNS: ReadonlyArray<RegExp> = [
  /\/node_modules\//,
  /^chrome-extension:\/\//,
  /tc39-signals-devtools\/src\/(hook|client)\//,
];

const V8_FRAME_WITH_FN =
  /^\s*at\s+(?:async\s+)?(.+?)\s+\((.+):(\d+):(\d+)\)\s*$/;
const V8_FRAME_BARE = /^\s*at\s+(?:async\s+)?(.+):(\d+):(\d+)\s*$/;

export function compileIgnoreMatchers(
  extraPatterns: ReadonlyArray<string>,
): ReadonlyArray<RegExp> {
  const matchers = [...DEFAULT_IGNORED_PATTERNS];
  for (const raw of extraPatterns) {
    try {
      matchers.push(new RegExp(raw));
    } catch {
      // Ignore invalid caller regex pattern strings without breaking capture
    }
  }
  return matchers;
}

export function parseStackLocation(
  stack: string | undefined,
  ignoredMatchers: ReadonlyArray<RegExp>,
  skipFrames = 0,
): SourceLocation | null {
  if (!stack) return null;
  const lines = stack.split("\n");
  let skipped = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("at ")) continue;
    if (skipped < skipFrames) {
      skipped++;
      continue;
    }

    let fn: string | null = null;
    let file: string;
    let lineNum: number;
    let colNum: number;

    const withFn = V8_FRAME_WITH_FN.exec(line);
    if (withFn) {
      fn = withFn[1] ?? null;
      file = withFn[2] ?? "";
      lineNum = Number(withFn[3]);
      colNum = Number(withFn[4]);
    } else {
      const bare = V8_FRAME_BARE.exec(line);
      if (!bare) continue;
      file = bare[1] ?? "";
      lineNum = Number(bare[2]);
      colNum = Number(bare[3]);
    }

    if (!file || file.startsWith("node:internal") || file === "<anonymous>") {
      continue;
    }

    if (ignoredMatchers.some((re) => re.test(file))) {
      continue;
    }

    if (
      fn &&
      (fn.includes("__SIGNALS_DEVTOOLS__") || fn.startsWith("new Instrumented"))
    ) {
      continue;
    }

    return {
      file,
      line: Number.isFinite(lineNum) ? lineNum : 0,
      column: Number.isFinite(colNum) ? colNum : 0,
      fn,
    };
  }

  return null;
}

export function captureCallsite(
  ignoredMatchers: ReadonlyArray<RegExp>,
  skipFrames = 1,
): SourceLocation | null {
  const stack = new Error().stack;
  return parseStackLocation(stack, ignoredMatchers, skipFrames);
}
