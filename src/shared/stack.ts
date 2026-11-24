import type { SourceLocation } from "../protocol/types.ts";

const V8_FRAME_WITH_FN =
  /^\s*at\s+(?:async\s+)?(.+?)\s+\((.+):(\d+):(\d+)\)\s*$/;
const V8_FRAME_BARE = /^\s*at\s+(?:async\s+)?(.+):(\d+):(\d+)\s*$/;

export interface StackParseOptions {
  readonly ignoredMatchers?: ReadonlyArray<RegExp>;
  readonly internalFnTest?: (fnName: string) => boolean;
  readonly skipFrames?: number;
  readonly normalizeInitializerFrames?: boolean;
  readonly onIgnoredFrame?: (frame: {
    readonly file: string;
    readonly fn: string | null;
  }) => void;
}

export function stripTopStackFrames(
  stack: string | undefined,
  count = 1,
): string | undefined {
  if (!stack || count <= 0) return stack;
  const lines = stack.split("\n");
  let stripped = 0;
  const remaining: string[] = [];
  for (const line of lines) {
    if (stripped < count && line.trim().startsWith("at ")) {
      stripped += 1;
      continue;
    }
    remaining.push(line);
  }
  return remaining.join("\n");
}

export function compileIgnoreMatchers(
  patterns: ReadonlyArray<string | RegExp>,
): ReadonlyArray<RegExp> {
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    if (pattern instanceof RegExp) {
      compiled.push(pattern);
    } else if (typeof pattern === "string" && pattern.length > 0) {
      try {
        compiled.push(new RegExp(pattern));
      } catch {
        // Fall back to literal substring match when pattern is not a valid regex
        compiled.push(
          new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );
      }
    }
  }
  return compiled;
}

interface ParsedStackFrame {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly fn: string | null;
}

function normalizeInitializerFn(fn: string | null): string | null {
  if (!fn) return null;
  if (
    fn === "<instance_members_initializer>" ||
    fn === "<static_initializer>"
  ) {
    return null;
  }
  if (fn.endsWith(".<instance_members_initializer>")) {
    return fn.slice(0, -".<instance_members_initializer>".length) || null;
  }
  if (fn.endsWith(".<static_initializer>")) {
    return fn.slice(0, -".<static_initializer>".length) || null;
  }
  return fn;
}

export function parseStackLocation(
  stack: string | undefined,
  options?: StackParseOptions,
): SourceLocation | null {
  if (!stack) return null;
  const lines = stack.split("\n");
  const skipFrames = options?.skipFrames ?? 0;
  const ignoredMatchers = options?.ignoredMatchers ?? [];
  const normalizeInitializers = options?.normalizeInitializerFrames ?? true;
  let skipped = 0;
  let selected: ParsedStackFrame | null = null;
  let nextFrame: ParsedStackFrame | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("at ")) continue;

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
      if (!selected) {
        options?.onIgnoredFrame?.({ file, fn });
      }
      continue;
    }

    if (fn && options?.internalFnTest?.(fn)) {
      continue;
    }

    if (skipped < skipFrames) {
      skipped++;
      continue;
    }

    const parsed: ParsedStackFrame = {
      file,
      line: Number.isFinite(lineNum) ? lineNum : 0,
      column: Number.isFinite(colNum) ? colNum : 0,
      fn,
    };

    if (!selected) {
      selected = parsed;
    } else {
      nextFrame = parsed;
      break;
    }
  }

  if (!selected) return null;

  let resolvedFn = selected.fn;
  if (normalizeInitializers && resolvedFn) {
    if (
      resolvedFn === "<instance_members_initializer>" ||
      resolvedFn === "<static_initializer>"
    ) {
      resolvedFn = nextFrame?.fn ? normalizeInitializerFn(nextFrame.fn) : null;
    } else {
      resolvedFn = normalizeInitializerFn(resolvedFn);
    }
  }

  return {
    file: selected.file,
    line: selected.line,
    column: selected.column,
    fn: resolvedFn,
  };
}

export function captureCallsite(
  options?: StackParseOptions,
): SourceLocation | null {
  const rawStack = new Error().stack;
  if (!rawStack) return null;
  const lines = rawStack.split("\n");
  let strippedOwnFrame = false;
  const remaining: string[] = [];
  for (const line of lines) {
    if (!strippedOwnFrame && line.trim().startsWith("at ")) {
      strippedOwnFrame = true;
      continue;
    }
    remaining.push(line);
  }
  return parseStackLocation(remaining.join("\n"), {
    ...options,
    skipFrames: options?.skipFrames ?? 0,
  });
}
