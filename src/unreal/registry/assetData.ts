import { BinaryReader } from "../io/binaryReader.js";
import { BinaryWriter } from "../io/binaryWriter.js";
import { readFName, readFNameWire, type NameTable } from "./nameBatch.js";
import { resolveTagMap, resolveTagMapTypeIds, type ParsedFixedStoreInternal, type TagValueTypeId } from "./fixedStore.js";
import type { FNameWire } from "./fnameWire.js";
import { fNameToString, isNoneFName, NAME_NONE, plainFName } from "./fnameWire.js";

export interface SoftObjectPathWire {
  packagePart: FNameWire;
  assetPart: FNameWire;
  /**
   * `FSoftObjectPath::SubPathString` (an `FString` on the wire). UE 5.1 bundle paths are
   * `FTopLevelAssetPath`s, so the engine itself always writes this empty and drops it on load.
   */
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

/** `FTopLevelAssetPath::AppendString`: "" when the package is None, no `.Asset` when the asset is None. */
export function joinTopLevelPath(pkg: FNameWire, asset: FNameWire): string {
  if (isNoneFName(pkg)) {
    return "";
  }
  const ps = fNameToString(pkg);
  if (isNoneFName(asset)) {
    return ps;
  }
  return `${ps}.${fNameToString(asset)}`;
}

export function softObjectPathWireDisplay(p: SoftObjectPathWire): string {
  const top = joinTopLevelPath(p.packagePart, p.assetPart);
  return p.subUtf8.length ? `${top}:${p.subUtf8}` : top;
}

/**
 * `FTopLevelAssetPath::TrySetPath(FStringView)`: package is everything before the first `.`,
 * asset is the rest. A rest that still contains `.` or `:` is a sub-object path, which the
 * engine rejects (resets the path to null), so throw instead of writing a different path.
 */
export function splitTopLevelAssetPath(s: string): { packagePart: string; assetPart: string } {
  if (!s.length || s === "None") {
    return { packagePart: "", assetPart: "" };
  }
  const i = s.indexOf(".");
  if (i < 0) {
    return { packagePart: s, assetPart: "" };
  }
  const assetPart = s.slice(i + 1);
  if (/[.:]/.test(assetPart)) {
    throw new Error(`Not a top-level asset path (sub-object paths are not allowed): ${JSON.stringify(s)}`);
  }
  return { packagePart: s.slice(0, i), assetPart };
}

/**
 * `FPackageName::ObjectPathToPackageName` split as used by `ParseExportPath`: package is
 * everything before the first `.`, object is the whole rest (may hold `.`/`:` for sub-objects).
 */
export function splitExportObjectPath(s: string): { packagePart: string; objectPart: string } {
  const i = s.indexOf(".");
  if (i < 0) {
    return { packagePart: s, objectPart: "" };
  }
  return { packagePart: s.slice(0, i), objectPart: s.slice(i + 1) };
}

export function assetClassPathDisplay(a: LoadedAssetData): string {
  return joinTopLevelPath(a.assetClassPathPackage, a.assetClassPathAsset);
}

function readTopLevelAssetPathWire(r: BinaryReader, table: NameTable): { pkg: FNameWire; asset: FNameWire } {
  const pkg = readFNameWire(r, table);
  const asset = readFNameWire(r, table);
  return { pkg, asset };
}

/** `FSoftObjectPath::SerializePath` (UE 5.1): `FTopLevelAssetPath` (2×FName) + `FString` sub-path. */
function readSoftObjectPathWire(r: BinaryReader, table: NameTable): SoftObjectPathWire {
  const { pkg, asset } = readTopLevelAssetPathWire(r, table);
  const subUtf8 = r.readFString();
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

/**
 * `FSoftObjectPath::SetPath(FStringView)`: package up to the first `.` or `:`, asset up to the
 * next one, and the rest is the sub-path with `:` normalized to `.`.
 */
export function softObjectPathWireFromDisplayString(path: string): SoftObjectPathWire {
  const m = /^([^.:]*)(?:[.:]([^.:]*)(?:[.:]([\s\S]*))?)?$/.exec(path)!;
  return {
    packagePart: parseFNameWireFromRegistryTag(m[1] ?? ""),
    assetPart: parseFNameWireFromRegistryTag(m[2] ?? ""),
    subUtf8: (m[3] ?? "").replace(/:/g, "."),
  };
}

/**
 * `FTopLevelAssetPath::TrySetPath(FStringView)`: "" / "None" give a null path, a package-only
 * path ("/Game/Pkg") gives (Pkg, None), more than one '.' or a ':' fails. A path not starting
 * with '/' (a short name like "Texture2D") hits `ensureAlwaysMsgf("Short asset name used to
 * create FTopLevelAssetPath")` and resets to null; here it throws instead.
 */
export function topLevelPathWiresFromString(classPath: string): { pkg: FNameWire; asset: FNameWire } {
  if (classPath.length && classPath !== "None" && classPath[0] !== "/") {
    throw new Error(
      `Not a full top-level path (short names are not supported): ${JSON.stringify(classPath)}`,
    );
  }
  const tl = splitTopLevelAssetPath(classPath);
  return {
    pkg: parseFNameWireFromRegistryTag(tl.packagePart),
    asset: parseFNameWireFromRegistryTag(tl.assetPart),
  };
}

/**
 * Strict class path for `FAssetData::AssetClassPath`: exactly "/Package/Path.ClassName", one
 * '.', non-empty package and class. Null and package-only paths, which TrySetPath allows,
 * are rejected because they make a class-less row.
 */
export function classPathWiresFromString(classPath: string, ctx = "classPath"): { pkg: FNameWire; asset: FNameWire } {
  const example = `(e.g. "/Script/Engine.Texture2D")`;
  const dot = classPath.indexOf(".");
  if (classPath[0] !== "/") {
    throw new Error(
      `${ctx}: classPath ${JSON.stringify(classPath)} is not a full class path; short class names are not supported, use "/Script/<Module>.<Class>" ${example}`,
    );
  }
  if (dot < 0) {
    throw new Error(`${ctx}: classPath ${JSON.stringify(classPath)} has no ".<ClassName>" part ${example}`);
  }
  const pkgPart = classPath.slice(0, dot);
  const assetPart = classPath.slice(dot + 1);
  if (pkgPart.length < 2 || pkgPart.endsWith("/") || !assetPart.length || /[.:\/\s]/.test(assetPart)) {
    throw new Error(
      `${ctx}: classPath ${JSON.stringify(classPath)} must be exactly "/Package/Path.ClassName" with a single "." ${example}`,
    );
  }
  const wires = topLevelPathWiresFromString(classPath);
  if (isNoneFName(wires.pkg) || isNoneFName(wires.asset)) {
    throw new Error(`${ctx}: classPath ${JSON.stringify(classPath)} parses to a None name ${example}`);
  }
  return wires;
}

/**
 * FName text -> wire form, mirroring `FNameHelper::ParseNumber` (UE 5.1 UnrealNames.cpp):
 * only the last `_<digits>` splits, and only with no leading zero (a lone `0` is fine),
 * at most 10 digits and a value < MAX_int32. Display `_N` is internal number `N+1`.
 * The empty string, and a string that is only `_<number>` (leaving an empty base), are
 * NAME_None: `MakeWithNumber` ignores the number when the remaining string is empty.
 *
 * Every FName built from text must go through this: the cooked registry always stores
 * splittable names as base + number (e.g. `/Game/Characters/CN_100` is
 * (`/Game/Characters/CN`, 101)), and a whole entry with number 0 is a different FName,
 * so lookups by path/name from the engine would miss it.
 */
export function parseFNameWireFromRegistryTag(s: string): FNameWire {
  const m = /^([\s\S]*)_(0|[1-9]\d{0,9})$/.exec(s);
  if (m) {
    const n = Number(m[2]);
    if (n < 2147483647) {
      return m[1] === "" ? NAME_NONE : { base: m[1]!, number: n + 1 };
    }
  }
  return s === "" ? NAME_NONE : plainFName(s);
}

/** Four `FName` fields as in `FAssetRegistryExportPath` serialization (see `fixedStore.readAssetRegistryExportPath`). */
export interface AssetRegistryExportPathWire {
  classPkg: FNameWire;
  classAsset: FNameWire;
  objectName: FNameWire;
  packageName: FNameWire;
}

/** `FAssetRegistryExportPath::ToString`. */
export function assetRegistryExportPathDisplay(w: AssetRegistryExportPathWire): string {
  const hasClass = !isNoneFName(w.classPkg);
  let out = hasClass ? `${joinTopLevelPath(w.classPkg, w.classAsset)}'` : "";
  out += fNameToString(w.packageName);
  if (!isNoneFName(w.objectName)) {
    out += `.${fNameToString(w.objectName)}`;
  }
  return hasClass ? `${out}'` : out;
}

export function isExportPathWireAllNumberless(w: AssetRegistryExportPathWire): boolean {
  return (
    w.classPkg.number === 0 &&
    w.classAsset.number === 0 &&
    w.objectName.number === 0 &&
    w.packageName.number === 0
  );
}

/**
 * `ParseExportPath` (AssetDataTagMap.cpp): an optional `Class'...'` wrapper, then package up
 * to the first `.` and the whole rest as the object. Unquoted paths get a null (None, None) class.
 */
export function parseAssetRegistryExportPathFromDisplay(s: string): AssetRegistryExportPathWire {
  const q = s.indexOf("'");
  let classPkg = NAME_NONE;
  let classAsset = NAME_NONE;
  let objectPath = s;
  if (q >= 0) {
    objectPath = s.slice(q + 1);
    if (objectPath.endsWith("'")) {
      objectPath = objectPath.slice(0, -1);
    }
    const tl = splitTopLevelAssetPath(s.slice(0, q));
    classPkg = parseFNameWireFromRegistryTag(tl.packagePart);
    classAsset = parseFNameWireFromRegistryTag(tl.assetPart);
  }
  const { packagePart, objectPart } = splitExportObjectPath(objectPath);
  return {
    classPkg,
    classAsset,
    packageName: parseFNameWireFromRegistryTag(packagePart),
    objectName: parseFNameWireFromRegistryTag(objectPart),
  };
}
