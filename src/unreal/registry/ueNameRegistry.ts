import { BinaryWriter } from "../io/binaryWriter.js";
import { NAME_NUMBERED_BIT } from "./constants.js";
import type { FNameWire } from "./fnameWire.js";
import { generateLowerCaseHashForNameBatchEntry } from "./nameHash.js";

function isWideName(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Name batch + `FAssetRegistryWriter::operator<<(FName&)` (display pooled once; numbered uses `0x80000000`).
 */
export class UeNameRegistry {
  private readonly bases: string[] = [];
  private readonly displayToIndex = new Map<string, number>();

  writeFName(w: BinaryWriter, f: FNameWire): void {
    let displayIdx = this.displayToIndex.get(f.base);
    if (displayIdx === undefined) {
      displayIdx = this.bases.length;
      this.bases.push(f.base);
      this.displayToIndex.set(f.base, displayIdx);
    }
    if (f.number !== 0) {
      w.writeU32(displayIdx | NAME_NUMBERED_BIT);
      w.writeU32(f.number >>> 0);
    } else {
      w.writeU32(displayIdx >>> 0);
    }
  }

  getDisplayEntriesInOrder(): readonly string[] {
    return this.bases;
  }

  appendNameBatchTo(w: BinaryWriter): void {
    const entries = this.bases;
    const num = entries.length;
    if (num === 0) {
      w.writeU32(0);
      return;
    }

    const hashes: bigint[] = [];
    const headers = Buffer.alloc(num * 2);
    const strChunks: Buffer[] = [];
    let strOff = 0;

    for (let i = 0; i < num; i++) {
      const s = entries[i]!;
      const wide = isWideName(s);
      const len = s.length;
      if (len >= 0x8000) {
        throw new Error(`Name too long for name batch: ${len}`);
      }
      hashes.push(generateLowerCaseHashForNameBatchEntry(s, wide));
      const b0 = (wide ? 0x80 : 0) | ((len >> 8) & 0x7f);
      const b1 = len & 0xff;
      headers.writeUInt8(b0, i * 2);
      headers.writeUInt8(b1, i * 2 + 1);

      if (wide) {
        const pad = strOff % 2;
        if (pad) {
          strChunks.push(Buffer.alloc(pad, 0));
          strOff += pad;
        }
        const u = Buffer.allocUnsafe(len * 2);
        for (let c = 0; c < len; c++) {
          u.writeUInt16LE(s.charCodeAt(c), c * 2);
        }
        strChunks.push(u);
        strOff += len * 2;
      } else {
        strChunks.push(Buffer.from(s, "latin1"));
        strOff += len;
      }
    }

    const stringsBuf = Buffer.concat(strChunks);
    const hashBuf = Buffer.alloc(num * 8);
    for (let i = 0; i < num; i++) {
      hashBuf.writeBigUInt64LE(hashes[i]!, i * 8);
    }

    w.writeU32(num >>> 0);
    w.writeU32(stringsBuf.length >>> 0);
    // Conservative compatibility: force runtime re-hash from serialized names.
    // UE `LoadNameBatch` ignores saved hashes when HashVersion != FNameHash::AlgorithmId.
    w.writeU64(0n);
    w.writeBytes(hashBuf);
    w.writeBytes(headers);
    w.writeBytes(stringsBuf);
  }
}
