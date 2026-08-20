// Tests for scripts/sync-patches.mjs — the diff emitter, the staged
// application model, and the regression case that motivated the rewrite:
// two patches authored in pristine coordinates where the first shifts the
// lines of the second must still combine into a pnpm-applicable diff.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const {
	applyPatchFileToDir,
	diffLineOps,
	formatFileDiff,
	generateCombinedDiffText,
	hunkTargetsOf,
	listTreeFiles,
	toHunks,
} = await import("../scripts/sync-patches.mjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hasGnuPatch = (() => {
	try {
		const res = spawnSync("patch", ["--version"], { encoding: "utf8" });
		return res.status === 0 && /GNU patch/i.test(res.stdout);
	} catch {
		return false;
	}
})();

/** Deterministic PRNG so failures reproduce. */
function mulberry32(seed) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function opsToText(ops) {
	return ops.map((op) => `${op.t === "=" ? " " : op.t}${op.line}`).join("\n");
}

/** Apply a unified diff string to a pristine tree using GNU patch. */
function applyDiffText(dir, diffText) {
	const res = spawnSync("patch", ["--batch", "--fuzz=0", "--no-backup-if-mismatch", "-p1", "-d", dir], {
		input: diffText,
		encoding: "utf8",
	});
	if (res.status !== 0) throw new Error(`patch failed:\n${res.stdout}\n${res.stderr}`);
}

function treeEquals(aDir, bDir) {
	const a = listTreeFiles(aDir).sort();
	const b = listTreeFiles(bDir).sort();
	if (JSON.stringify(a) !== JSON.stringify(b)) return false;
	return a.every((rel) => fs.readFileSync(path.join(aDir, rel)).equals(fs.readFileSync(path.join(bDir, rel))));
}

describe.skipIf(!hasGnuPatch)("diff emitter", () => {
	it("emits nothing for identical inputs", () => {
		expect(formatFileDiff("a.txt", "hello\nworld\n", "hello\nworld\n")).toBe("");
	});

	it("round-trips edits through GNU patch (randomized, seeded)", () => {
		const rand = mulberry32(20260211);
		for (let round = 0; round < 40; round++) {
			const size = 1 + Math.floor(rand() * 60);
			const alphabet = ["alpha", "beta", "gamma", "delta", "eps"]; // collisions forced
			const oldLines = Array.from({ length: size }, () => alphabet[Math.floor(rand() * alphabet.length)]);
			const newLines = structuredClone(oldLines);
			const edits = 1 + Math.floor(rand() * 6);
			for (let e = 0; e < edits; e++) {
				const at = Math.floor(rand() * (newLines.length + 1));
				const kind = rand();
				if (kind < 0.33 && newLines.length > 0) newLines.splice(at, 1 + Math.floor(rand() * 3));
				else if (kind < 0.66) newLines.splice(at, 0, ...Array.from({ length: 1 + Math.floor(rand() * 3) }, () => `x${Math.floor(rand() * 100)}`));
				else newLines.splice(at, Math.floor(rand() * 3), `y${Math.floor(rand() * 100)}`);
			}
			for (const [oldTn, newTn] of [
				[true, true],
				[false, true],
				[true, false],
				[false, false],
			]) {
				const oldText = oldLines.length === 0 ? "" : `${oldLines.join("\n")}${oldTn ? "\n" : ""}`;
				const newText = newLines.length === 0 ? "" : `${newLines.join("\n")}${newTn ? "\n" : ""}`;
				const diff = formatFileDiff("f.txt", oldText, newText);
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diff-rt-"));
				try {
					fs.writeFileSync(path.join(dir, "f.txt"), oldText);
					applyDiffText(dir, diff);
					expect(fs.readFileSync(path.join(dir, "f.txt"), "utf8")).toBe(newText);
				} catch (err) {
					throw new Error(`round ${round} [${oldTn},${newTn}] failed: ${err}\nold=${JSON.stringify(oldText)}\nnew=${JSON.stringify(newText)}\ndiff=\n${diff}`);
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			}
		}
	});

	it("creates new files and deletes files through /dev/null sides", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diff-add-"));
		try {
			const addDiff = formatFileDiff("new/thing.txt", null, "one\ntwo\n");
			applyDiffText(dir, addDiff);
			expect(fs.readFileSync(path.join(dir, "new/thing.txt"), "utf8")).toBe("one\ntwo\n");

			const delDiff = formatFileDiff("new/thing.txt", "one\ntwo\n", null);
			applyDiffText(dir, delDiff);
			expect(fs.existsSync(path.join(dir, "new/thing.txt"))).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("merges nearby changes into one hunk and splits distant ones", () => {
		const old = Array.from({ length: 40 }, (_, i) => `line-${i}`);
		const near = structuredClone(old);
		near[5] = "near-edit";
		near[7] = "near-edit-2";
		const hunkCount = (text) => (text.match(/^@@ /gm) ?? []).length;
		expect(hunkCount(formatFileDiff("f", `${old.join("\n")}\n`, `${near.join("\n")}\n`))).toBe(1);

		const far = structuredClone(old);
		far[2] = "far-edit";
		far[38] = "far-edit-2";
		expect(hunkCount(formatFileDiff("f", `${old.join("\n")}\n`, `${far.join("\n")}\n`))).toBe(2);
	});

	it("is deterministic", () => {
		const a = Array.from({ length: 200 }, (_, i) => `line-${i}`);
		const b = structuredClone(a);
		b.splice(50, 2, "changed");
		b.splice(150, 0, "inserted");
		const one = formatFileDiff("f", `${a.join("\n")}\n`, `${b.join("\n")}\n`);
		const two = formatFileDiff("f", `${a.join("\n")}\n`, `${b.join("\n")}\n`);
		expect(one).toBe(two);
	});
});

describe.skipIf(!hasGnuPatch)("staged combination (the regression case)", () => {
	let pristine;
	let patchesDir;

	beforeAll(() => {
		pristine = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reg-pristine-"));
		patchesDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reg-patches-"));
		// A package with two files; file B is large so line offsets matter.
		fs.mkdirSync(path.join(pristine, "dist"));
		fs.writeFileSync(path.join(pristine, "package.json"), JSON.stringify({ name: "fake", version: "1.0.0" }));
		const bigA = Array.from({ length: 100 }, (_, i) => `// A line ${i}`).join("\n");
		const bigB = Array.from({ length: 500 }, (_, i) => `// B line ${i}`).join("\n");
		fs.writeFileSync(path.join(pristine, "dist/a.js"), `${bigA}\n`);
		fs.writeFileSync(path.join(pristine, "dist/b.js"), `${bigB}\n`);
	});

	afterAll(() => {
		fs.rmSync(pristine, { recursive: true, force: true });
		fs.rmSync(patchesDir, { recursive: true, force: true });
	});

	it("combines two pristine-coordinate patches even when the first shifts the second's lines", () => {
		// Patch 1 (authored against pristine): insert 100 lines at the top of b.js.
		const patchOne = [
			"--- a/dist/b.js",
			"+++ b/dist/b.js",
			"@@ -1,3 +1,103 @@",
			...Array.from({ length: 100 }, (_, i) => `+// injected ${i}`),
			" // B line 0",
			" // B line 1",
			" // B line 2",
			"",
		].join("\n");
		const patchOnePath = path.join(patchesDir, "one.diff");
		fs.writeFileSync(patchOnePath, patchOne);

		// Patch 2 (also authored against PRISTINE, i.e. line 250 is pristine's
		// 250th line — but after patch 1 applied, GNU patch must offset-search).
		const patchTwo = [
			"--- a/dist/b.js",
			"+++ b/dist/b.js",
			"@@ -248,5 +248,5 @@",
			" // B line 246",
			" // B line 247",
			"-// B line 248",
			"+// B line 248 EDITED",
			" // B line 249",
			" // B line 250",
			"",
		].join("\n");
		const patchTwoPath = path.join(patchesDir, "two.diff");
		fs.writeFileSync(patchTwoPath, patchTwo);

		// Staged application exactly as sync-patches.mjs does it.
		const staged = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reg-staged-"));
		fs.cpSync(pristine, staged, { recursive: true });
		applyPatchFileToDir(staged, patchOnePath, "one.diff");
		applyPatchFileToDir(staged, patchTwoPath, "two.diff");

		// The combined diff regenerates exact coordinates and reproduces staged.
		const combined = generateCombinedDiffText(pristine, staged);
		const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reg-fresh-"));
		fs.cpSync(pristine, fresh, { recursive: true });
		applyDiffText(fresh, combined);
		expect(treeEquals(fresh, staged)).toBe(true);
		expect(fs.readFileSync(path.join(fresh, "dist/b.js"), "utf8")).toContain("// B line 248 EDITED");
		expect(fs.readFileSync(path.join(fresh, "dist/b.js"), "utf8")).toContain("// injected 99");

		fs.rmSync(staged, { recursive: true, force: true });
		fs.rmSync(fresh, { recursive: true, force: true });
	});
});

describe("hunkTargetsOf", () => {
	it("records zero-length insertions as point ranges", () => {
		const diff = ["--- a/f.js", "+++ b/f.js", "@@ -10 +10,2 @@", " ctx", "+new", ""].join("\n");
		const targets = hunkTargetsOf(diff);
		expect(targets.get("f.js")).toEqual([{ start: 10, end: 10 }]);
	});

	it("ignores /dev/null sides", () => {
		const diff = ["--- /dev/null", "+++ b/new.js", "@@ -0,0 +1,1 @@", "+hello", ""].join("\n");
		expect([...hunkTargetsOf(diff).keys()]).toEqual(["new.js"]);
	});
});

describe("diffLineOps", () => {
	it("aligns unchanged runs", () => {
		const ops = diffLineOps(["a", "b", "c"], ["a", "x", "c"]);
		expect(opsToText(ops)).toBe(" a\n-b\n+x\n c");
	});

	it("handles empty sides", () => {
		expect(opsToText(diffLineOps([], ["x"]))).toBe("+x");
		expect(opsToText(diffLineOps(["x"], []))).toBe("-x");
	});
});
