/**
 * Long package path derivation (PLAN.md): locate a configurable content folder segment,
 * then everything after that segment up to (excluding) the file extension is under contentMount.
 */

export interface ContentSegmentOptions {
  /** Path segment to find (default in resolver: "Content"). Must not contain '/'. */
  contentSegment: string;
  /** If true, segment match is case-sensitive (default: true). */
  contentSegmentMatchCase: boolean;
}

function compareSegment(a: string, b: string, matchCase: boolean): boolean {
  if (matchCase) {
    return a === b;
  }
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Returns the index in `assetPathPosix` where the content segment starts, and the index
 * of the first character after `segment/` (i.e. start of the path under mount).
 */
export function findContentSegmentBounds(
  assetPathPosix: string,
  segment: string,
  matchCase: boolean,
): { segmentStart: number; afterSegment: number } | null {
  if (segment.includes("/") || segment.length === 0) {
    throw new Error(`contentSegment must be non-empty and must not contain '/': ${JSON.stringify(segment)}`);
  }
  const parts = assetPathPosix.split("/");
  let charIdx = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (compareSegment(p, segment, matchCase)) {
      return { segmentStart: charIdx, afterSegment: charIdx + p.length + 1 };
    }
    charIdx += p.length + 1;
  }
  return null;
}

/**
 * Long package name: `contentMount` + path under content (dirs + stem), slashes normalized.
 * Example: `MyGame/Content/Chars/X.uasset`, mount `/Game` → `/Game/Chars/X`.
 */
export function deriveLongPackageName(
  assetPathPosix: string,
  contentMount: string,
  opts: ContentSegmentOptions,
): string {
  const bounds = findContentSegmentBounds(
    assetPathPosix,
    opts.contentSegment,
    opts.contentSegmentMatchCase,
  );
  if (!bounds) {
    throw new Error(
      `assetPath has no "${opts.contentSegment}" segment${opts.contentSegmentMatchCase ? "" : " (case-insensitive)"}: ${assetPathPosix}`,
    );
  }
  const tail = assetPathPosix.slice(bounds.afterSegment);
  const dot = tail.lastIndexOf(".");
  if (dot <= 0) {
    throw new Error(`assetPath must include an extension after ${opts.contentSegment}/: ${assetPathPosix}`);
  }
  const underContent = tail.slice(0, dot).replace(/^\/+/, "").replace(/\/+$/, "");
  const mount = contentMount.replace(/\/+$/, "");
  if (!underContent.length) {
    return mount;
  }
  return `${mount}/${underContent}`.replace(/\/{2,}/g, "/");
}
