import { mkdirSync } from "node:fs";
import path from "node:path";

/** Normalize job `assetPath` to forward slashes (POSIX-style). */
export function toPosixAssetPath(assetPath: string): string {
  return assetPath.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+/, "");
}

/**
 * Resolve `relativePosix` under `rootDir` and ensure the result stays under `rootDir`
 * (no `..` escape after normalization).
 */
export function resolveUnderRoot(rootDir: string, relativePosix: string): string {
  const rel = toPosixAssetPath(relativePosix);
  if (path.isAbsolute(rel)) {
    throw new Error(`Path must be relative to root, got: ${relativePosix}`);
  }
  for (const seg of rel.split("/")) {
    if (seg === ".." || seg === ".") {
      throw new Error(`Invalid path segment in asset path: ${relativePosix}`);
    }
  }
  const absRoot = path.resolve(rootDir);
  const joined = path.resolve(absRoot, rel.split("/").join(path.sep));
  const relOut = path.relative(absRoot, joined);
  if (relOut.startsWith(`..${path.sep}`) || relOut === "..") {
    throw new Error(`Path escapes root (${rootDir}): ${relativePosix}`);
  }
  return joined;
}

export function ensureDirForFile(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
}
