import { spawnSync } from "node:child_process";
import path from "node:path";
import type { JobFileV1 } from "../job/schema.js";

export interface UAssetGuiInvocation {
  exe: string;
  cwd: string;
  mappingsPath: string;
  ueVersionToken: string;
}

export function defaultInvocation(repoRoot: string): UAssetGuiInvocation {
  const exe =
    process.platform === "win32"
      ? path.resolve(repoRoot, "UAssetGUI.exe")
      : path.resolve(repoRoot, "UAssetGUI");
  return {
    exe,
    cwd: repoRoot,
    mappingsPath: path.resolve(repoRoot, "mappings.usmap"),
    ueVersionToken: "VER_UE5_1",
  };
}

/** Resolve CLI paths from a job; `cwd` is the directory used to resolve relative job paths (e.g. `process.cwd()`). */
export function invocationFromJob(job: JobFileV1, cwd: string): UAssetGuiInvocation {
  const defaultExe = process.platform === "win32" ? "UAssetGUI.exe" : "UAssetGUI";
  const exe = path.resolve(cwd, job.uassetGuiPath ?? defaultExe);
  const exeDir = path.dirname(exe);
  const mappingsPath = path.resolve(
    cwd,
    job.mappingsPath ?? path.join(exeDir, "mappings.usmap"),
  );
  return {
    exe,
    cwd: exeDir,
    mappingsPath,
    ueVersionToken: job.ueVersionToken ?? "VER_UE5_1",
  };
}

/** Export uasset → temp JSON (PLAN.md). */
export function runToJson(
  inv: UAssetGuiInvocation,
  sourceUasset: string,
  tempJson: string,
): void {
  const args = ["tojson", sourceUasset, tempJson, inv.ueVersionToken, inv.mappingsPath];
  const r = spawnSync(inv.exe, args, { cwd: inv.cwd, encoding: "utf8" });
  if (r.error) {
    throw r.error;
  }
  if (r.status !== 0) {
    throw new Error(
      `UAssetGUI tojson failed (${r.status}): ${r.stderr || r.stdout || ""}`.trim(),
    );
  }
}

/** Import edited JSON → destination asset (same extension as source). */
export function runFromJson(inv: UAssetGuiInvocation, tempJson: string, destAsset: string): void {
  const args = ["fromjson", tempJson, destAsset, inv.mappingsPath];
  const r = spawnSync(inv.exe, args, { cwd: inv.cwd, encoding: "utf8" });
  if (r.error) {
    throw r.error;
  }
  if (r.status !== 0) {
    throw new Error(
      `UAssetGUI fromjson failed (${r.status}): ${r.stderr || r.stdout || ""}`.trim(),
    );
  }
}
