import { BinaryReader } from "../io/binaryReader.js";
import { NAME_NUMBERED_BIT } from "./constants.js";
import type { FNameWire } from "./fnameWire.js";
import { fNameToString, plainFName } from "./fnameWire.js";

export interface NameTable {
  /** Display string per name-batch index (no numbered suffix). */
  entries: string[];
  /** FName hash algorithm id from file; `0n` forces re-hash on load when re-saving. */
  hashVersion?: bigint;
}

/**
 * UE `LoadNameBatch(FArchive)` layout: Num, NumStringBytes, HashVersion, then
 * contiguous [hashes uint64×N][headers 2×N][string bytes].
 */
export function loadNameBatch(r: BinaryReader): NameTable {
  const num = r.readU32();
  if (num === 0) {
    return { entries: [] };
  }
  const numStringBytes = r.readU32();
  const hashVersion = r.readU64();

  r.skip(num * 8);
  const headersBuf = r.readBytes(num * 2);
  const stringsBuf = r.readBytes(numStringBytes);

  const entries: string[] = [];
  let strOff = 0;
  for (let i = 0; i < num; i++) {
    const b0 = headersBuf.readUInt8(i * 2);
    const b1 = headersBuf.readUInt8(i * 2 + 1);
    const isUtf16 = (b0 & 0x80) !== 0;
    const len = ((b0 & 0x7f) << 8) | b1;

    if (isUtf16) {
      if (strOff % 2 !== 0) {
        strOff += 1;
      }
      const byteLen = len * 2;
      const slice = stringsBuf.subarray(strOff, strOff + byteLen);
      strOff += byteLen;
      entries.push(slice.toString("utf16le"));
    } else {
      const slice = stringsBuf.subarray(strOff, strOff + len);
      strOff += len;
      entries.push(slice.toString("latin1"));
    }
  }

  if (strOff !== stringsBuf.length) {
    throw new Error(
      `Name batch string blob length mismatch: consumed ${strOff}, expected ${stringsBuf.length}`,
    );
  }

  return { entries, hashVersion };
}

export function formatName(table: NameTable, index: number, number: number): string {
  if (index < 0 || index >= table.entries.length) {
    throw new Error(`FName index out of range: ${index} (have ${table.entries.length})`);
  }
  const base = table.entries[index];
  if (number === 0) {
    return base;
  }
  // UE FName internal convention: stored number N → display suffix _(N-1).
  return `${base}_${number - 1}`;
}

export function readFNameWire(r: BinaryReader, table: NameTable): FNameWire {
  let idx = r.readU32();
  let number = 0;
  if (idx & NAME_NUMBERED_BIT) {
    idx ^= NAME_NUMBERED_BIT;
    number = r.readU32();
  }
  if (idx < 0 || idx >= table.entries.length) {
    throw new Error(`FName index out of range: ${idx} (have ${table.entries.length})`);
  }
  return { base: table.entries[idx]!, number };
}

export function readFName(r: BinaryReader, table: NameTable): string {
  return fNameToString(readFNameWire(r, table));
}

/** `readFName` for contexts that expect `None` as empty string (soft path top). */
export function readFNameAllowNoneEmpty(r: BinaryReader, table: NameTable): FNameWire {
  const f = readFNameWire(r, table);
  if (f.base === "None" && f.number === 0) {
    return plainFName("");
  }
  return f;
}
