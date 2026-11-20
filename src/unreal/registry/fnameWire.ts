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

function lowerAsciiUnit(c: number): number {
  return c >= 0x41 && c <= 0x5a ? c + 32 : c;
}

/** `FCString::Strnicmp` over the shorter length, then length (`CompareDifferentIdsAlphabetically`). */
function compareNameStringsCI(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = lowerAsciiUnit(a.charCodeAt(i)) - lowerAsciiUnit(b.charCodeAt(i));
    if (d !== 0) {
      return d;
    }
  }
  return a.length - b.length;
}

/**
 * UE `FName::Compare` (UnrealNames.cpp): different bases compare by base string only
 * (case-insensitive, number ignored); equal bases compare by number. So
 * ("/X/SK_CN_050", 11) — displayed "SK_CN_050_10" — sorts before "/X/SK_CN_050_00",
 * which a plain display-string sort gets backwards.
 */
export function compareFNameWire(a: FNameWire, b: FNameWire): number {
  return compareNameStringsCI(a.base, b.base) || a.number - b.number;
}

/** `FName::LexicalLess`. */
export function fnameWireLexicalLess(a: FNameWire, b: FNameWire): boolean {
  return compareFNameWire(a, b) < 0;
}

/**
 * UE `FAssetRegistryState::Save` asset order: `FSoftObjectPath::LexicalLess`, i.e.
 * `FTopLevelAssetPath::Compare` (package `FName::Compare`, then asset `FName::Compare`).
 */
export function compareAssetsUeSaveOrder(
  a: { packageName: FNameWire; assetName: FNameWire },
  b: { packageName: FNameWire; assetName: FNameWire },
): number {
  return compareFNameWire(a.packageName, b.packageName) || compareFNameWire(a.assetName, b.assetName);
}
