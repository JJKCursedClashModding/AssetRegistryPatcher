import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  REPACK_AES_KEY,
  REPACK_RETOC_ENGINE_VERSION,
  REPACK_UNREALREZEN_ENGINE_VERSION,
  REPACK_IOSTORE_BASE,
  REPACK_REGISTRY_MOUNT_RELATIVE,
  REPAK_MOUNT_POINT,
  REPAK_VERSION,
} from "./repackConstants.js";

const INVALID_FILE_NAME_CHARS = /[<>:"|?*\u0000-\u001f]/;

export type RepackBackend = "retoc" | "unrealrezen";

/**
 * IoStore output basename (no path): `name.utoc`, `name.pak`.
 * Strips accidental `.utoc`/`.ucas`/`.pak` suffixes; same rules as `Pack-IoStoreFromFileList.ps1` Get-SafeIoStoreBaseName.
 */
export function parseRepackIoBase(name: string): string {
  let n = name.trim();
  if (!n.length) {
    throw new Error("repackName must not be empty");
  }
  for (const ext of [".utoc", ".ucas", ".pak"] as const) {
    if (n.length > ext.length && n.toLowerCase().endsWith(ext)) {
      n = n.slice(0, -ext.length);
      break;
    }
  }
  if (n.includes("/") || n.includes("\\")) {
    throw new Error("repackName must be a filename only (no path separators)");
  }
  if (n === "." || n === "..") {
    throw new Error(`Invalid repackName: ${JSON.stringify(n)}`);
  }
  if (INVALID_FILE_NAME_CHARS.test(n)) {
    throw new Error(`repackName contains invalid characters: ${JSON.stringify(n)}`);
  }
  return n;
}

function resolveRetocExe(cwd: string): string {
  const fromEnv = process.env.RETOC_EXE?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const bundled = path.join(cwd, "tools", "retoc", process.platform === "win32" ? "retoc.exe" : "retoc");
  if (existsSync(bundled)) {
    return bundled;
  }
  return "retoc";
}

function resolveReZenExe(cwd: string): string {
  const fromEnv = process.env.UNREALREZEN_EXE?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const bundled = path.join(
    cwd,
    "tools",
    "UnrealReZen",
    process.platform === "win32" ? "UnrealReZen.exe" : "UnrealReZen",
  );
  if (existsSync(bundled)) {
    return bundled;
  }
  return "UnrealReZen";
}

function resolveRepakExe(cwd: string): string {
  const fromEnv = process.env.REPAK_EXE?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const bundled = path.join(cwd, "tools", "repak", process.platform === "win32" ? "repak.exe" : "repak");
  if (existsSync(bundled)) {
    return bundled;
  }
  return "repak";
}

function assertIoStoreArtifacts(outDir: string, ioBase: string): void {
  const utocPath = path.join(outDir, `${ioBase}.utoc`);
  const ucasPath = path.join(outDir, `${ioBase}.ucas`);
  if (!existsSync(utocPath) || !existsSync(ucasPath)) {
    throw new Error(
      `Expected IoStore outputs missing after packer run (need ${ioBase}.utoc and ${ioBase}.ucas in ${outDir}).`,
    );
  }
}

export interface RepackZenResult {
  /** Absolute path to `<ioBase>.utoc` written by the IoStore packer. */
  utocPath: string;
  /** Absolute path to `<ioBase>.pak` from repak. */
  registryPakPath: string;
  /** Basename used for outputs (default `iostore`). */
  ioBase: string;
  /** Which tool produced `.utoc`/`.ucas`. */
  backend: RepackBackend;
}

function runRetocToZen(options: {
  cwd: string;
  stagingRoot: string;
  utocPath: string;
}): void {
  const { cwd, stagingRoot, utocPath } = options;
  const retocExe = resolveRetocExe(options.cwd);
  const retoc = spawnSync(
    retocExe,
    ["--aes-key", REPACK_AES_KEY, "to-zen", stagingRoot, utocPath, "--version", REPACK_RETOC_ENGINE_VERSION],
    { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (retoc.error) {
    throw retoc.error;
  }
  if (retoc.status !== 0) {
    throw new Error(`retoc to-zen failed (${retoc.status}): ${(retoc.stderr || retoc.stdout || "").trim()}`);
  }
}

/**
 * UnrealReZen walks every file under `content-path` and only packs paths that **already exist** in the
 * game's IoStore (`game-dir`). New package paths are skipped (`Skipping … not found in archives`), which
 * often produces no `.utoc`/`.ucas` or incomplete output. See upstream `Program.cs`.
 */
function runUnrealReZen(options: {
  cwd: string;
  stagingRoot: string;
  gamePaksDir: string;
  utocPath: string;
}): { stdout: string; stderr: string } {
  const { cwd, stagingRoot, gamePaksDir, utocPath } = options;
  const rezenExe = resolveReZenExe(cwd);
  const rezenArgs = [
    "--content-path",
    stagingRoot,
    "--compression-format",
    "Zlib",
    "--engine-version",
    REPACK_UNREALREZEN_ENGINE_VERSION,
    "--game-dir",
    gamePaksDir,
    "--output-path",
    utocPath,
  ];
  if (REPACK_AES_KEY.length) {
    rezenArgs.push("--aes-key", REPACK_AES_KEY);
  }
  const rezen = spawnSync(rezenExe, rezenArgs, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = (rezen.stdout || "").trim();
  const stderr = (rezen.stderr || "").trim();
  if (rezen.error) {
    throw rezen.error;
  }
  if (rezen.status !== 0) {
    throw new Error(`UnrealReZen failed (${rezen.status}): ${stderr || stdout}`);
  }
  return { stdout, stderr };
}

/**
 * Run `retoc to-zen` or `UnrealReZen` on the job staging tree, then `repak pack` with an `AssetRegistry.bin`
 * (merged registry or new-rows-only, depending on the job).
 * `ioBase` defaults to `iostore`.
 */
export function runRepackZen(options: {
  cwd: string;
  stagingRoot: string;
  backend: RepackBackend;
  /** Required when `backend` is `unrealrezen`. */
  gamePaksDir?: string;
  repackOutputDir: string;
  /** Absolute path to the `.bin` embedded in the registry `.pak`. */
  mergedRegistryPath: string;
  /** Output basename (e.g. `MyMod` → `MyMod.utoc`, `MyMod.pak`). */
  ioBase?: string;
}): RepackZenResult {
  const { cwd, stagingRoot, repackOutputDir, mergedRegistryPath, backend } = options;
  const ioBase = options.ioBase?.length ? parseRepackIoBase(options.ioBase) : REPACK_IOSTORE_BASE;
  const outDir = path.resolve(cwd, repackOutputDir);
  mkdirSync(outDir, { recursive: true });
  for (const ext of [".utoc", ".ucas", ".pak"] as const) {
    const p = path.join(outDir, ioBase + ext);
    if (existsSync(p)) {
      rmSync(p);
    }
  }
  const registryPakPath = path.join(outDir, `${ioBase}.pak`);

  const utocPath = path.join(outDir, `${ioBase}.utoc`);

  let unrealReZenLog = "";
  if (backend === "retoc") {
    runRetocToZen({ cwd, stagingRoot, utocPath });
  } else {
    const gamePaksDir = options.gamePaksDir;
    if (!gamePaksDir?.length) {
      throw new Error("repackBackend unrealrezen requires repackGamePaksPath");
    }
    const combined = runUnrealReZen({ cwd, stagingRoot, gamePaksDir, utocPath });
    unrealReZenLog = `${combined.stderr}\n${combined.stdout}`.trim();
  }

  try {
    assertIoStoreArtifacts(outDir, ioBase);
  } catch (e) {
    if (backend === "unrealrezen") {
      const hint =
        "UnrealReZen only includes files whose paths already exist in the game's IoStore. " +
        "Staging a **new** long package path (not in the shipped archives) is skipped, so no `.utoc`/`.ucas` is produced. " +
        'Use repackBackend \"retoc\" for loose→IoStore from staging, or replace an asset at an existing path.\n' +
        `UnrealReZen log (last 2000 chars): ${unrealReZenLog.slice(-2000)}`;
      throw new Error(e instanceof Error ? `${e.message}\n${hint}` : `${String(e)}\n${hint}`);
    }
    throw e;
  }

  const regPakStaging = mkdtempSync(path.join(os.tmpdir(), "jjku-regpak-"));
  try {
    const destBin = path.join(regPakStaging, ...REPACK_REGISTRY_MOUNT_RELATIVE.split("/"));
    mkdirSync(path.dirname(destBin), { recursive: true });
    copyFileSync(mergedRegistryPath, destBin);

    const repakExe = resolveRepakExe(cwd);
    if (existsSync(registryPakPath)) {
      rmSync(registryPakPath);
    }
    const rp = spawnSync(
      repakExe,
      ["pack", regPakStaging, registryPakPath, "--version", REPAK_VERSION, "--mount-point", REPAK_MOUNT_POINT],
      { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    if (rp.error) {
      throw rp.error;
    }
    if (rp.status !== 0) {
      throw new Error(`repak pack failed (${rp.status}): ${(rp.stderr || rp.stdout || "").trim()}`);
    }
  } finally {
    rmSync(regPakStaging, { recursive: true, force: true });
  }

  return { utocPath, registryPakPath, ioBase, backend };
}
