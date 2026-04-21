import { cityHash64 } from "../hash/cityHash64.js";

/** `FNameHash::AlgorithmId` in UnrealNames.cpp */
export const FNAME_HASH_ALGORITHM_ID = 0xc1640000n;

function toLowerAsciiChar(c: number): number {
  return c >= 0x41 && c <= 0x5a ? c + 32 : c;
}

/** `GenerateLowerCaseHash` for ANSICHAR buffers (matches UE name batch). */
export function generateLowerCaseHashAnsiBytes(buf: Buffer): bigint {
  const lower = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) {
    lower[i] = toLowerAsciiChar(buf[i]!);
  }
  return cityHash64(lower);
}

/** Wide = UTF-16 LE code units; each unit lowercased like `TChar<WIDECHAR>::ToLower` for BMP. */
export function generateLowerCaseHashWideCodeUnits(units: Uint16Array): bigint {
  const lower = Buffer.allocUnsafe(units.length * 2);
  for (let i = 0; i < units.length; i++) {
    let c = units[i]!;
    if (c >= 0x41 && c <= 0x5a) {
      c += 32;
    }
    lower.writeUInt16LE(c, i * 2);
  }
  return cityHash64(lower);
}

export function generateLowerCaseHashForNameBatchEntry(display: string, isWide: boolean): bigint {
  if (isWide) {
    const units = new Uint16Array(display.length);
    for (let i = 0; i < display.length; i++) {
      units[i] = display.charCodeAt(i);
    }
    return generateLowerCaseHashWideCodeUnits(units);
  }
  return generateLowerCaseHashAnsiBytes(Buffer.from(display, "latin1"));
}
