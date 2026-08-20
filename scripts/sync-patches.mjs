#!/usr/bin/env node
// @aliou/pi-patches manifest sync.
//
// `manifest.json` is the source of truth: it lists, per package, the ordered
// patch files to apply. Entries may be either a patch directory name
// (using `<dir>/patch.diff`) or `{ "name": "<label>", "dir": "<dir>", "patch": "<file>" }`
// for shared directories that contain package-specific diffs.
//
// Each patch.diff is authored against the PRISTINE published package (the
// `npm pack` tarball of the version pinned in package.json), never against an
// already-patched tree. pnpm cannot express multiple patches per package, so
// this script combines them by staging:
//
//   1. extract the pristine package (cached under .cache/pristine/)
//   2. apply every manifest patch in order with GNU patch (offset search
//      absorbs upstream line drift; --fuzz=0 forbids fuzzy context matches)
//   3. emit the combined diff pristine→staged in pure Node (deterministic
//      bytes on every platform — the combined file's hash is pinned in
//      pnpm-lock.yaml, and CI regenerates it before a frozen install)
//   4. self-verify: apply the combined diff to a fresh pristine copy with GNU
//      patch and require byte-identical results
//
// Consumers:
//   - pnpm (`pnpm install`) applies the generated combined diff.
//   - Nix (`pkgs/pi-cli-patched`) reads the manifest and applies each patch in
//     succession with GNU patch, so a failure names the individual patch.
//
// A patch whose context no longer matches fails here, naming the patch — that
// is the rebase signal, same one the Nix consumer and the upstream-main CI
// job surface. Two patches for the same package must not touch overlapping
// hunks; this script rejects that in pristine coordinates.
//
// Usage:
//   node scripts/sync-patches.mjs           # regenerate combined diffs + package.json
//   node scripts/sync-patches.mjs --check   # fail if anything is out of date
//
// Network is required on a cold cache to fetch pristine tarballs (npm pack).
// Later runs are offline once .cache/pristine/ is populated.

import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";

// Resolved from this file, not the cwd, so running the script by absolute path
// from another checkout cannot rewrite or delete that checkout's patches.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_FILE = path.join(REPO_ROOT, "manifest.json");
const PKG_FILE = path.join(REPO_ROOT, "package.json");
const WORKSPACE_FILE = path.join(REPO_ROOT, "pnpm-workspace.yaml");
const COMBINED_DIR = path.join(REPO_ROOT, "combined");
const COMBINED_REL = "combined";
const CACHE_DIR = path.join(REPO_ROOT, ".cache", "pristine");
const HUNK_CONTEXT = 3;

const problems = [];
const fail = (message) => problems.push(message);

// ============================================================================
// Unified diff emission (pure Node)
//
// Determinism matters more than minimality: pnpm-lock.yaml pins a hash of the
// generated file, and CI regenerates it on a different OS than the committer.
// The emitter below is exact for a given (pristine, staged) pair on any
// platform, and the pipeline self-verifies by round-tripping the emitted diff
// through GNU patch after every generation.
// ============================================================================

/** Split text into lines plus whether the text ends with a newline. */
function splitLines(text) {
	if (text === "") return { lines: [], trailingNewline: false };
	const trailingNewline = text.endsWith("\n");
	const body = trailingNewline ? text.slice(0, -1) : text;
	return { lines: body.split("\n"), trailingNewline };
}

/**
 * Longest strictly-increasing subsequence of `pairs` (already sorted by `i`),
// keyed by `j`. Returns the anchor pairs, in order.
 */
function lisByJ(pairs) {
	const tails = [];
	const tailsIdx = [];
	const parent = new Array(pairs.length).fill(-1);
	for (let k = 0; k < pairs.length; k++) {
		const j = pairs[k].j;
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (tails[mid] < j) lo = mid + 1;
			else hi = mid;
		}
		if (lo > 0) parent[k] = tailsIdx[lo - 1];
		if (lo === tails.length) {
			tails.push(j);
			tailsIdx.push(k);
		} else {
			tails[lo] = j;
			tailsIdx[lo] = k;
		}
	}
	const out = [];
	for (let cur = tailsIdx.length ? tailsIdx[tailsIdx.length - 1] : -1; cur !== -1; cur = parent[cur]) {
		out.push(pairs[cur]);
	}
	return out.reverse();
}

/**
 * Patience line diff: align on lines that are unique in both inputs, then
 * recurse between anchors. Regions without unique anchors become one
 * delete+insert block — larger than a minimal diff but always correct.
 * Returns per-line ops: { t: "=" | "-" | "+", line }.
 */
function patienceOps(a, b) {
	if (a.length === 0) return b.map((line) => ({ t: "+", line }));
	if (b.length === 0) return a.map((line) => ({ t: "-", line }));

	const countA = new Map();
	for (const line of a) countA.set(line, (countA.get(line) ?? 0) + 1);
	const countB = new Map();
	for (const line of b) countB.set(line, (countB.get(line) ?? 0) + 1);

	const posB = new Map();
	for (let j = 0; j < b.length; j++) {
		const line = b[j];
		if (countB.get(line) === 1 && countA.get(line) === 1) posB.set(line, j);
	}
	const matched = [];
	for (let i = 0; i < a.length; i++) {
		const line = a[i];
		if (countA.get(line) === 1 && posB.has(line)) matched.push({ i, j: posB.get(line) });
	}

	if (matched.length === 0) {
		return [...a.map((line) => ({ t: "-", line })), ...b.map((line) => ({ t: "+", line }))];
	}

	const ops = [];
	let ai = 0;
	let bj = 0;
	for (const { i, j } of lisByJ(matched)) {
		if (i > ai || j > bj) ops.push(...patienceOps(a.slice(ai, i), b.slice(bj, j)));
		ops.push({ t: "=", line: a[i] });
		ai = i + 1;
		bj = j + 1;
	}
	if (ai < a.length || bj < b.length) ops.push(...patienceOps(a.slice(ai), b.slice(bj)));
	return ops;
}

/** Line ops for a→b with common prefix/suffix trimmed first. */
export function diffLineOps(a, b) {
	let p = 0;
	const m = Math.min(a.length, b.length);
	while (p < m && a[p] === b[p]) p++;
	let s = 0;
	while (s < m - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
	const ops = [];
	for (let i = 0; i < p; i++) ops.push({ t: "=", line: a[i] });
	ops.push(...patienceOps(a.slice(p, a.length - s), b.slice(p, b.length - s)));
	for (let i = 0; i < s; i++) ops.push({ t: "=", line: a[a.length - s + i] });
	return ops;
}

/**
 * Group ops into unified-diff hunks. `oldNoNewline`/`newNoNewline` describe
 * whether the respective file lacks a trailing newline (marker emission).
 * Returns arrays of hunk body lines (including the @@ header).
 */
export function toHunks(ops, oldNoNewline, newNoNewline, context = HUNK_CONTEXT) {
	const firstChange = ops.findIndex((op) => op.t !== "=");
	if (firstChange === -1) return [];

	// Line numbers per op (null on the side the op does not exist in) and
	// cumulative side counts before each index.
	const oldNo = new Array(ops.length);
	const newNo = new Array(ops.length);
	const oldBefore = new Array(ops.length + 1);
	const newBefore = new Array(ops.length + 1);
	let o = 0;
	let n = 0;
	oldBefore[0] = 0;
	newBefore[0] = 0;
	for (let i = 0; i < ops.length; i++) {
		const op = ops[i];
		if (op.t === "=") {
			oldNo[i] = ++o;
			newNo[i] = ++n;
		} else if (op.t === "-") {
			oldNo[i] = ++o;
		} else {
			newNo[i] = ++n;
		}
		oldBefore[i + 1] = o;
		newBefore[i + 1] = n;
	}
	let oldLastIdx = -1;
	let newLastIdx = -1;
	for (let i = ops.length - 1; i >= 0; i--) {
		if (oldLastIdx === -1 && ops[i].t !== "+") oldLastIdx = i;
		if (newLastIdx === -1 && ops[i].t !== "-") newLastIdx = i;
		if (oldLastIdx !== -1 && newLastIdx !== -1) break;
	}

	// Group changes: merge when the run of equals between them is <= 2*context.
	const groups = [];
	let group = null;
	let equalsRun = 0;
	for (let i = firstChange; i < ops.length; i++) {
		if (ops[i].t === "=") {
			if (group !== null) equalsRun++;
			continue;
		}
		if (group === null) {
			group = { start: i, end: i };
		} else if (equalsRun <= 2 * context) {
			group.end = i;
		} else {
			groups.push(group);
			group = { start: i, end: i };
		}
		equalsRun = 0;
	}
	if (group !== null) groups.push(group);

	const hunks = [];
	for (const g of groups) {
		const from = Math.max(0, g.start - context);
		const to = Math.min(ops.length - 1, g.end + context);
		let oldCount = 0;
		let newCount = 0;
		const body = [];
		for (let i = from; i <= to; i++) {
			const op = ops[i];
			body.push(`${op.t === "=" ? " " : op.t}${op.line}`);
			if (op.t !== "+") oldCount++;
			if (op.t !== "-") newCount++;
			if (i === oldLastIdx && oldNoNewline && op.t !== "+") body.push("\\ No newline at end of file");
			if (i === newLastIdx && newNoNewline && op.t !== "-" && !(i === oldLastIdx && oldNoNewline)) {
				body.push("\\ No newline at end of file");
			}
		}
		// Zero-length sides point at the line *before* the gap, so pure
		// insertions/deletions render as `-N,0` / `+N,0` like GNU diff.
		const oldStart = oldCount === 0 ? oldBefore[from] : oldBefore[from] + 1;
		const newStart = newCount === 0 ? newBefore[from] : newBefore[from] + 1;
		const fmt = (start, count) => (count === 1 ? `${start}` : `${start},${count}`);
		hunks.push([`@@ -${fmt(oldStart, oldCount)} +${fmt(newStart, newCount)} @@`, ...body]);
	}
	return hunks;
}

/** Unified diff for one file. `oldText`/`newText` null means absent on that side. */
export function formatFileDiff(relPath, oldText, newText) {
	const oldSplit = oldText === null ? { lines: [], trailingNewline: false } : splitLines(oldText);
	const newSplit = newText === null ? { lines: [], trailingNewline: false } : splitLines(newText);
	const ops = diffLineOps(oldSplit.lines, newSplit.lines);
	// When exactly one side lacks a trailing newline but both share the final
	// line, a shared context line cannot express the asymmetry — split it into
	// a delete+insert pair so each side carries its own newline marker.
	if (oldSplit.trailingNewline !== newSplit.trailingNewline && ops.length > 0 && ops[ops.length - 1].t === "=") {
		const shared = ops.pop().line;
		ops.push({ t: "-", line: shared }, { t: "+", line: shared });
	}
	const hunks = toHunks(ops, !oldSplit.trailingNewline, !newSplit.trailingNewline);
	if (hunks.length === 0) return "";
	const head = [
		oldText === null ? "--- /dev/null" : `--- a/${relPath}`,
		newText === null ? "+++ /dev/null" : `+++ b/${relPath}`,
	];
	return head.concat(...hunks).join("\n") + "\n";
}

/** Every file under `dir` as sorted POSIX-relative paths. */
export function listTreeFiles(dir) {
	const files = [];
	const walk = (rel) => {
		const abs = rel === "" ? dir : path.join(dir, rel);
		for (const ent of readdirSync(abs, { withFileTypes: true })) {
			const childRel = rel === "" ? ent.name : `${rel}/${ent.name}`;
			if (ent.isDirectory()) walk(childRel);
			else if (ent.isFile()) files.push(childRel);
		}
	};
	walk("");
	files.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
	return files;
}

function assertTreesEqual(aDir, bDir, labelA, labelB) {
	const aFiles = new Set(listTreeFiles(aDir));
	const bFiles = new Set(listTreeFiles(bDir));
	const missing = [...aFiles].filter((f) => !bFiles.has(f));
	const extra = [...bFiles].filter((f) => !aFiles.has(f));
	if (missing.length > 0 || extra.length > 0) {
		throw new Error(
			`tree mismatch between ${labelA} and ${labelB}: missing=[${missing.slice(0, 5).join(", ")}] extra=[${extra.slice(0, 5).join(", ")}]`,
		);
	}
	for (const rel of aFiles) {
		const a = readFileSync(path.join(aDir, rel));
		const b = readFileSync(path.join(bDir, rel));
		if (!a.equals(b)) throw new Error(`tree mismatch between ${labelA} and ${labelB}: ${rel} differs`);
	}
}

/**
 * Combined unified diff pristine→staged. Pure text handling; refuses files
 * containing NUL bytes so no binary patch is ever emitted.
 */
export function generateCombinedDiffText(pristineDir, stagedDir) {
	const paths = new Set([...listTreeFiles(pristineDir), ...listTreeFiles(stagedDir)]);
	const parts = [];
	for (const rel of [...paths].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))) {
		const oldPath = path.join(pristineDir, rel);
		const newPath = path.join(stagedDir, rel);
		const oldBuf = existsSync(oldPath) ? readFileSync(oldPath) : null;
		const newBuf = existsSync(newPath) ? readFileSync(newPath) : null;
		if (oldBuf !== null && newBuf !== null && oldBuf.equals(newBuf)) continue;
		if (oldBuf?.includes(0) || newBuf?.includes(0)) {
			throw new Error(`refusing to diff binary file: ${rel} (binary patches are not supported)`);
		}
		parts.push(formatFileDiff(rel, oldBuf === null ? null : oldBuf.toString("utf8"), newBuf === null ? null : newBuf.toString("utf8")));
	}
	return parts.join("");
}

// ============================================================================
// GNU patch application
// ============================================================================

/** Apply one patch.diff into `dir` with GNU patch. Throws with diagnostics on failure. */
export function applyPatchFileToDir(dir, patchFile, label) {
	const res = spawnSync(
		"patch",
		["--batch", "--fuzz=0", "--no-backup-if-mismatch", "-p1", "-d", dir, "-i", patchFile],
		{ encoding: "utf8" },
	);
	if (res.error) throw new Error(`GNU patch is required but could not run: ${res.error.message}`);
	if (res.status !== 0) {
		throw new Error(
			`${label} failed to apply:\n${(res.stdout ?? "").trim()}\n${(res.stderr ?? "").trim()}`
				.replace(/\n{3,}/g, "\n\n")
				.trim(),
		);
	}
	return `${res.stdout ?? ""}${res.stderr ?? ""}`;
}

/** Apply a diff from a string to `dir`; returns true on success. */
function applyDiffTextToDir(dir, diffText) {
	const res = spawnSync("patch", ["--batch", "--fuzz=0", "--no-backup-if-mismatch", "-p1", "-d", dir], {
		input: diffText,
		encoding: "utf8",
	});
	return res.status === 0 && !res.error;
}

// ============================================================================
// Manifest handling (unchanged semantics)
// ============================================================================

/**
 * Hunk ranges a unified diff touches, grouped by target file.
 *
 * Only a `+++` immediately preceded by a `---` is a file header; payload lines
 * can legitimately start with `+++ `. Both sides are recorded so a rename still
 * conflicts with a patch that edits either pathname, and `/dev/null` is ignored.
 *
 * Ranges use old-file coordinates: every patch.diff is authored against the
 * pristine published package. Pure insertions have length 0 in unified diff
 * headers; treat them as a one-line point interval so two patches inserting at
 * the same point conflict, while edits elsewhere in the same file can coexist.
 */
export function hunkTargetsOf(diff) {
	const clean = (header) => header.slice(4).trim().split("\t")[0].replace(/^[ab]\//, "");
	const lines = diff.split("\n");
	const targets = new Map();
	let currentTargets = [];
	for (let i = 0; i + 1 < lines.length; i++) {
		if (lines[i].startsWith("--- ") && lines[i + 1].startsWith("+++ ")) {
			// Set-dedupe: a normal patch names the same file on both sides, and
			// renames keep both paths.
			currentTargets = [...new Set([clean(lines[i]), clean(lines[i + 1])].filter((side) => side !== "/dev/null"))];
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

/** Every patch dir on disk, so orphans (present but unlisted) are caught. */
function patchDirsOnDisk() {
	return new Set(
		readdirSync(REPO_ROOT, { withFileTypes: true })
			.filter((e) => {
				if (!e.isDirectory()) return false;
				const dir = path.join(REPO_ROOT, e.name);
				return existsSync(path.join(dir, "patch.diff")) || readdirSync(dir).some((name) => name.endsWith(".patch.diff"));
			})
			.map((e) => e.name),
	);
}

function workspaceYaml(patched) {
	// `minimumReleaseAge: 0` disables pnpm's supply-chain age gate. In its
	// default non-strict mode the gate never blocks anything, but pnpm still
	// appends `minimumReleaseAgeExclude` entries to this file whenever a fresh
	// release is installed — which would make `--check` (exact file compare)
	// fail on every new pi version. This repo installs freshly published pi
	// releases by design, so the gate is noise.
	const lines = [
		"packages: []",
		"",
		"minimumReleaseAge: 0",
		"",
		"allowBuilds:",
		"  '@google/genai': false",
		"  protobufjs: false",
		"",
		"patchedDependencies:",
	];
	for (const [key, value] of Object.entries(patched)) {
		lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
	}
	return `${lines.join("\n")}\n`;
}

// ============================================================================
// Pristine package cache
// ============================================================================

function extractTarball(tgzPath, destDir) {
	const res = spawnSync("tar", ["-xzf", tgzPath, "-C", destDir, "--strip-components=1"], {
		encoding: "utf8",
	});
	if (res.status !== 0) {
		throw new Error(`tar extraction failed for ${tgzPath}:\n${res.stderr ?? ""}`);
	}
}

/**
 * Local extracted copy of the pristine published package, fetched with
 * `npm pack` on first use and cached under .cache/pristine/. Returns the
 * cache directory path. Never patch in place — staging copies from it.
 */
export function ensurePristine(pkgName, version) {
	const cacheDir = path.join(CACHE_DIR, `${pkgName.replace("/", "__")}@${version}`);
	const marker = path.join(cacheDir, ".pi-patches-pristine");
	if (existsSync(marker)) {
		try {
			const pkgJson = JSON.parse(readFileSync(path.join(cacheDir, "package.json"), "utf8"));
			if (pkgJson.name === pkgName && pkgJson.version === version) return cacheDir;
		} catch {
			// fall through to refetch
		}
		fail(`${pkgName}@${version}: pristine cache at ${cacheDir} is invalid; refetching`);
		rmSync(cacheDir, { recursive: true, force: true });
	}

	rmSync(cacheDir, { recursive: true, force: true });
	const tmp = mkdtempSync(path.join(os.tmpdir(), "pi-patches-pristine-"));
	const dest = path.join(tmp, "pkg");
	mkdirSync(dest);
	try {
		const packRes = spawnSync(
			"npm",
			["pack", `${pkgName}@${version}`, "--json", "--ignore-scripts", "--pack-destination", tmp],
			{ encoding: "utf8", cwd: tmp },
		);
		if (packRes.status !== 0) {
			const detail = `${packRes.stderr ?? packRes.stdout ?? ""}`.trim().split("\n").slice(-5).join("\n");
			throw new Error(
				`cannot fetch pristine ${pkgName}@${version} (npm pack failed; network is required on a cold .cache/pristine):\n${detail}`,
			);
		}
		let filename;
		try {
			const parsed = JSON.parse(packRes.stdout);
			filename = Array.isArray(parsed) ? parsed[0]?.filename : parsed?.filename;
		} catch {
			filename = undefined;
		}
		if (!filename || !existsSync(path.join(tmp, filename))) {
			throw new Error(`npm pack output for ${pkgName}@${version} did not include the expected tarball`);
		}
		extractTarball(path.join(tmp, filename), dest);

		const pkgJson = JSON.parse(readFileSync(path.join(dest, "package.json"), "utf8"));
		if (pkgJson.name !== pkgName || pkgJson.version !== version) {
			throw new Error(
				`pristine tarball for ${pkgName}@${version} contains ${pkgJson.name}@${pkgJson.version} (registry mismatch)`,
			);
		}
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(marker, `${pkgName}@${version}\n`);
		cpSync(dest, cacheDir, { recursive: true });
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
	return cacheDir;
}

// ============================================================================
// Per-package combination
// ============================================================================

function combinePackage(pkgName, version, dirs) {
	const entries = dirs.map((raw) => normalizePatchEntry(pkgName, raw)).filter(Boolean);
	if (entries.length === 0) {
		fail(`${pkgName}: manifest lists no patches`);
		return undefined;
	}

	// Static overlap check in pristine coordinates.
	const seenTargets = new Map();
	const patchFiles = [];
	for (const entry of entries) {
		const file = path.join(REPO_ROOT, entry.dir, entry.patch);
		if (!existsSync(file)) {
			fail(`${pkgName}: ${entry.label} is missing`);
			continue;
		}
		patchFiles.push({ ...entry, file });
	}
	if (patchFiles.length === 0) return undefined;

	for (const entry of patchFiles) {
		const diff = readFileSync(entry.file, "utf8");
		for (const [target, ranges] of hunkTargetsOf(diff)) {
			if (path.isAbsolute(target) || target.split("/").includes("..")) {
				fail(`${pkgName}: ${entry.label} targets invalid path ${target}`);
			}
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
	}

	// Stage: pristine copy → apply each patch with GNU patch.
	const pristineDir = ensurePristine(pkgName, version);
	const staged = mkdtempSync(path.join(os.tmpdir(), "pi-patches-staged-"));
	const verify = mkdtempSync(path.join(os.tmpdir(), "pi-patches-verify-"));
	try {
		cpSync(pristineDir, staged, { recursive: true, verbatimSymlinks: false });
		const notes = [];
		for (const entry of patchFiles) {
			const output = applyPatchFileToDir(staged, entry.file, `${pkgName}: ${entry.label}`);
			for (const line of output.split("\n")) {
				if (/offset|fuzz/i.test(line)) notes.push(`  ${pkgName}: ${entry.label}: ${line.trim()}`);
			}
		}

		const slug = pkgName.replace(/^@[^/]+\//, "");
		const rel = `${COMBINED_REL}/${slug}.diff`;
		const content = `${generateCombinedDiffText(pristineDir, staged)}`;

		// Self-verification: the emitted diff must reproduce the staged tree
		// from pristine via GNU patch, byte for byte.
		cpSync(pristineDir, verify, { recursive: true });
		if (!applyDiffTextToDir(verify, content)) {
			throw new Error(`${pkgName}: generated combined diff failed self-verification (did not apply to pristine)`);
		}
		assertTreesEqual(verify, staged, "self-verification tree", "staged tree");

		return {
			rel,
			content: `# Generated by scripts/sync-patches.mjs from manifest.json. Do not edit.\n${content}`,
			notes,
			patchCount: patchFiles.length,
		};
	} finally {
		rmSync(staged, { recursive: true, force: true });
		rmSync(verify, { recursive: true, force: true });
	}
}

// ============================================================================
// Entry point
// ============================================================================

function main() {
	const check = process.argv.includes("--check");
	const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
	const pkg = JSON.parse(readFileSync(PKG_FILE, "utf8"));
	const packages = Object.entries(manifest).filter(([key]) => !key.startsWith("//"));
	const dirsOnDisk = patchDirsOnDisk();

	const combined = new Map();
	const patchedDependencies = {};
	const allNotes = [];

	for (const [pkgName, dirs] of packages) {
		const version = pkg.dependencies?.[pkgName];
		if (!version) {
			fail(`${pkgName}: listed in manifest.json but not in package.json dependencies`);
			continue;
		}
		if (!/^\d/.test(version)) {
			fail(`${pkgName}: package.json must pin an exact version, got "${version}"`);
			continue;
		}
		for (const entry of dirs) {
			const normalized = normalizePatchEntry(pkgName, entry);
			if (normalized) dirsOnDisk.delete(normalized.dir);
		}

		try {
			const result = combinePackage(pkgName, version, dirs);
			if (result) {
				combined.set(result.rel, result.content);
				patchedDependencies[`${pkgName}@${version}`] = result.rel;
				allNotes.push(...result.notes);
				console.log(`combined ${pkgName}@${version}: ${result.patchCount} patch(es) staged + self-verified`);
			}
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error));
		}
	}

	for (const orphan of dirsOnDisk) {
		fail(`${orphan}/patch.diff exists but is not listed in manifest.json`);
	}

	if (problems.length > 0) {
		for (const problem of problems) console.error(`error: ${problem}`);
		process.exit(1);
	}

	if (allNotes.length > 0) {
		console.log("GNU patch offset notes (applied with offset; consider rebasing the patch):");
		for (const note of allNotes) console.log(note);
	}

	if (check) {
		let stale = 0;
		const expectedFiles = new Set(combined.keys());
		if (existsSync(COMBINED_DIR)) {
			for (const existing of readdirSync(COMBINED_DIR)) {
				const rel = `${COMBINED_REL}/${existing}`;
				if (!expectedFiles.has(rel)) {
					console.error(`error: unexpected file ${rel}`);
					stale++;
				}
			}
		}
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
			console.error("\nrun `pnpm patches:sync` and commit the result");
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
}

const isDirectRun =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) main();
