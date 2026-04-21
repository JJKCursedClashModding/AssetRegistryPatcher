import {
  type LoadedAssetData,
  plainFName,
  softObjectPathWireFromDisplayString,
  topLevelPathWiresFromString,
} from "./unreal/index.js";

const DEFAULT_ASSET_CLASS = "/Script/CoreUObject.Object";

function parentPath(longPackage: string): string {
  const i = longPackage.lastIndexOf("/");
  return i < 0 ? "" : longPackage.slice(0, i);
}

/**
 * A registry row in the JSON format produced by `print-row` / uassetbulkprocessor.
 *
 * Fields:
 *   packageName   – full UE package path, e.g. `/Game/Mods/Foo/Bar`
 *   objectName    – asset object name, e.g. `Bar`
 *   packagePath   – (informational) parent folder; ignored on input, derived from packageName
 *   classPath     – full top-level class path, e.g. `/Script/Engine.AnimMontage`
 *   packageFlags  – integer (or hex string) package flags
 *   packageFlagsHex – (informational) ignored on input
 *   chunkIds      – array of integer chunk IDs
 *   tags          – string→string map of FAssetData tags
 *   bundles       – array of { bundleName, paths[] }
 */
export interface RegistryRow {
  packageName: string;
  objectName: string;
  packagePath?: string;
  classPath?: string;
  packageFlags?: number | string;
  packageFlagsHex?: string;
  chunkIds?: number[];
  tags?: Record<string, string>;
  bundles?: Array<{ bundleName: string; paths: string[] }>;
}

function parsePackageFlags(raw: number | string | undefined, ctx: string): number {
  if (raw === undefined) return 0;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) throw new Error(`${ctx}.packageFlags must be an integer`);
    return raw >>> 0;
  }
  const s = raw.trim();
  if (!s.length) throw new Error(`${ctx}.packageFlags must not be empty`);
  const n = s.startsWith("0x") || s.startsWith("0X")
    ? Number.parseInt(s, 16)
    : Number.parseInt(s, 10);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${ctx}.packageFlags must be an integer or hex string`);
  }
  return n >>> 0;
}

/** Parse a string-map from a JSON object field. */
function parseStringMapField(
  o: Record<string, unknown>,
  fieldName: string,
  ctx: string,
): Record<string, string> | undefined {
  const raw = o[fieldName];
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object") {
    throw new Error(`${ctx}.${fieldName} must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new Error(`${ctx}.${fieldName}[${JSON.stringify(k)}] must be a string`);
    }
    out[k] = v;
  }
  return out;
}

/** Parse a chunkIds array. */
function parseChunkIds(o: Record<string, unknown>, fieldName: string, ctx: string): number[] | undefined {
  const raw = o[fieldName];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`${ctx}.${fieldName} must be an array`);
  }
  const ids: number[] = [];
  for (let j = 0; j < raw.length; j++) {
    const v = (raw as unknown[])[j];
    if (typeof v !== "number" || !Number.isInteger(v)) {
      throw new Error(`${ctx}.${fieldName}[${j}] must be an integer`);
    }
    ids.push(v);
  }
  return ids;
}

/** Parse a bundles array. */
function parseBundles(
  o: Record<string, unknown>,
  fieldName: string,
  ctx: string,
): Array<{ bundleName: string; paths: string[] }> | undefined {
  const raw = o[fieldName];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`${ctx}.${fieldName} must be an array`);
  }
  const bundles: Array<{ bundleName: string; paths: string[] }> = [];
  for (let j = 0; j < raw.length; j++) {
    const b = (raw as unknown[])[j];
    if (b === null || typeof b !== "object") {
      throw new Error(`${ctx}.${fieldName}[${j}] must be an object`);
    }
    const bo = b as Record<string, unknown>;
    if (typeof bo.bundleName !== "string" || !bo.bundleName.length) {
      throw new Error(`${ctx}.${fieldName}[${j}].bundleName must be a non-empty string`);
    }
    if (!Array.isArray(bo.paths)) {
      throw new Error(`${ctx}.${fieldName}[${j}].paths must be an array`);
    }
    const paths: string[] = [];
    for (let k = 0; k < bo.paths.length; k++) {
      const p = (bo.paths as unknown[])[k];
      if (typeof p !== "string") {
        throw new Error(`${ctx}.${fieldName}[${j}].paths[${k}] must be a string`);
      }
      paths.push(p);
    }
    bundles.push({ bundleName: bo.bundleName, paths });
  }
  return bundles;
}

export function assertRegistryRows(raw: unknown, label: string): RegistryRow[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${label}: root must be a JSON array`);
  }
  const out: RegistryRow[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const ctx = `${label}[${i}]`;
    if (item === null || typeof item !== "object") {
      throw new Error(`${ctx}: must be an object`);
    }
    const o = item as Record<string, unknown>;

    if (typeof o.packageName !== "string" || !o.packageName.length) {
      throw new Error(`${ctx}.packageName must be a non-empty string`);
    }
    if (typeof o.objectName !== "string" || !o.objectName.length) {
      throw new Error(`${ctx}.objectName must be a non-empty string`);
    }

    const row: RegistryRow = {
      packageName: o.packageName,
      objectName: o.objectName,
    };

    if (typeof o.classPath === "string" && o.classPath.length) {
      row.classPath = o.classPath;
    }

    if (o.packageFlags !== undefined) {
      if (typeof o.packageFlags !== "number" && typeof o.packageFlags !== "string") {
        throw new Error(`${ctx}.packageFlags must be a number or string`);
      }
      row.packageFlags = o.packageFlags as number | string;
    }

    // packageFlagsHex is informational — silently accepted and ignored.

    const chunkIds = parseChunkIds(o, "chunkIds", ctx);
    if (chunkIds !== undefined) row.chunkIds = chunkIds;

    const tags = parseStringMapField(o, "tags", ctx);
    if (tags !== undefined) row.tags = tags;

    const bundles = parseBundles(o, "bundles", ctx);
    if (bundles !== undefined) row.bundles = bundles;

    out.push(row);
  }
  return out;
}

function cloneBundlesFromRow(b?: RegistryRow["bundles"]) {
  if (!b?.length) {
    return [];
  }
  return b.map((x) => ({
    bundleName: plainFName(x.bundleName),
    paths: x.paths.map((p) => softObjectPathWireFromDisplayString(p)),
  }));
}

export function loadedAssetDataFromRegistryRow(row: RegistryRow, ctx: string): LoadedAssetData {
  const classPathStr = row.classPath?.trim() || DEFAULT_ASSET_CLASS;
  const { pkg: assetClassPathPackage, asset: assetClassPathAsset } =
    topLevelPathWiresFromString(classPathStr);

  const packageFlags = parsePackageFlags(row.packageFlags, ctx);
  const chunkIds = row.chunkIds !== undefined ? [...row.chunkIds] : [0];
  const tags: Record<string, string> = row.tags !== undefined ? { ...row.tags } : {};
  const bundles = cloneBundlesFromRow(row.bundles);

  return {
    packagePath: plainFName(parentPath(row.packageName)),
    assetClassPathPackage,
    assetClassPathAsset,
    packageName: plainFName(row.packageName),
    assetName: plainFName(row.objectName),
    tags,
    tagValueTypeHints: undefined,
    bundles,
    chunkIds,
    packageFlags,
  };
}
