/**
 * Cooked registry FName on the wire: name-batch display string + optional instance number.
 * Matches `FAssetRegistryWriter::operator<<(FName&)` numbering (`0x80000000` index bit).
 */

import { NAME_NUMBERED_BIT } from "./constants.js";

export interface FNameWire {
  readonly base: string;
  readonly number: number;
}

export function plainFName(base: string): FNameWire {
  return { base, number: 0 };
}

export function fNameToString(f: FNameWire): string {
  if (f.number === 0) {
    return f.base;
  }
  // UE FName internal convention: stored number N → display suffix _(N-1).
  // (NAME_NO_NUMBER_INTERNAL = 0 means no suffix; 1 means _0, 2 means _1, …)
  return `${f.base}_${f.number - 1}`;
}

/** Case-insensitive lexical ordering similar to UE `FName` / `FString` sort for registry rows. */
export function fnameWireLexicalLess(a: FNameWire, b: FNameWire): boolean {
  const sa = fNameToString(a).toLowerCase();
  const sb = fNameToString(b).toLowerCase();
  return sa < sb;
}

/** UE `GetMutableAssetsSortedByObjectPath`: package (UTF-8 lower strcmp), asset `FName::Compare`, subpath. */
export function compareAssetsUeSaveOrder(a: LoadedAssetSortKey, b: LoadedAssetSortKey): number {
  const pa = a.packageNameUtf8Lower;
  const pb = b.packageNameUtf8Lower;
  if (pa < pb) {
    return -1;
  }
  if (pa > pb) {
    return 1;
  }
  const ac = compareFNameComparable(a.assetNameKey, b.assetNameKey);
  if (ac !== 0) {
    return ac;
  }
  const sa = a.subPathUtf8Lower ?? "";
  const sb = b.subPathUtf8Lower ?? "";
  if (sa < sb) {
    return -1;
  }
  if (sa > sb) {
    return 1;
  }
  return 0;
}

export interface LoadedAssetSortKey {
  packageNameUtf8Lower: string;
  /** Lowercase display string stand-in for `FName::Compare` when indices unknown. */
  assetNameKey: string;
  subPathUtf8Lower?: string;
}

function compareFNameComparable(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al < bl) {
    return -1;
  }
  if (al > bl) {
    return 1;
  }
  return 0;
}

export function buildAssetSortKey(
  packageName: FNameWire,
  assetName: FNameWire,
  subPathUtf8Lower?: string,
): LoadedAssetSortKey {
  return {
    packageNameUtf8Lower: utf8LowerAscii(fNameToString(packageName)),
    assetNameKey: fNameToString(assetName),
    subPathUtf8Lower: subPathUtf8Lower !== undefined ? utf8LowerAscii(subPathUtf8Lower) : undefined,
  };
}

function utf8LowerAscii(s: string): string {
  let o = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    o += c >= 0x41 && c <= 0x5a ? String.fromCodePoint(c + 32) : ch;
  }
  return o;
}
