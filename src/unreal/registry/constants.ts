/** FAssetRegistryVersion::GUID — four uint32 little-endian dwords. */
export const ASSET_REGISTRY_GUID = Buffer.from([
  0xe7, 0x9e, 0x7f, 0x71, 0x3a, 0x49, 0xb0, 0xe9, 0x32, 0x91, 0xb3, 0x88, 0x07, 0x81, 0x38, 0x1b,
]);

/** PLAN: only this serialized version is supported (enum value AddedHeader in UE 5.x). */
export const SUPPORTED_REGISTRY_VERSION = 16;

export const FIXED_TAG_BEGIN_MAGIC = 0x12345679;
export const FIXED_TAG_END_MAGIC = 0x87654321;

export const NAME_NUMBERED_BIT = 0x80000000;

/** FAssetRegistryVersion::MarshalledTextAsUTF8String — store uses FString below this. */
export const MARSHALLED_TEXT_UTF8_ENUM = 19;

/** FAssetRegistryVersion::ClassPaths */
export const CLASS_PATHS_ENUM = 14;

/** FAssetRegistryVersion::AssetPackageDataHasPackageLocation — LoadStore template cutoff */
export const ASSET_PACKAGE_DATA_HAS_PACKAGE_LOCATION_ENUM = 18;
