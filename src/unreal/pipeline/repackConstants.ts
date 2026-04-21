/** Same defaults as `Pack-IoStoreFromFileList.ps1` (UnrealReZen / repak). */

export const REPACK_AES_KEY =
  "0xBABFB8ACBA15424956C49B4E6CE9CFA43D5924D0B82FFDF8B6D5D70BE4F9DC82";

/** UnrealReZen expects GAME_* tokens (e.g. GAME_UE5_1). */
export const REPACK_UNREALREZEN_ENGINE_VERSION = "GAME_UE5_1";

/** retoc `to-zen --version` token (see Pack-IoStoreFromFileList.ps1). */
export const REPACK_RETOC_ENGINE_VERSION = "UE5_1";

export const REPACK_IOSTORE_BASE = "iostore";

/** Path inside the registry `.pak` (mount-relative; matches pack script default). */
export const REPACK_REGISTRY_MOUNT_RELATIVE = "Jujutsu Kaisen CC/AssetRegistry.bin";

export const REPAK_VERSION = "V11";

export const REPAK_MOUNT_POINT = "../../../";
