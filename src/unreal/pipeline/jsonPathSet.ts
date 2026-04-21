/** One segment in a path like `exports[0].ObjectName`. */
export type JsonPathSegment =
  | { kind: "prop"; name: string }
  | { kind: "index"; index: number };

/**
 * Parse a path with `.` property steps and `[n]` array indices (non-negative integers).
 * Examples: `a.b`, `path.to.items[1]`, `[0].name`
 */
export function parseJsonPath(pathStr: string): JsonPathSegment[] {
  const s = pathStr.trim();
  if (!s.length) {
    throw new Error("setField path must not be empty");
  }
  const segments: JsonPathSegment[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === ".") {
      i++;
      if (i >= s.length) {
        throw new Error(`setField path has trailing dot: ${JSON.stringify(pathStr)}`);
      }
      continue;
    }
    if (s[i] === "[") {
      const close = s.indexOf("]", i);
      if (close < 0) {
        throw new Error(`setField path has unclosed '[': ${JSON.stringify(pathStr)}`);
      }
      const inner = s.slice(i + 1, close).trim();
      if (!/^\d+$/.test(inner)) {
        throw new Error(
          `setField path bracket segment must be a non-negative integer: ${JSON.stringify(pathStr)}`,
        );
      }
      const index = Number(inner);
      segments.push({ kind: "index", index });
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] !== "." && s[j] !== "[") {
      j++;
    }
    const name = s.slice(i, j);
    if (!name.length) {
      throw new Error(`setField path has empty property segment: ${JSON.stringify(pathStr)}`);
    }
    segments.push({ kind: "prop", name });
    i = j;
  }
  if (!segments.length) {
    throw new Error("setField path must not be empty");
  }
  return segments;
}

function getStep(cur: unknown, seg: JsonPathSegment): unknown {
  if (seg.kind === "prop") {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) {
      throw new Error(`cannot read property ${JSON.stringify(seg.name)}: value is not an object`);
    }
    return (cur as Record<string, unknown>)[seg.name];
  }
  if (!Array.isArray(cur)) {
    throw new Error(`cannot read index [${seg.index}]: value is not an array`);
  }
  return cur[seg.index];
}

/** Assign `value` at `pathStr` on parsed JSON `root` (mutates objects/arrays in place). */
export function setValueAtJsonPath(root: unknown, pathStr: string, value: unknown): void {
  const segments = parseJsonPath(pathStr);
  const last = segments.length - 1;
  let cur: unknown = root;
  for (let s = 0; s < last; s++) {
    cur = getStep(cur, segments[s]!);
    if (cur === undefined) {
      throw new Error(
        `setField path ${JSON.stringify(pathStr)}: missing value along path before final segment`,
      );
    }
  }
  const fin = segments[last]!;
  if (fin.kind === "prop") {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) {
      throw new Error(
        `setField path ${JSON.stringify(pathStr)}: parent of final property is not an object`,
      );
    }
    (cur as Record<string, unknown>)[fin.name] = value;
    return;
  }
  if (!Array.isArray(cur)) {
    throw new Error(
      `setField path ${JSON.stringify(pathStr)}: parent of final index is not an array`,
    );
  }
  cur[fin.index] = value;
}
