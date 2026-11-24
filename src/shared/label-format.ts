import { measureTextPx } from "./text-measure.ts";

export const DEFAULT_LABEL_FONT =
  '600 11.5px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

export interface TwoLineTitle {
  readonly line1: string;
  readonly line2: string | null;
}

export interface SemanticTitleOptions {
  readonly ownerLabel?: string | null;
  readonly disambiguator?: string | null;
}

export interface SemanticTitleParts {
  readonly title: string;
  readonly ownerLabel: string | null;
  readonly disambiguator: string | null;
  readonly raw: string;
}

const REDUNDANT_WORD_PREFIX_RE =
  /^(?:computed\s*·\s*|observer\s*·\s*|memo\s*·\s*|state\s*·\s*|watcher\s*·\s*|new\s+)/i;
const REDUNDANT_CAMEL_PREFIX_RE =
  /^(?:_?(?:compute|select|memo|observe)(?:_+|[-\s]+|(?=[A-Z]))|_compute(?=[a-z]))/;
const KEBAB_TAG_RE = /^<?[a-z][a-z0-9]*(?:-[a-z0-9]+){2,}>?$/i;
const OWNER_SUFFIX_RE = /^(.+?)\s+\(([^()]+)\)$/;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function unwrapAngleBrackets(text: string): {
  readonly inner: string;
  readonly wrapped: boolean;
} {
  if (text.startsWith("<") && text.endsWith(">") && text.length >= 2) {
    return { inner: text.slice(1, -1), wrapped: true };
  }
  return { inner: text, wrapped: false };
}

function wrapAngleBrackets(inner: string, wrapped: boolean): string {
  return wrapped ? `<${inner}>` : inner;
}

function findMaxFittingPrefixLen(
  text: string,
  maxPx: number,
  fontSpec: string,
  suffix: string,
): number {
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = `${text.slice(0, mid)}${suffix}`;
    if (measureTextPx(candidate, fontSpec) <= maxPx) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

function snapToCleanBoundary(text: string, maxLen: number): number {
  if (maxLen <= 2 || maxLen >= text.length) return maxLen;
  const minAccepted = Math.max(2, Math.floor(maxLen * 0.7));
  for (let i = maxLen; i >= minAccepted; i--) {
    const prev = text[i - 1] ?? "";
    const next = text[i] ?? "";
    if (
      prev === " " ||
      prev === "." ||
      prev === "-" ||
      prev === "_" ||
      prev === "#" ||
      prev === "·" ||
      prev === "/" ||
      prev === ":"
    ) {
      return i;
    }
    if (/[a-z0-9]/.test(prev) && /[A-Z]/.test(next)) {
      return i;
    }
  }
  return maxLen;
}

function truncatePlainToPx(
  text: string,
  maxPx: number,
  fontSpec: string,
): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length === 0) return "";
  if (maxPx <= 0) return "";
  if (measureTextPx(normalized, fontSpec) <= maxPx) return normalized;

  const { inner, wrapped } = unwrapAngleBrackets(normalized);
  const bracketPx = wrapped ? measureTextPx("<>", fontSpec) : 0;
  const innerBudget = Math.max(0, maxPx - bracketPx);
  const ellipsis = "…";
  const ellipsisPx = measureTextPx(ellipsis, fontSpec);

  if (innerBudget <= ellipsisPx) {
    return wrapped && measureTextPx("<…>", fontSpec) <= maxPx
      ? "<…>"
      : ellipsis;
  }

  const rawPrefixLen = findMaxFittingPrefixLen(
    inner,
    innerBudget,
    fontSpec,
    ellipsis,
  );
  if (rawPrefixLen <= 0) {
    return wrapAngleBrackets(ellipsis, wrapped);
  }
  const snapped = snapToCleanBoundary(inner, rawPrefixLen);
  const prefix = inner.slice(0, snapped).trimEnd();
  return wrapAngleBrackets(`${prefix}${ellipsis}`, wrapped);
}

export function stripNamespaceKeepTail(
  tag: string,
  maxPx: number,
  fontSpec: string = DEFAULT_LABEL_FONT,
): string {
  const normalized = normalizeWhitespace(tag);
  if (normalized.length === 0) return "";
  if (measureTextPx(normalized, fontSpec) <= maxPx) return normalized;

  const { inner, wrapped } = unwrapAngleBrackets(normalized);
  const segments = inner.split("-").filter((part) => part.length > 0);
  if (segments.length < 3) {
    return truncatePlainToPx(normalized, maxPx, fontSpec);
  }

  const head = segments[0]!;
  for (let start = 2; start < segments.length; start++) {
    const tail = segments.slice(start).join("-");
    const candidate = wrapAngleBrackets(`${head}-…-${tail}`, wrapped);
    if (measureTextPx(candidate, fontSpec) <= maxPx) {
      return candidate;
    }
  }

  const lastSeg = segments[segments.length - 1]!;
  const minimalTail = wrapAngleBrackets(`…-${lastSeg}`, wrapped);
  if (measureTextPx(minimalTail, fontSpec) <= maxPx) {
    return minimalTail;
  }

  return truncatePlainToPx(normalized, maxPx, fontSpec);
}

function splitDisambiguator(
  text: string,
  disambiguator?: string | null,
): {
  readonly base: string;
  readonly suffix: string | null;
} {
  const normalized = normalizeWhitespace(text);
  const cleanDisambig = disambiguator ? normalizeWhitespace(disambiguator) : "";
  if (!cleanDisambig) {
    return { base: normalized, suffix: null };
  }

  if (normalized === cleanDisambig) {
    return { base: "", suffix: cleanDisambig };
  }
  if (normalized.endsWith(` ${cleanDisambig}`)) {
    return {
      base: normalized.slice(0, -cleanDisambig.length - 1).trimEnd(),
      suffix: cleanDisambig,
    };
  }
  if (normalized.endsWith(cleanDisambig)) {
    return {
      base: normalized.slice(0, -cleanDisambig.length).trimEnd(),
      suffix: cleanDisambig,
    };
  }
  return { base: normalized, suffix: cleanDisambig };
}

function truncateBodyToPx(
  body: string,
  maxPx: number,
  fontSpec: string,
): string {
  if (body.length === 0) return "";
  if (measureTextPx(body, fontSpec) <= maxPx) return body;
  if (KEBAB_TAG_RE.test(body)) {
    return stripNamespaceKeepTail(body, maxPx, fontSpec);
  }
  return truncatePlainToPx(body, maxPx, fontSpec);
}

export function smartTruncateToPx(
  text: string,
  maxPx: number,
  fontSpec: string = DEFAULT_LABEL_FONT,
  disambiguator?: string | null,
): string {
  const { base, suffix } = splitDisambiguator(text, disambiguator);
  if (!suffix) {
    return truncateBodyToPx(base, maxPx, fontSpec);
  }

  const full = base.length > 0 ? `${base} ${suffix}` : suffix;
  if (measureTextPx(full, fontSpec) <= maxPx) {
    return full;
  }

  if (base.length === 0) {
    return suffix;
  }

  const gapAndSuffix = ` ${suffix}`;
  const suffixReservePx = measureTextPx(gapAndSuffix, fontSpec);
  const remainingPx = maxPx - suffixReservePx;
  const minBodyPx = measureTextPx("…", fontSpec);

  if (remainingPx <= minBodyPx) {
    const compactPrefix = `… ${suffix}`;
    return measureTextPx(compactPrefix, fontSpec) <= maxPx
      ? compactPrefix
      : suffix;
  }

  const truncatedBase = truncateBodyToPx(base, remainingPx, fontSpec);
  return truncatedBase.length > 0 ? `${truncatedBase} ${suffix}` : suffix;
}

interface SplitCandidate {
  readonly line1: string;
  readonly line2: string;
  readonly priority: number;
}

function collectSplitCandidates(text: string): ReadonlyArray<SplitCandidate> {
  const candidates: SplitCandidate[] = [];
  for (let i = 1; i < text.length; i++) {
    const prev = text[i - 1]!;
    const ch = text[i]!;
    const next = text[i + 1] ?? "";

    if (ch === " " || ch === "·") {
      const line1 = text.slice(0, i).trimEnd();
      const line2 = text
        .slice(i + 1)
        .replace(/^[·\s]+/, "")
        .trimStart();
      if (line1 && line2) {
        candidates.push({ line1, line2, priority: 3 });
      }
    } else if (ch === "." || ch === "#") {
      const line1 = text.slice(0, i).trimEnd();
      const line2 = text.slice(i).trimStart();
      if (line1 && line2) {
        candidates.push({ line1, line2, priority: 3 });
      }
    } else if (ch === "-" || ch === "_" || ch === "/" || ch === ":") {
      const line1 = text.slice(0, i + 1).trimEnd();
      const line2 = text.slice(i + 1).trimStart();
      if (line1 && line2) {
        candidates.push({ line1, line2, priority: 2 });
      }
    } else if (
      (/[a-z0-9]/.test(prev) && /[A-Z]/.test(ch)) ||
      (/[A-Z]/.test(prev) && /[A-Z]/.test(ch) && /[a-z]/.test(next))
    ) {
      const line1 = text.slice(0, i);
      const line2 = text.slice(i);
      if (line1 && line2) {
        candidates.push({ line1, line2, priority: 1 });
      }
    }
  }
  return candidates;
}

export function splitTwoLineTitle(
  title: string,
  maxLinePx: number,
  fontSpec: string = DEFAULT_LABEL_FONT,
  disambiguator?: string | null,
): TwoLineTitle {
  const { base, suffix } = splitDisambiguator(title, disambiguator);
  const singleLine =
    base.length > 0 && suffix
      ? `${base} ${suffix}`
      : base.length > 0
        ? base
        : (suffix ?? "");

  if (singleLine.length === 0) {
    return { line1: "", line2: null };
  }
  if (measureTextPx(singleLine, fontSpec) <= maxLinePx) {
    return { line1: singleLine, line2: null };
  }

  const candidates = collectSplitCandidates(base);
  let bestSplit: {
    readonly line1: string;
    readonly line2: string;
    readonly score: number;
  } | null = null;

  for (const cand of candidates) {
    const w1 = measureTextPx(cand.line1, fontSpec);
    if (w1 > maxLinePx) continue;

    const line2WithSuffix = suffix ? `${cand.line2} ${suffix}` : cand.line2;
    const w2Raw = measureTextPx(line2WithSuffix, fontSpec);
    const fitsBoth = w2Raw <= maxLinePx;
    const truncatedLine2 = smartTruncateToPx(
      cand.line2,
      maxLinePx,
      fontSpec,
      suffix,
    );
    const w2 = measureTextPx(truncatedLine2, fontSpec);
    const balance = 1 - Math.abs(w1 - w2) / Math.max(1, maxLinePx);
    const score =
      (fitsBoth ? 100 : 0) +
      cand.priority * 10 +
      balance * 12 +
      (w1 / Math.max(1, maxLinePx)) * 4;

    if (!bestSplit || score > bestSplit.score) {
      bestSplit = { line1: cand.line1, line2: truncatedLine2, score };
    }
  }

  if (bestSplit) {
    return { line1: bestSplit.line1, line2: bestSplit.line2 };
  }

  const cutLen = Math.max(
    1,
    findMaxFittingPrefixLen(base, maxLinePx, fontSpec, ""),
  );
  const line1 = base.slice(0, cutLen);
  const rest = base.slice(cutLen).trimStart();
  const line2 =
    rest.length > 0 || suffix
      ? smartTruncateToPx(rest, maxLinePx, fontSpec, suffix)
      : null;

  return {
    line1,
    line2: line2 && line2.length > 0 ? line2 : null,
  };
}

function stripRedundantPrefixes(name: string): string {
  let current = normalizeWhitespace(name);
  for (let pass = 0; pass < 3; pass++) {
    let next = current.replace(REDUNDANT_WORD_PREFIX_RE, "").trimStart();
    if (next === current) {
      next = current.replace(REDUNDANT_CAMEL_PREFIX_RE, "");
    }
    next = next.trimStart();
    if (next.length === 0 || next === current) break;
    current = next;
  }
  return current;
}

export function formatSemanticTitle(
  rawTitle: string,
  options?: SemanticTitleOptions,
): SemanticTitleParts {
  const normalizedRaw = normalizeWhitespace(rawTitle);
  const { base, suffix } = splitDisambiguator(
    normalizedRaw,
    options?.disambiguator,
  );

  let fieldPart = base;
  let ownerLabel: string | null =
    options?.ownerLabel && normalizeWhitespace(options.ownerLabel).length > 0
      ? normalizeWhitespace(options.ownerLabel)
      : null;

  const ownerMatch = OWNER_SUFFIX_RE.exec(fieldPart);
  if (ownerMatch) {
    const candidateField = normalizeWhitespace(ownerMatch[1] ?? "");
    const candidateOwner = normalizeWhitespace(ownerMatch[2] ?? "");
    if (
      candidateField.length > 0 &&
      candidateOwner.length > 0 &&
      !/^\d+$/.test(candidateOwner)
    ) {
      fieldPart = candidateField;
      ownerLabel = ownerLabel ?? candidateOwner;
    }
  }

  const title = stripRedundantPrefixes(fieldPart);

  return {
    title: title.length > 0 ? title : fieldPart,
    ownerLabel,
    disambiguator: suffix,
    raw: rawTitle,
  };
}
