#!/usr/bin/env node
// Fail when any manifest patch applies with GNU patch line offsets or fuzz.
//
// This is intentionally separate from `sync-patches.mjs`: syncing may still
// regenerate combined diffs for local rebase work, while CI and local checks can
// require patch hunks to be exactly rebased.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const result = spawnSync(process.execPath, ["scripts/sync-patches.mjs", "--check"], {
	cwd: REPO_ROOT,
	encoding: "utf8",
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (result.error) {
	console.error(`error: failed to run patch sync check: ${result.error.message}`);
	process.exit(1);
}

if (result.status !== 0) {
	process.exit(result.status ?? 1);
}

const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
if (/\b(offset|fuzz)\b/i.test(output)) {
	console.error("error: one or more patch hunks applied with line offsets or fuzz; rebase the patch diffs");
	process.exit(1);
}

