import type { SourceLocation } from "../protocol/types.ts";
import {
  captureCallsite as captureSharedCallsite,
  compileIgnoreMatchers as compileSharedIgnoreMatchers,
  parseStackLocation as parseSharedStackLocation,
  stripTopStackFrames,
} from "../shared/stack.ts";

const DEFAULT_IGNORED_PATTERNS: ReadonlyArray<RegExp> = [
  /\/node_modules\//,
  /^chrome-extension:\/\//,
  /tc39-signals-devtools\/src\/(hook|client|shared)\//,
];

const INTERNAL_CALLER_PATH_RE = /@lit-labs[\\/_]signals/i;

const SIGNALS_INTERNAL_FN = (fn: string): boolean =>
  fn.includes("__SIGNALS_DEVTOOLS__") ||
  fn.startsWith("new Instrumented") ||
  fn.includes("Instrumented") ||
  fn.includes("buildInstrumentedNamespace") ||
  fn.includes("wrappedComputation") ||
  fn.includes("wrappedNotify") ||
  fn.includes("captureCallsite") ||
  fn.includes("SignalsHookEngine") ||
  fn === "signalSetFn";

export interface CallsiteCaptureInfo {
  readonly site: SourceLocation | null;
  readonly fromInternalPackage: boolean;
}

export function compileIgnoreMatchers(
  extraPatterns: ReadonlyArray<string>,
): ReadonlyArray<RegExp> {
  return [
    ...DEFAULT_IGNORED_PATTERNS,
    ...compileSharedIgnoreMatchers(extraPatterns),
  ];
}

export function parseStackLocation(
  stack: string | undefined,
  ignoredMatchers: ReadonlyArray<RegExp> = DEFAULT_IGNORED_PATTERNS,
  skipFrames = 0,
): SourceLocation | null {
  return parseSharedStackLocation(stack, {
    ignoredMatchers,
    internalFnTest: SIGNALS_INTERNAL_FN,
    skipFrames,
    normalizeInitializerFrames: true,
  });
}

export function parseCallsiteInfo(
  stack: string | undefined,
  ignoredMatchers: ReadonlyArray<RegExp> = DEFAULT_IGNORED_PATTERNS,
  skipFrames = 0,
): CallsiteCaptureInfo {
  let fromInternalPackage = false;
  const site = parseSharedStackLocation(stack, {
    ignoredMatchers,
    internalFnTest: SIGNALS_INTERNAL_FN,
    skipFrames,
    normalizeInitializerFrames: true,
    onIgnoredFrame({ file }) {
      if (INTERNAL_CALLER_PATH_RE.test(file)) {
        fromInternalPackage = true;
      }
    },
  });
  if (site && INTERNAL_CALLER_PATH_RE.test(site.file)) {
    fromInternalPackage = true;
  }
  return { site, fromInternalPackage };
}

export function parseDirectCallerStack(
  stack: string | undefined,
  ignoredMatchers: ReadonlyArray<RegExp> = DEFAULT_IGNORED_PATTERNS,
): SourceLocation | null {
  return parseSharedStackLocation(stripTopStackFrames(stack, 1), {
    ignoredMatchers,
    internalFnTest: SIGNALS_INTERNAL_FN,
    skipFrames: 0,
    normalizeInitializerFrames: true,
  });
}

export function captureCallsite(
  ignoredMatchers: ReadonlyArray<RegExp> = DEFAULT_IGNORED_PATTERNS,
  skipFrames = 0,
): SourceLocation | null {
  return captureSharedCallsite({
    ignoredMatchers,
    internalFnTest: SIGNALS_INTERNAL_FN,
    skipFrames,
    normalizeInitializerFrames: true,
  });
}

export function captureCallsiteInfo(
  ignoredMatchers: ReadonlyArray<RegExp> = DEFAULT_IGNORED_PATTERNS,
  skipFrames = 0,
): CallsiteCaptureInfo {
  const stack = stripTopStackFrames(new Error().stack, 1);
  return parseCallsiteInfo(stack, ignoredMatchers, skipFrames);
}
