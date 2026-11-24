export type QueryField =
  "text" | "tag" | "kind" | "prop" | "file" | "runtime" | "is" | "id";

export interface QueryToken {
  readonly raw: string;
  readonly start: number;
  readonly end: number;
  readonly negated: boolean;
  readonly field: QueryField;
  readonly value: string;
  readonly quoted: boolean;
}

export interface ParsedQuery {
  readonly raw: string;
  readonly tokens: ReadonlyArray<QueryToken>;
  readonly inclusions: ReadonlyArray<QueryToken>;
  readonly exclusions: ReadonlyArray<QueryToken>;
}

const STRUCTURED_FIELD_MAP = new Map<string, QueryField>([
  ["tag", "tag"],
  ["kind", "kind"],
  ["prop", "prop"],
  ["file", "file"],
  ["runtime", "runtime"],
  ["is", "is"],
]);

function isWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

function readQuoted(
  input: string,
  openQuoteIndex: number,
): { readonly value: string; readonly end: number } {
  let out = "";
  let i = openQuoteIndex + 1;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === "\\") {
      const next = input[i + 1];
      if (next === '"' || next === "\\") {
        out += next;
        i += 2;
        continue;
      }
    }
    if (ch === '"') {
      return { value: out, end: i + 1 };
    }
    out += ch;
    i++;
  }
  return { value: out, end: input.length };
}

function readUnquoted(
  input: string,
  start: number,
): { readonly value: string; readonly end: number } {
  let i = start;
  while (i < input.length && !isWhitespace(input[i])) {
    i++;
  }
  return { value: input.slice(start, i), end: i };
}

function matchStructuredFieldPrefix(
  input: string,
  index: number,
): { readonly field: QueryField; readonly colonIndex: number } | null {
  let j = index;
  while (j < input.length && /[a-zA-Z]/.test(input[j]!)) {
    j++;
  }
  if (j > index && input[j] === ":") {
    const field = STRUCTURED_FIELD_MAP.get(input.slice(index, j).toLowerCase());
    if (field !== undefined) {
      return { field, colonIndex: j };
    }
  }
  return null;
}

export function parseQuery(query: string): ParsedQuery {
  const tokens: QueryToken[] = [];
  const inclusions: QueryToken[] = [];
  const exclusions: QueryToken[] = [];

  let i = 0;
  while (i < query.length) {
    while (i < query.length && isWhitespace(query[i])) {
      i++;
    }
    if (i >= query.length) break;

    const start = i;
    let negated = false;
    if (
      query[i] === "-" &&
      i + 1 < query.length &&
      !isWhitespace(query[i + 1])
    ) {
      negated = true;
      i++;
    }

    let field: QueryField = "text";
    let value = "";
    let quoted = false;
    let end = i;

    const ch = query[i];
    if (ch === '"') {
      const res = readQuoted(query, i);
      value = res.value;
      end = res.end;
      quoted = true;
    } else if (ch === "#") {
      const res = readUnquoted(query, i + 1);
      field = "id";
      value = res.value;
      end = res.end;
    } else {
      const prefix = matchStructuredFieldPrefix(query, i);
      if (prefix !== null) {
        field = prefix.field;
        const afterColon = prefix.colonIndex + 1;
        if (afterColon < query.length && query[afterColon] === '"') {
          const res = readQuoted(query, afterColon);
          value = res.value;
          end = res.end;
          quoted = true;
        } else {
          const res = readUnquoted(query, afterColon);
          value = res.value;
          end = res.end;
        }
      } else {
        const res = readUnquoted(query, i);
        value = res.value;
        end = res.end;
      }
    }

    const token: QueryToken = {
      raw: query.slice(start, end),
      start,
      end,
      negated,
      field,
      value,
      quoted,
    };
    tokens.push(token);
    if (token.value.length > 0) {
      if (token.negated) exclusions.push(token);
      else inclusions.push(token);
    }

    i = end;
  }

  return {
    raw: query,
    tokens,
    inclusions,
    exclusions,
  };
}

const globRegexCache = new Map<string, RegExp>();

export function matchGlob(pattern: string, candidate: string): boolean {
  if (pattern.length === 0) return false;
  if (!pattern.includes("*")) {
    return pattern.toLowerCase() === candidate.toLowerCase();
  }
  const collapsed = pattern.replace(/\*+/g, "*").toLowerCase();
  let regex = globRegexCache.get(collapsed);
  if (!regex) {
    const escaped = collapsed
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    regex = new RegExp(`^${escaped}$`, "i");
    if (globRegexCache.size > 256) {
      globRegexCache.clear();
    }
    globRegexCache.set(collapsed, regex);
  }
  return regex.test(candidate);
}

function formatFieldToken(
  negated: boolean,
  field: Exclude<QueryField, "text" | "id">,
  value: string,
): string {
  const prefix = `${negated ? "-" : ""}${field}:`;
  if (value.length === 0 || /[\s"]/.test(value)) {
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `${prefix}"${escaped}"`;
  }
  return `${prefix}${value}`;
}

function removeTokenSpans(
  query: string,
  spans: ReadonlyArray<{ readonly start: number; readonly end: number }>,
): string {
  if (spans.length === 0) return query;
  const sortedDesc = spans.toSorted((a, b) => b.start - a.start);
  let result = query;
  for (const span of sortedDesc) {
    let wsBeforeStart = span.start;
    while (wsBeforeStart > 0 && isWhitespace(result[wsBeforeStart - 1])) {
      wsBeforeStart--;
    }
    let wsAfterEnd = span.end;
    while (wsAfterEnd < result.length && isWhitespace(result[wsAfterEnd])) {
      wsAfterEnd++;
    }

    if (wsBeforeStart === 0) {
      result = result.slice(wsAfterEnd);
    } else if (wsAfterEnd === result.length) {
      result = result.slice(0, wsBeforeStart);
    } else {
      result = result.slice(0, span.start) + result.slice(wsAfterEnd);
    }
  }
  return result;
}

function appendTokenToQuery(query: string, tokenText: string): string {
  const trimmedEnd = query.trimEnd();
  if (trimmedEnd.trim().length === 0) {
    return tokenText;
  }
  return `${trimmedEnd} ${tokenText}`;
}

function setFieldExcludedInQuery(
  query: string,
  field: "tag" | "kind" | "runtime",
  value: string,
  excluded: boolean,
  allKnownValues?: ReadonlyArray<string>,
): string {
  const target = value.trim();
  if (target.length === 0) return query;
  const targetLower = target.toLowerCase();
  const parsed = parseQuery(query);
  const matching = parsed.tokens.filter(
    (t) => t.field === field && t.value.toLowerCase() === targetLower,
  );

  const supportsWildcards = field === "tag" || field === "runtime";

  if (excluded) {
    const redundantNarrower =
      supportsWildcards && target.includes("*")
        ? parsed.tokens.filter(
            (t) =>
              t.field === field &&
              t.negated &&
              t.value.toLowerCase() !== targetLower &&
              matchGlob(target, t.value),
          )
        : [];
    const positiveSpans = matching.filter((t) => !t.negated);
    const hasNegated = matching.some((t) => t.negated);
    const cleaned = removeTokenSpans(query, [
      ...positiveSpans,
      ...redundantNarrower,
    ]);
    if (hasNegated) return cleaned;
    return appendTokenToQuery(cleaned, formatFieldToken(true, field, target));
  }

  const negatedSpans = matching.filter((t) => t.negated);
  const matchingWildcards =
    supportsWildcards && !target.includes("*")
      ? parsed.tokens.filter(
          (t) =>
            t.field === field &&
            t.negated &&
            t.value.includes("*") &&
            matchGlob(t.value, target),
        )
      : [];

  let next = removeTokenSpans(query, [...negatedSpans, ...matchingWildcards]);

  if (
    matchingWildcards.length > 0 &&
    allKnownValues &&
    allKnownValues.length > 0
  ) {
    const remainingParsed = parseQuery(next);
    const alreadyExcluded = new Set(
      remainingParsed.exclusions
        .filter((t) => t.field === field)
        .map((t) => t.value.toLowerCase()),
    );
    for (const candidate of allKnownValues) {
      const candLower = candidate.toLowerCase();
      if (candLower === targetLower) continue;
      if (alreadyExcluded.has(candLower)) continue;
      if (matchingWildcards.some((w) => matchGlob(w.value, candidate))) {
        alreadyExcluded.add(candLower);
        next = appendTokenToQuery(
          next,
          formatFieldToken(true, field, candidate),
        );
      }
    }
  }

  return next;
}

export function setTagExcludedInQuery(
  query: string,
  tag: string,
  excluded: boolean,
  allKnownTags?: ReadonlyArray<string>,
): string {
  return setFieldExcludedInQuery(query, "tag", tag, excluded, allKnownTags);
}

function setFieldOnlyInQuery(
  query: string,
  field: "tag" | "runtime",
  value: string,
): string {
  const target = value.trim();
  if (target.length === 0) return query;
  const targetLower = target.toLowerCase();
  const parsed = parseQuery(query);
  const fieldTokens = parsed.tokens.filter((t) => t.field === field);

  if (
    fieldTokens.length === 1 &&
    !fieldTokens[0]!.negated &&
    fieldTokens[0]!.value.toLowerCase() === targetLower
  ) {
    return query;
  }

  const cleaned = removeTokenSpans(query, fieldTokens);
  return appendTokenToQuery(cleaned, formatFieldToken(false, field, target));
}

export function setTagOnlyInQuery(query: string, tag: string): string {
  return setFieldOnlyInQuery(query, "tag", tag);
}

export function setRuntimeExcludedInQuery(
  query: string,
  runtimeName: string,
  excluded: boolean,
  allKnownRuntimes?: ReadonlyArray<string>,
): string {
  return setFieldExcludedInQuery(
    query,
    "runtime",
    runtimeName,
    excluded,
    allKnownRuntimes,
  );
}

export function setRuntimeOnlyInQuery(
  query: string,
  runtimeName: string,
): string {
  return setFieldOnlyInQuery(query, "runtime", runtimeName);
}

export function setKindExcludedInQuery(
  query: string,
  kind: string,
  excluded: boolean,
): string {
  return setFieldExcludedInQuery(query, "kind", kind, excluded);
}

function listFieldValues(
  query: string,
  field: QueryField,
  negated: boolean,
): ReadonlyArray<string> {
  const parsed = parseQuery(query);
  const seen = new Set<string>();
  const result: string[] = [];
  const source = negated ? parsed.exclusions : parsed.inclusions;
  for (const token of source) {
    if (token.field !== field) continue;
    const key = token.value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(token.value);
    }
  }
  return result;
}

export function listExcludedTags(query: string): ReadonlyArray<string> {
  return listFieldValues(query, "tag", true);
}

export function listIncludedTags(query: string): ReadonlyArray<string> {
  return listFieldValues(query, "tag", false);
}

export function clearTagTokens(query: string): string {
  const parsed = parseQuery(query);
  const tagTokens = parsed.tokens.filter((t) => t.field === "tag");
  return removeTokenSpans(query, tagTokens);
}

export function listExcludedRuntimes(query: string): ReadonlyArray<string> {
  return listFieldValues(query, "runtime", true);
}

export function listIncludedRuntimes(query: string): ReadonlyArray<string> {
  return listFieldValues(query, "runtime", false);
}

export function clearRuntimeTokens(query: string): string {
  const parsed = parseQuery(query);
  const runtimeTokens = parsed.tokens.filter((t) => t.field === "runtime");
  return removeTokenSpans(query, runtimeTokens);
}

export function rewriteFieldInclusionsToExclusions(
  query: string,
  field: "tag" | "runtime",
  includedValues: ReadonlyArray<string>,
  allKnownValues: ReadonlyArray<string>,
): string {
  const parsed = parseQuery(query);
  const positiveSpans = parsed.tokens.filter(
    (t) => t.field === field && !t.negated,
  );
  let next = removeTokenSpans(query, positiveSpans);
  const includedSet = new Set(includedValues.map((v) => v.toLowerCase()));
  for (const candidate of allKnownValues) {
    const shouldInclude = includedSet.has(candidate.toLowerCase());
    next = setFieldExcludedInQuery(
      next,
      field,
      candidate,
      !shouldInclude,
      allKnownValues,
    );
  }
  return next;
}
