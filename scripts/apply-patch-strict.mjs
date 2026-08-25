#!/usr/bin/env node
// Apply a patch and fail if GNU patch reports line offsets or fuzz.
// Usage: node scripts/apply-patch-strict.mjs <package-dir> <patch-file>

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [packageDirArg, patchFileArg] = process.argv.slice(2);

if (!packageDirArg || !patchFileArg) {
	console.error("usage: node scripts/apply-patch-strict.mjs <package-dir> <patch-file>");
	process.exit(2);
}

const packageDir = path.resolve(REPO_ROOT, packageDirArg);
const patchFile = path.resolve(REPO_ROOT, patchFileArg);
const result = spawnSync("patch", ["--directory", packageDir, "--forward", "--fuzz=0", "--strip=1", "--input", patchFile], {
	encoding: "utf8",
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (result.error) {
	console.error(`error: failed to run GNU patch: ${result.error.message}`);
	process.exit(1);
}

if (result.status !== 0) {
	process.exit(result.status ?? 1);
}

const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
if (/\b(offset|fuzz)\b/i.test(output)) {
	console.error(`error: GNU patch applied ${patchFileArg} with line offsets or fuzz; rebase the patch diffs`);
	process.exit(1);
}

