#!/usr/bin/env node
// @aliou/pi-patches manifest sync.
//
// `manifest.json` is the source of truth: it lists, per package, the
// ordered patch files to apply. Entries may be either a patch directory name
// (using `<dir>/patch.diff`) or `{ "name": "<label>", "dir": "<dir>", "patch": "<file>" }`
// for shared directories that contain package-specific diffs. pnpm cannot express that — its
// pnpm's `patchedDependencies` map takes exactly one patch file per
// `package@version` — so this script flattens each package's patches, in
// manifest order, into a single generated diff under `combined/` and
// points `patchedDependencies` at it.
//
// Consumers:
//   - pnpm (`pnpm install`) applies the generated combined diff.
//   - Nix (`pkgs/pi-cli-patched`) reads the manifest and applies each patch in
//     succession, so a failure names the individual patch.
//
// Because patches for one package are concatenated, two patches for the same
// package must not touch the same file. This script rejects that.
//
// Usage:
//   node scripts/sync-patches.mjs           # regenerate combined diffs + package.json
//   node scripts/sync-patches.mjs --check   # fail if anything is out of date

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from this file, not the cwd, so running the script by absolute path
// from another checkout cannot rewrite or delete that checkout's patches.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_FILE = path.join(REPO_ROOT, "manifest.json");
const PKG_FILE = path.join(REPO_ROOT, "package.json");
const WORKSPACE_FILE = path.join(REPO_ROOT, "pnpm-workspace.yaml");
const COMBINED_DIR = path.join(REPO_ROOT, "combined");
const COMBINED_REL = "combined";

const check = process.argv.includes("--check");
const problems = [];
const fail = (message) => problems.push(message);

const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
const pkg = JSON.parse(readFileSync(PKG_FILE, "utf8"));
const packages = Object.entries(manifest).filter(([key]) => !key.startsWith("//"));

/**
 * Hunk ranges a unified diff touches, grouped by target file.
 *
 * Only a `+++` immediately preceded by a `---` is a file header; payload lines
 * can legitimately start with `+++ `. Both sides are recorded so a rename still
 * conflicts with a patch that edits either pathname, and `/dev/null` is ignored.
 *
 * Ranges use old-file coordinates because each patch diff is authored against
 * the published package output. Pure insertions have length 0 in unified diff
 * headers; treat them as a one-line point interval so two patches inserting at
 * the same point conflict, while edits elsewhere in the same file can coexist.
 */
function hunkTargetsOf(diff) {
  const clean = (header) => header.slice(4).trim().split("\t")[0].replace(/^[ab]\//, "");
  const lines = diff.split("\n");
  const targets = new Map();
  let currentTargets = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i].startsWith("--- ") && lines[i + 1].startsWith("+++ ")) {
      currentTargets = [clean(lines[i]), clean(lines[i + 1])].filter((side) => side !== "/dev/null");
      for (const target of currentTargets) {
        if (!targets.has(target)) targets.set(target, []);
      }
      i++;
      continue;
    }

    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(lines[i]);
    if (!hunk || currentTargets.length === 0) continue;
    const start = Number(hunk[1]);
    const length = Number(hunk[2] ?? "1");
    const end = length === 0 ? start : start + length - 1;
    for (const target of currentTargets) {
      targets.get(target).push({ start, end });
    }
  }
  return targets;
}

function overlaps(a, b) {
  return a.start <= b.end && b.start <= a.end;
}

/** Every patch dir on disk, so orphans (present but unlisted) are caught. */
const dirsOnDisk = new Set(
  readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((e) => {
      if (!e.isDirectory()) return false;
      const dir = path.join(REPO_ROOT, e.name);
      return existsSync(path.join(dir, "patch.diff")) || readdirSync(dir).some((name) => name.endsWith(".patch.diff"));
    })
    .map((e) => e.name),
);

const combined = new Map();
const patchedDependencies = {};

function normalizePatchEntry(pkgName, entry) {
  if (typeof entry === "string") {
    return { label: entry, dir: entry, patch: "patch.diff" };
  }
  if (!entry || typeof entry !== "object" || typeof entry.dir !== "string" || typeof entry.patch !== "string") {
    fail(`${pkgName}: manifest entries must be strings or { "dir": string, "patch": string, "name"?: string } objects`);
    return undefined;
  }
  if (entry.name !== undefined && typeof entry.name !== "string") {
    fail(`${pkgName}: manifest patch entry name must be a string when set`);
    return undefined;
  }
  if (path.isAbsolute(entry.dir) || path.isAbsolute(entry.patch) || entry.patch.includes("..") || entry.dir.includes("..")) {
    fail(`${pkgName}: invalid patch entry ${JSON.stringify(entry)}`);
    return undefined;
  }
  return { label: entry.name ?? `${entry.dir}/${entry.patch}`, dir: entry.dir, patch: entry.patch };
}

function workspaceYaml(patched) {
  const lines = ["packages: []", "", "allowBuilds:", "  '@google/genai': false", "  protobufjs: false", "", "patchedDependencies:"];
  for (const [key, value] of Object.entries(patched)) {
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

for (const [pkgName, dirs] of packages) {
  const version = pkg.dependencies?.[pkgName];
  if (!version) {
    fail(`${pkgName}: listed in manifest.json but not in package.json dependencies`);
    continue;
  }

  const seenTargets = new Map();
  const parts = [];
  for (const rawEntry of dirs) {
    const entry = normalizePatchEntry(pkgName, rawEntry);
    if (!entry) continue;
    const file = path.join(REPO_ROOT, entry.dir, entry.patch);
    if (!existsSync(file)) {
      fail(`${pkgName}: ${entry.label} is missing`);
      continue;
    }
    dirsOnDisk.delete(entry.dir);

    const diff = readFileSync(file, "utf8");
    for (const [target, ranges] of hunkTargetsOf(diff)) {
      const seenRanges = seenTargets.get(target) ?? [];
      for (const range of ranges) {
        const owner = seenRanges.find((seen) => overlaps(seen, range));
        if (owner) {
          fail(
            `${pkgName}: ${entry.label} hunk ${target}:${range.start}-${range.end} overlaps ${owner.label} hunk ${target}:${owner.start}-${owner.end}`,
          );
        }
      }
      seenRanges.push(...ranges.map((range) => ({ ...range, label: entry.label })));
      seenTargets.set(target, seenRanges);
    }
    parts.push(`# ${entry.label}\n${diff.endsWith("\n") ? diff : `${diff}\n`}`);
  }

  const slug = pkgName.replace(/^@[^/]+\//, "");
  const rel = `${COMBINED_REL}/${slug}.diff`;
  combined.set(rel, `# Generated by scripts/sync-patches.mjs from manifest.json. Do not edit.\n${parts.join("")}`);
  patchedDependencies[`${pkgName}@${version}`] = rel;
}

for (const orphan of dirsOnDisk) {
  fail(`${orphan}/patch.diff exists but is not listed in manifest.json`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`error: ${problem}`);
  process.exit(1);
}

if (check) {
  let stale = 0;
  for (const [rel, content] of combined) {
    const file = path.join(REPO_ROOT, rel);
    if (!existsSync(file) || readFileSync(file, "utf8") !== content) {
      console.error(`error: ${rel} is out of date`);
      stale++;
    }
  }
  const expectedWorkspace = workspaceYaml(patchedDependencies);
  if (!existsSync(WORKSPACE_FILE) || readFileSync(WORKSPACE_FILE, "utf8") !== expectedWorkspace) {
    console.error("error: pnpm-workspace.yaml patchedDependencies is out of date");
    stale++;
  }
  if (stale > 0) {
    console.error("\nrun `pnpm patches:sync` and commit the package.json result");
    process.exit(1);
  }
  console.log("patches are in sync");
  process.exit(0);
}

rmSync(COMBINED_DIR, { recursive: true, force: true });
mkdirSync(COMBINED_DIR, { recursive: true });
for (const [rel, content] of combined) {
  writeFileSync(path.join(REPO_ROOT, rel), content);
  console.log(`wrote ${rel}`);
}

writeFileSync(WORKSPACE_FILE, workspaceYaml(patchedDependencies));
console.log("updated pnpm-workspace.yaml patchedDependencies");
