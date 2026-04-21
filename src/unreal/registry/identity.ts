import { deriveLongPackageName, type ContentSegmentOptions } from "../job/contentPath.js";
import type { LoadedAssetData } from "./assetData.js";
import { fNameToString } from "./fnameWire.js";

export function assetIdentityKey(packageName: string, assetName: string): string {
  return `${packageName}\x1f${assetName}`;
}

export function buildBaseIdentitySet(assets: LoadedAssetData[]): Set<string> {
  const s = new Set<string>();
  for (const a of assets) {
    s.add(assetIdentityKey(fNameToString(a.packageName), fNameToString(a.assetName)));
  }
  return s;
}

/** FAssetData identity for collision checks (cooked registry uses package + asset names). */
export function identityFromDerivedLongPackage(longPackage: string): {
  packageName: string;
  assetName: string;
} {
  const i = longPackage.lastIndexOf("/");
  const assetName = i < 0 ? longPackage : longPackage.slice(i + 1);
  return { packageName: longPackage, assetName };
}

export function identityFromAssetPath(
  assetPathPosix: string,
  contentMount: string,
  opts: ContentSegmentOptions,
): { packageName: string; assetName: string; longPackage: string } {
  const longPackage = deriveLongPackageName(assetPathPosix, contentMount, opts);
  const { packageName, assetName } = identityFromDerivedLongPackage(longPackage);
  return { packageName, assetName, longPackage };
}
