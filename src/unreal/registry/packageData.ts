import { BinaryReader } from "../io/binaryReader.js";
import { readFName, type NameTable } from "./nameBatch.js";

/** FAssetRegistryVersion::AddedChunkHashes through AddedHeader (v16) package row layout. */
export function skipAssetPackageDataV16(r: BinaryReader, table: NameTable): void {
  r.readI64();
  r.skip(16);
  const cookedValid = r.readU8() !== 0;
  if (cookedValid) {
    r.skip(16);
  }
  const nChunks = r.readI32();
  r.skip(nChunks * (12 + 20));
  r.readI32();
  r.readI32();
  r.readI32();
  r.readU32();
  const nCustom = r.readI32();
  for (let i = 0; i < nCustom; i++) {
    r.skip(16);
    r.readI32();
  }
  const nImported = r.readI32();
  for (let i = 0; i < nImported; i++) {
    readFName(r, table);
  }
}
