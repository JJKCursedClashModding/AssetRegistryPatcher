import { BinaryReader } from "../io/binaryReader.js";
import { BinaryWriter } from "../io/binaryWriter.js";
import { readFName, readFNameWire, type NameTable } from "./nameBatch.js";
import { resolveTagMap, resolveTagMapTypeIds, type ParsedFixedStoreInternal, type TagValueTypeId } from "./fixedStore.js";
import type { FNameWire } from "./fnameWire.js";
import { fNameToString, plainFName } from "./fnameWire.js";

export interface SoftObjectPathWire {
  packagePart: FNameWire;
  assetPart: FNameWire;
  /** Sub-path after `:`, UTF-8 payload as in `FSoftObjectPath` (no forced NUL). */
  subUtf8: string;
}

export interface AssetBundleEntry {
  bundleName: FNameWire;
  paths: SoftObjectPathWire[];
}

export interface LoadedAssetData {
  packagePath: FNameWire;
  assetClassPathPackage: FNameWire;
  assetClassPathAsset: FNameWire;
  packageName: FNameWire;
  assetName: FNameWire;
  tags: Record<string, string>;
  /** Optional fixed-tag value type ids loaded from source store (0..6). */
  tagValueTypeHints?: Record<string, TagValueTypeId>;
  bundles: AssetBundleEntry[];
  chunkIds: number[];
  packageFlags: number;
}

export function joinTopLevelPath(pkg: FNameWire, asset: FNameWire): string {
  const ps = fNameToString(pkg);
  const as = fNameToString(asset);
  if (!as || as === "None") {
    return ps;
  }
  return `${ps}.${as}`;
}

export function softObjectPathWireDisplay(p: SoftObjectPathWire): string {
  const top = joinTopLevelPath(p.packagePart, p.assetPart);
  return p.subUtf8.length ? `${top}:${p.subUtf8}` : top;
}

/** Legacy single-string `FTopLevelAssetPath` form (split on last `.`). */
export function splitTopLevelAssetPath(s: string): { packagePart: string; assetPart: string } {
  if (!s.length || s === "None") {
    return { packagePart: "", assetPart: "" };
  }
  const i = s.lastIndexOf(".");
  if (i < 0) {
    return { packagePart: s, assetPart: "" };
  }
  return { packagePart: s.slice(0, i), assetPart: s.slice(i + 1) };
}

export function assetClassPathDisplay(a: LoadedAssetData): string {
  return joinTopLevelPath(a.assetClassPathPackage, a.assetClassPathAsset);
}

function readTopLevelAssetPathWire(r: BinaryReader, table: NameTable): { pkg: FNameWire; asset: FNameWire } {
  const pkg = readFNameWire(r, table);
  const asset = readFNameWire(r, table);
  return { pkg, asset };
}

/** `FSoftObjectPath::SerializePathWithoutFixup` (UE5): 2×FName + FUtf8String subpath. */
function readSoftObjectPathWire(r: BinaryReader, table: NameTable): SoftObjectPathWire {
  const { pkg, asset } = readTopLevelAssetPathWire(r, table);
  const subUtf8 = r.readUtf8StringNoWidth();
  return { packagePart: pkg, assetPart: asset, subUtf8 };
}

function readAssetBundles(r: BinaryReader, table: NameTable): AssetBundleEntry[] {
  const out: AssetBundleEntry[] = [];
  const numBundles = r.readI32();
  for (let b = 0; b < numBundles; b++) {
    const bundleName = readFNameWire(r, table);
    const n = r.readI32();
    const paths: SoftObjectPathWire[] = [];
    for (let i = 0; i < n; i++) {
      paths.push(readSoftObjectPathWire(r, table));
    }
    out.push({ bundleName, paths });
  }
  return out;
}

export function readAssetData(
  r: BinaryReader,
  table: NameTable,
  store: ParsedFixedStoreInternal,
): LoadedAssetData {
  const packagePath = readFNameWire(r, table);
  const cls = readTopLevelAssetPathWire(r, table);
  const packageName = readFNameWire(r, table);
  const assetName = readFNameWire(r, table);

  const mapHandle = r.readU64();
  const tags = resolveTagMap(store, mapHandle);
  const tagValueTypeHints = resolveTagMapTypeIds(store, mapHandle);

  const bundles = readAssetBundles(r, table);

  const nChunks = r.readI32();
  const chunkIds: number[] = [];
  for (let i = 0; i < nChunks; i++) {
    chunkIds.push(r.readI32());
  }
  const packageFlags = r.readU32();

  return {
    packagePath,
    assetClassPathPackage: cls.pkg,
    assetClassPathAsset: cls.asset,
    packageName,
    assetName,
    tags,
    tagValueTypeHints,
    bundles,
    chunkIds,
    packageFlags,
  };
}

/** Split `FSoftObjectPath` string form (`top` + optional `:sub`). */
export function softObjectPathTopAndSub(p: string): { top: string; sub: string } {
  const colon = p.indexOf(":");
  if (colon < 0) {
    return { top: p, sub: "" };
  }
  return { top: p.slice(0, colon), sub: p.slice(colon + 1) };
}

export function softObjectPathWireFromDisplayString(path: string): SoftObjectPathWire {
  const { top, sub } = softObjectPathTopAndSub(path);
  const tl = splitTopLevelAssetPath(top);
  return {
    packagePart: plainFName(tl.packagePart),
    assetPart: plainFName(tl.assetPart || "None"),
    subUtf8: sub,
  };
}

export function topLevelPathWiresFromString(classPath: string): { pkg: FNameWire; asset: FNameWire } {
  const tl = splitTopLevelAssetPath(classPath);
  return {
    pkg: plainFName(tl.packagePart),
    asset: plainFName(tl.assetPart || "None"),
  };
}

/**
 * `FName` display for tag values (matches UE `FName` with optional `_Number` suffix).
 *
 * UE internal storage: display suffix `_N` is stored as internal number `N+1`.
 * `_0` → internal 1, `_1` → internal 2, etc.  Semantic suffixes like `_010` are kept
 * as plain names (the leading-zero guard below).
 */
export function parseFNameWireFromRegistryTag(s: string): FNameWire {
  if (!s.length) {
    return plainFName("");
  }
  const m = s.match(/^(.*)_(\d+)$/);
  if (m) {
    const digits = m[2]!;
    // Keep semantic suffixes like `_010` as plain names (leading zero ≠ instance number).
    if (digits.length > 1 && digits[0] === "0") {
      return plainFName(s);
    }
    const n = parseInt(digits, 10);
    // n >= 0: `_0` is a valid numbered suffix (internal number 1).
    if (Number.isFinite(n) && n >= 0) {
      return { base: m[1]!, number: (n + 1) >>> 0 };
    }
  }
  return plainFName(s);
}

/** Four `FName` fields as in `FAssetRegistryExportPath` serialization (see `fixedStore.readAssetRegistryExportPath`). */
export interface AssetRegistryExportPathWire {
  classPkg: FNameWire;
  classAsset: FNameWire;
  objectName: FNameWire;
  packageName: FNameWire;
}

export function assetRegistryExportPathDisplay(w: AssetRegistryExportPathWire): string {
  const classPath = joinTopLevelPath(w.classPkg, w.classAsset);
  const pkg = fNameToString(w.packageName);
  const obj = fNameToString(w.objectName);
  if (!classPath.length) {
    if (!obj.length) {
      return pkg;
    }
    return `${pkg}.${obj}`;
  }
  return `${classPath}'${pkg}.${obj}'`;
}

export function isExportPathWireAllNumberless(w: AssetRegistryExportPathWire): boolean {
  return (
    w.classPkg.number === 0 &&
    w.classAsset.number === 0 &&
    w.objectName.number === 0 &&
    w.packageName.number === 0
  );
}

/** Inverse of {@link assetRegistryExportPathDisplay} for cooked tag strings. */
export function parseAssetRegistryExportPathFromDisplay(s: string): AssetRegistryExportPathWire {
  const q = s.indexOf("'");
  if (q < 0) {
    const { packagePart, assetPart } = splitTopLevelAssetPath(s);
    return {
      classPkg: plainFName(""),
      classAsset: plainFName("None"),
      packageName: parseFNameWireFromRegistryTag(packagePart),
      objectName: parseFNameWireFromRegistryTag(assetPart),
    };
  }
  const classTop = s.slice(0, q);
  let inner = s.slice(q + 1);
  if (inner.endsWith("'")) {
    inner = inner.slice(0, -1);
  }
  const { packagePart, assetPart } = splitTopLevelAssetPath(inner);
  const tl = splitTopLevelAssetPath(classTop);
  return {
    classPkg: parseFNameWireFromRegistryTag(tl.packagePart),
    classAsset: parseFNameWireFromRegistryTag(tl.assetPart || "None"),
    packageName: parseFNameWireFromRegistryTag(packagePart),
    objectName: parseFNameWireFromRegistryTag(assetPart),
  };
}
