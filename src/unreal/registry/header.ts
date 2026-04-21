import { BinaryReader } from "../io/binaryReader.js";
import { BinaryWriter } from "../io/binaryWriter.js";
import { ASSET_REGISTRY_GUID, SUPPORTED_REGISTRY_VERSION } from "./constants.js";

export interface AssetRegistryHeader {
  version: number;
  bFilterEditorOnlyData: boolean;
}

export function readAndValidateHeader(r: BinaryReader): AssetRegistryHeader {
  const guid = r.readBytes(16);
  if (!guid.equals(ASSET_REGISTRY_GUID)) {
    throw new Error(
      "Unsupported AssetRegistry.bin GUID (expected FAssetRegistryVersion::GUID 717F9EE7-E9B0493A-88B39132-1B388107)",
    );
  }
  const version = r.readI32();
  if (version !== SUPPORTED_REGISTRY_VERSION) {
    throw new Error(
      `Unsupported FAssetRegistryVersion ${version}; this tool only supports version ${SUPPORTED_REGISTRY_VERSION} (see PLAN.md).`,
    );
  }
  const bFilterEditorOnlyData = r.readI32() !== 0;
  if (!bFilterEditorOnlyData) {
    throw new Error("Expected bFilterEditorOnlyData === true for supported registry (PLAN.md).");
  }
  return { version, bFilterEditorOnlyData };
}

export function writeHeader(w: BinaryWriter, h: AssetRegistryHeader): void {
  w.writeBytes(Buffer.from(ASSET_REGISTRY_GUID));
  w.writeI32(h.version);
  w.writeI32(h.bFilterEditorOnlyData ? 1 : 0);
}
