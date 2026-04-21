import type { ContentSegmentOptions } from "../job/contentPath.js";
import type { RegistryRowBase } from "../job/schema.js";
import type { AssetBundleEntry, LoadedAssetData } from "./assetData.js";
import { softObjectPathWireFromDisplayString, topLevelPathWiresFromString } from "./assetData.js";
import { plainFName } from "./fnameWire.js";
import { identityFromAssetPath } from "./identity.js";

function parentPath(longPackage: string): string {
  const i = longPackage.lastIndexOf("/");
  return i < 0 ? "" : longPackage.slice(0, i);
}

const DEFAULT_ASSET_CLASS = "/Script/CoreUObject.Object";

function assetClassPathFromHints(hints: Record<string, string>): string {
  const typeHint = hints.Class?.trim() || hints["Export0.Type"]?.trim() || "";
  if (!typeHint.trim()) {
    return DEFAULT_ASSET_CLASS;
  }
  const t = typeHint.replace(/^UnknownProperty:\s*/i, "").trim();
  if (t.includes(".")) {
    return t.startsWith("/") ? t : `/${t}`;
  }
  const pkg = hints.ClassPackage?.trim() ?? hints["Export0.ClassPackage"]?.trim();
  if (pkg?.startsWith("/Script/")) {
    return `${pkg}.${t}`;
  }
  return `/Script/CoreUObject.${t}`;
}

function hasExplicitClassHint(hints: Record<string, string>): boolean {
  return Boolean((hints.Class ?? hints["Export0.Type"] ?? "").trim());
}

function cloneBundles(b?: RegistryRowBase["bundles"]): AssetBundleEntry[] {
  if (!b?.length) {
    return [];
  }
  return b.map((x) => ({
    bundleName: plainFName(x.bundleName),
    paths: x.paths.map((p) => softObjectPathWireFromDisplayString(p)),
  }));
}

/**
 * Merge tag maps for a staged registry row (later arguments win on duplicate keys).
 * 1. `registrySourceTags` — row from `registryInputPath` for the **source** asset (edit: `assetPath`; pack: same path).
 * 2. `baseTags` — job `base.tags`
 * 3. `hints` — UAssetGUI JSON extraction
 */
export function mergeAssetDataTags(
  registrySourceTags: Record<string, string> | undefined,
  baseTags: Record<string, string> | undefined,
  hints: Record<string, string>,
): Record<string, string> {
  return {
    ...(registrySourceTags ?? {}),
    ...(baseTags ?? {}),
    ...hints,
  };
}

/**
 * Build a `LoadedAssetData` row from a staged asset path and UAssetGUI JSON hints (best-effort tags/class).
 * Optional `base` supplies defaults for anything hints do not set; **identity** always comes from `assetPathPosix`.
 * Tags merge via {@link mergeAssetDataTags} when `registrySourceTags` is set.
 */
export function loadedAssetDataFromStagingHints(
  assetPathPosix: string,
  contentMount: string,
  contentOpts: ContentSegmentOptions,
  hints: Record<string, string>,
  base?: RegistryRowBase,
  registrySourceTags?: Record<string, string>,
): LoadedAssetData {
  const { packageName, assetName, longPackage } = identityFromAssetPath(
    assetPathPosix,
    contentMount,
    contentOpts,
  );
  const fromHintsClass = assetClassPathFromHints(hints);
  const assetClassPathStr = hasExplicitClassHint(hints)
    ? fromHintsClass
    : base?.assetClassPath ?? fromHintsClass;
  const { pkg: assetClassPathPackage, asset: assetClassPathAsset } =
    topLevelPathWiresFromString(assetClassPathStr);

  const tags = mergeAssetDataTags(registrySourceTags, base?.tags, hints);
  delete tags.Class;
  delete tags.ClassPackage;
  delete tags["Export0.Type"];
  delete tags["Export0.ClassPackage"];
  // Temporary safety rule: keep PrimaryAssetName aligned with staged asset object name.
  tags.PrimaryAssetName = assetName;

  const chunkIds = base?.chunkIds !== undefined ? [...base.chunkIds] : [0];
  const packageFlags = base?.packageFlags !== undefined ? base.packageFlags : 0;
  const bundles = cloneBundles(base?.bundles);

  return {
    packagePath: plainFName(parentPath(longPackage)),
    assetClassPathPackage,
    assetClassPathAsset,
    packageName: plainFName(packageName),
    assetName: plainFName(assetName),
    tags,
    bundles,
    chunkIds,
    packageFlags,
  };
}
