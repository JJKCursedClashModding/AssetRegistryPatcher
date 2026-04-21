import type { ContentSegmentOptions } from "../job/contentPath.js";
import type { RegistryRowBase } from "../job/schema.js";
import { toPosixAssetPath } from "../path/safePaths.js";
import { assetClassPathDisplay, softObjectPathWireDisplay, type LoadedAssetData } from "./assetData.js";
import { fNameToString } from "./fnameWire.js";
import { assetIdentityKey, identityFromAssetPath } from "./identity.js";

/** Copy a loaded registry row into the shape used as job `base` (non-identity fields only). */
export function loadedAssetDataToRegistryBase(row: LoadedAssetData): RegistryRowBase {
  return {
    assetClassPath: assetClassPathDisplay(row),
    packageFlags: row.packageFlags,
    chunkIds: [...row.chunkIds],
    tags: { ...row.tags },
    bundles: row.bundles.map((b) => ({
      bundleName: fNameToString(b.bundleName),
      paths: b.paths.map((p) => softObjectPathWireDisplay(p)),
    })),
  };
}

/**
 * Resolve `base`: inline `RegistryRowBase`, or a string path (same rules as `assetPath` under `packageRoot`)
 * selecting a row from `registryInputPath` by identity.
 */
export function resolveJobRegistryBase(
  base: string | RegistryRowBase | undefined,
  registryByIdentity: Map<string, LoadedAssetData>,
  contentMount: string,
  contentOpts: ContentSegmentOptions,
  refLabel: string,
): RegistryRowBase | undefined {
  if (base === undefined) {
    return undefined;
  }
  if (typeof base !== "string") {
    return base;
  }
  const posix = toPosixAssetPath(base);
  const id = identityFromAssetPath(posix, contentMount, contentOpts);
  const row = registryByIdentity.get(assetIdentityKey(id.packageName, id.assetName));
  if (!row) {
    throw new Error(
      `${refLabel}: no row in registryInputPath for base path "${base}" (${id.packageName} / ${id.assetName})`,
    );
  }
  return loadedAssetDataToRegistryBase(row);
}
