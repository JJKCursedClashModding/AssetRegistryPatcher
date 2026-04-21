/**
 * Job file shape from PLAN.md (strict JSON).
 */

import { parseRepackIoBase } from "../pipeline/repackZen.js";
import type { ContentSegmentOptions } from "./contentPath.js";

/**
 * Optional registry row template from the job JSON. **Not** used for identity:
 * `packagePath`, `packageName`, and `assetName` are always derived from the staged asset path.
 * Other fields fill in where UAssetGUI JSON hints do not (e.g. `assetClassPath`, `packageFlags`, cooked tags).
 * Tag maps are merged (see `mergeAssetDataTags`): input-registry row for the **source** path → `base` → JSON hints (later wins).
 */
export interface RegistryRowBase {
  assetClassPath?: string;
  packageFlags?: number;
  chunkIds?: number[];
  tags?: Record<string, string>;
  /** Job JSON uses plain strings; converted to wire form when building registry rows. */
  bundles?: Array<{ bundleName: string; paths: string[] }>;
}

/**
 * `base` on a job entry: either a **path key** (same POSIX path rules as `assetPath` under `packageRoot`)
 * to copy an existing row from `registryInputPath`, or an inline {@link RegistryRowBase}.
 */
export type JobRegistryBase = string | RegistryRowBase;

/** One `replace` row: literal by default, or regex when `pattern` is `RegExp` or `regex: true`. */
export interface JobReplaceEntry {
  pattern: string | RegExp;
  value: string;
  /** JSON jobs: treat string `pattern` as a RegExp source (replacement is `value`, with `$1`, `$&`, …). */
  regex?: boolean;
  flags?: string;
}

/**
 * After `replace`, the export is `JSON.parse`d and each function runs in order.
 * Mutate `json` in place. TypeScript jobs only — JSON jobs must omit `setField` or use `[]`.
 */
export type JobSetFieldFn = (json: unknown) => void;

/**
 * `filesToPack` entry: plain path string, or `{ path, base? }` for directory/file plus optional row template.
 * If `base` is omitted on the object form, each resolved `.uasset` uses **its own path** as the registry key.
 */
export type FileToPackItem = string | { path: string; base?: JobRegistryBase };

export function assertJobRegistryBase(raw: unknown, ctx: string): void {
  if (raw === undefined) {
    return;
  }
  if (typeof raw === "string") {
    if (!raw.length) {
      throw new Error(`${ctx} path key must be a non-empty string`);
    }
    const x = raw.toLowerCase();
    if (!x.endsWith(".uasset") && !x.endsWith(".umap")) {
      throw new Error(`${ctx} path key must end with .uasset or .umap: ${raw}`);
    }
    return;
  }
  assertRegistryRowBase(raw, ctx);
}

export function assertRegistryRowBase(raw: unknown, ctx: string): RegistryRowBase {
  if (raw === undefined) {
    return {};
  }
  if (raw === null || typeof raw !== "object") {
    throw new Error(`${ctx} must be an object when provided`);
  }
  const o = raw as Record<string, unknown>;
  const out: RegistryRowBase = {};
  if (o.assetClassPath !== undefined) {
    if (typeof o.assetClassPath !== "string" || !o.assetClassPath.length) {
      throw new Error(`${ctx}.assetClassPath must be a non-empty string when set`);
    }
    out.assetClassPath = o.assetClassPath;
  }
  if (o.packageFlags !== undefined) {
    if (typeof o.packageFlags !== "number" || !Number.isInteger(o.packageFlags)) {
      throw new Error(`${ctx}.packageFlags must be an integer when set`);
    }
    out.packageFlags = o.packageFlags;
  }
  if (o.chunkIds !== undefined) {
    if (!Array.isArray(o.chunkIds)) {
      throw new Error(`${ctx}.chunkIds must be an array when set`);
    }
    const ids: number[] = [];
    for (let j = 0; j < o.chunkIds.length; j++) {
      const v = o.chunkIds[j];
      if (typeof v !== "number" || !Number.isInteger(v)) {
        throw new Error(`${ctx}.chunkIds[${j}] must be an integer`);
      }
      ids.push(v);
    }
    out.chunkIds = ids;
  }
  if (o.tags !== undefined) {
    if (o.tags === null || typeof o.tags !== "object") {
      throw new Error(`${ctx}.tags must be an object when set`);
    }
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.tags as Record<string, unknown>)) {
      if (typeof v !== "string") {
        throw new Error(`${ctx}.tags[${JSON.stringify(k)}] must be a string`);
      }
      tags[k] = v;
    }
    out.tags = tags;
  }
  if (o.bundles !== undefined) {
    if (!Array.isArray(o.bundles)) {
      throw new Error(`${ctx}.bundles must be an array when set`);
    }
    const bundles: Array<{ bundleName: string; paths: string[] }> = [];
    for (let j = 0; j < o.bundles.length; j++) {
      const b = o.bundles[j];
      if (!b || typeof b !== "object") {
        throw new Error(`${ctx}.bundles[${j}] must be an object`);
      }
      const bb = b as Record<string, unknown>;
      if (typeof bb.bundleName !== "string" || !bb.bundleName.length) {
        throw new Error(`${ctx}.bundles[${j}].bundleName must be a non-empty string`);
      }
      if (!Array.isArray(bb.paths)) {
        throw new Error(`${ctx}.bundles[${j}].paths must be an array`);
      }
      const paths: string[] = [];
      for (let k = 0; k < bb.paths.length; k++) {
        const p = bb.paths[k];
        if (typeof p !== "string") {
          throw new Error(`${ctx}.bundles[${j}].paths[${k}] must be a string`);
        }
        paths.push(p);
      }
      bundles.push({ bundleName: bb.bundleName, paths });
    }
    out.bundles = bundles;
  }
  return out;
}

export interface JobFileV1 {
  packageRoot: string;
  stagingRoot: string;
  contentMount?: string;
  /**
   * Folder name to locate in `assetPath` before deriving the path under `contentMount`.
   * Default when omitted: `"Content"`.
   */
  contentSegment?: string;
  /**
   * If true (default), `contentSegment` is matched case-sensitively against each path component.
   */
  contentSegmentMatchCase?: boolean;
  registryInputPath: string;
  registryOutputPath: string;
  /** If true, infer `CookTagsAsName` / `CookTagsAsPath` from `registryInputPath` and ignore manual lists. */
  inferCookTags?: boolean;
  /** Optional explicit override list for UE `CookTagsAsName` (ignored when `inferCookTags` is true). */
  cookTagsAsName?: string[];
  /** Optional explicit override list for UE `CookTagsAsPath` (ignored when `inferCookTags` is true). */
  cookTagsAsPath?: string[];
  /** Optional second output: registry containing only rows staged by this job (no input/base rows). */
  registryNewRowsOnlyOutputPath?: string;
  /**
   * When `repack` is true: if **true**, pack `registryNewRowsOnlyOutputPath` into the registry `.pak`;
   * if **false** or omitted, pack the merged `registryOutputPath` (default).
   * Requires `registryNewRowsOnlyOutputPath` when set to true.
   */
  newRowsOnlyInRegistry?: boolean;
  /**
   * When true, after staging + registry merge, run `UnrealReZen` and `repak pack`.
   * Requires `repackOutputPath` and `repackGamePaksPath`.
   */
  repack?: boolean;
  /** Directory for IoStore outputs when `repack` is true (see `repackName`). */
  repackOutputPath?: string;
  /** Game `Content/Paks` folder used by UnrealReZen for base IoStore metadata. */
  repackGamePaksPath?: string;
  /**
   * IoStore packer: `retoc` converts loose staged files to `.utoc`/`.ucas` without requiring a base game path.
   * `unrealrezen` patches against existing IoStore paths in `repackGamePaksPath` — **new** paths not present in the game archives are skipped and may yield no output.
   * Default: `retoc`.
   */
  repackBackend?: "retoc" | "unrealrezen";
  /**
   * Optional output basename when `repack` is true (default `iostore`).
   * Writes `<name>.utoc` / companions and `<name>.pak`.
   */
  repackName?: string;
  /**
   * When `repack` is true: after IoStore + registry `.pak` are written, copy `.utoc`, `.ucas`, and that `.pak`
   * into this directory (created if needed). Paths are relative to the job working directory.
   */
  copyOnCompletePath?: string;
  uassetGuiPath?: string;
  mappingsPath?: string;
  ueVersionToken?: string;
  filesToEdit: Array<{
    /** Source `.uasset` / `.umap` under `packageRoot`. */
    assetPath: string;
    /**
     * Optional path under `stagingRoot` for the edited asset (same rules as `assetPath`).
     * If omitted, the output is written to `stagingRoot` + `assetPath` (mirror of source).
     */
    outputAssetPath?: string;
    method: "replace";
    replace: JobReplaceEntry[];
    /**
     * After `replace`, parse JSON and run each function with the parsed value (mutate in place).
     * TypeScript jobs only; JSON jobs must omit or use `[]`.
     */
    setField?: JobSetFieldFn[];
    /**
     * Defaults not supplied by UAssetGUI JSON hints: inline object, or a **path key** (like `assetPath`)
     * whose row is read from `registryInputPath`. If omitted, **`assetPath`** is used as the key.
     */
    base?: JobRegistryBase;
  }>;
  filesToPack: FileToPackItem[];
}

export function assertJobShape(raw: unknown): asserts raw is JobFileV1 {
  if (!raw || typeof raw !== "object") {
    throw new Error("Job file must be an object");
  }
  const j = raw as Record<string, unknown>;
  for (const key of [
    "packageRoot",
    "stagingRoot",
    "registryInputPath",
    "registryOutputPath",
  ] as const) {
    if (typeof j[key] !== "string" || !(j[key] as string).length) {
      throw new Error(`Job.${key} must be a non-empty string`);
    }
  }
  if (j.registryNewRowsOnlyOutputPath !== undefined) {
    if (
      typeof j.registryNewRowsOnlyOutputPath !== "string" ||
      !j.registryNewRowsOnlyOutputPath.length
    ) {
      throw new Error("Job.registryNewRowsOnlyOutputPath, if set, must be a non-empty string");
    }
  }
  if (j.newRowsOnlyInRegistry !== undefined && typeof j.newRowsOnlyInRegistry !== "boolean") {
    throw new Error("Job.newRowsOnlyInRegistry, if set, must be a boolean");
  }
  if (j.newRowsOnlyInRegistry === true) {
    if (
      typeof j.registryNewRowsOnlyOutputPath !== "string" ||
      !j.registryNewRowsOnlyOutputPath.length
    ) {
      throw new Error(
        "Job.newRowsOnlyInRegistry requires registryNewRowsOnlyOutputPath to be set",
      );
    }
  }
  if (j.inferCookTags !== undefined && typeof j.inferCookTags !== "boolean") {
    throw new Error("Job.inferCookTags, if set, must be a boolean");
  }
  const assertStringArray = (v: unknown, key: "cookTagsAsName" | "cookTagsAsPath") => {
    if (v === undefined) {
      return;
    }
    if (!Array.isArray(v)) {
      throw new Error(`Job.${key}, if set, must be an array of strings`);
    }
    for (let i = 0; i < v.length; i++) {
      if (typeof v[i] !== "string" || !(v[i] as string).length) {
        throw new Error(`Job.${key}[${i}] must be a non-empty string`);
      }
    }
  };
  assertStringArray(j.cookTagsAsName, "cookTagsAsName");
  assertStringArray(j.cookTagsAsPath, "cookTagsAsPath");
  if (j.contentSegment !== undefined) {
    if (typeof j.contentSegment !== "string" || !j.contentSegment.length) {
      throw new Error("Job.contentSegment, if set, must be a non-empty string");
    }
    if (j.contentSegment.includes("/")) {
      throw new Error("Job.contentSegment must not contain '/'");
    }
  }
  if (
    j.contentSegmentMatchCase !== undefined &&
    typeof j.contentSegmentMatchCase !== "boolean"
  ) {
    throw new Error("Job.contentSegmentMatchCase, if set, must be a boolean");
  }
  if (j.repack !== undefined && typeof j.repack !== "boolean") {
    throw new Error("Job.repack, if set, must be a boolean");
  }
  if (j.repackBackend !== undefined) {
    if (j.repackBackend !== "retoc" && j.repackBackend !== "unrealrezen") {
      throw new Error('Job.repackBackend, if set, must be "retoc" or "unrealrezen"');
    }
  }
  if (j.repack === true) {
    if (typeof j.repackOutputPath !== "string" || !j.repackOutputPath.length) {
      throw new Error("Job.repackOutputPath must be a non-empty string when repack is true");
    }
    const backend = j.repackBackend ?? "retoc";
    if (backend === "unrealrezen") {
      if (typeof j.repackGamePaksPath !== "string" || !j.repackGamePaksPath.length) {
        throw new Error(
          "Job.repackGamePaksPath must be a non-empty string when repack is true and repackBackend is unrealrezen",
        );
      }
    }
  }
  if (j.repackName !== undefined) {
    if (typeof j.repackName !== "string") {
      throw new Error("Job.repackName, if set, must be a string");
    }
    try {
      parseRepackIoBase(j.repackName);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Job.repackName: ${msg}`);
    }
  }
  if (j.copyOnCompletePath !== undefined) {
    if (typeof j.copyOnCompletePath !== "string" || !j.copyOnCompletePath.length) {
      throw new Error("Job.copyOnCompletePath, if set, must be a non-empty string");
    }
    if (j.repack !== true) {
      throw new Error("Job.copyOnCompletePath requires repack: true");
    }
  }
  if (!Array.isArray(j.filesToEdit) || !Array.isArray(j.filesToPack)) {
    throw new Error("Job.filesToEdit and Job.filesToPack must be arrays");
  }
  for (let i = 0; i < j.filesToEdit.length; i++) {
    const e = j.filesToEdit[i];
    if (!e || typeof e !== "object") {
      throw new Error(`Job.filesToEdit[${i}] must be an object`);
    }
    const o = e as Record<string, unknown>;
    if (typeof o.assetPath !== "string" || !o.assetPath.length) {
      throw new Error(`Job.filesToEdit[${i}].assetPath must be a non-empty string`);
    }
    if (o.method !== "replace") {
      throw new Error(`Job.filesToEdit[${i}].method must be "replace"`);
    }
    if (!Array.isArray(o.replace)) {
      throw new Error(`Job.filesToEdit[${i}].replace must be an array`);
    }
    for (let j = 0; j < o.replace.length; j++) {
      const r = o.replace[j];
      if (!r || typeof r !== "object") {
        throw new Error(`Job.filesToEdit[${i}].replace[${j}] must be an object`);
      }
      const ro = r as Record<string, unknown>;
      if (ro.pattern instanceof RegExp) {
        if (typeof ro.value !== "string") {
          throw new Error(`Job.filesToEdit[${i}].replace[${j}].value must be a string`);
        }
        continue;
      }
      if (typeof ro.pattern !== "string") {
        throw new Error(
          `Job.filesToEdit[${i}].replace[${j}].pattern must be a string or RegExp (TS jobs)`,
        );
      }
      if (typeof ro.value !== "string") {
        throw new Error(`Job.filesToEdit[${i}].replace[${j}].value must be a string`);
      }
      if (ro.regex !== undefined && typeof ro.regex !== "boolean") {
        throw new Error(`Job.filesToEdit[${i}].replace[${j}].regex must be a boolean when set`);
      }
      if (ro.flags !== undefined && typeof ro.flags !== "string") {
        throw new Error(`Job.filesToEdit[${i}].replace[${j}].flags must be a string when set`);
      }
      if (ro.regex === true) {
        if (ro.pattern.length === 0) {
          throw new Error(`Job.filesToEdit[${i}].replace[${j}].pattern must not be empty when regex is true`);
        }
        const f = (ro.flags as string | undefined) ?? "g";
        const withG = f.includes("g") ? f : `${f}g`;
        try {
          new RegExp(ro.pattern, withG);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(`Job.filesToEdit[${i}].replace[${j}]: invalid regex: ${msg}`);
        }
      }
    }
    if (o.setField !== undefined) {
      if (!Array.isArray(o.setField)) {
        throw new Error(`Job.filesToEdit[${i}].setField must be an array`);
      }
      for (let k = 0; k < o.setField.length; k++) {
        const sf = o.setField[k];
        if (typeof sf !== "function") {
          throw new Error(
            `Job.filesToEdit[${i}].setField[${k}] must be a function (json) => void — use a TypeScript job, or omit setField / use [] in JSON`,
          );
        }
      }
    }
    if (o.outputAssetPath !== undefined) {
      if (typeof o.outputAssetPath !== "string" || !o.outputAssetPath.length) {
        throw new Error(`Job.filesToEdit[${i}].outputAssetPath, if set, must be a non-empty string`);
      }
    }
    if (o.base !== undefined) {
      assertJobRegistryBase(o.base, `Job.filesToEdit[${i}].base`);
    }
  }
  for (let i = 0; i < j.filesToPack.length; i++) {
    const p = j.filesToPack[i];
    if (typeof p === "string") {
      if (!p.length) {
        throw new Error(`Job.filesToPack[${i}] must be a non-empty string`);
      }
    } else if (p && typeof p === "object") {
      const po = p as Record<string, unknown>;
      if (typeof po.path !== "string" || !po.path.length) {
        throw new Error(`Job.filesToPack[${i}].path must be a non-empty string`);
      }
      if (po.base !== undefined) {
        assertJobRegistryBase(po.base, `Job.filesToPack[${i}].base`);
      }
    } else {
      throw new Error(
        `Job.filesToPack[${i}] must be a non-empty string or an object { path, base? }`,
      );
    }
  }
}

/** Defaults aligned with PLAN.md */
export function resolvedContentOptions(job: JobFileV1): ContentSegmentOptions {
  return {
    contentSegment: job.contentSegment ?? "Content",
    contentSegmentMatchCase: job.contentSegmentMatchCase ?? true,
  };
}

export function resolvedContentMount(job: JobFileV1): string {
  return job.contentMount ?? "/Game";
}
