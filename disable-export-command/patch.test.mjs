import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseArgs } from "@earendil-works/pi-coding-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgDist = path.join(__dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist");

describe("parseArgs --export", () => {
	it("no longer parses --export into args.export", () => {
		const parsed = parseArgs(["--export", "session.jsonl"]);
		expect(parsed.export).toBeUndefined();
	});

	it("passes --export through as an extension flag value", () => {
		const parsed = parseArgs(["--export", "session.jsonl"]);
		expect(parsed.unknownFlags.get("export")).toBe("session.jsonl");
	});

	it("supports the --export=path form as an extension flag value", () => {
		const parsed = parseArgs(["--export=session.jsonl"]);
		expect(parsed.unknownFlags.get("export")).toBe("session.jsonl");
	});

	it("keeps positional args as messages so --export <in> <out> still carries the output path", () => {
		const parsed = parseArgs(["--export", "session.jsonl", "out.html"]);
		expect(parsed.unknownFlags.get("export")).toBe("session.jsonl");
		expect(parsed.messages).toEqual(["out.html"]);
	});
});

describe("BUILTIN_SLASH_COMMANDS", () => {
	it("no longer lists export", async () => {
		const mod = await import(pathToFileURL(path.join(pkgDist, "core", "slash-commands.js")).href);
		const names = mod.BUILTIN_SLASH_COMMANDS.map((command) => command.name);
		expect(names).not.toContain("export");
	});
});

describe("interactive /export dispatch", () => {
	const src = fs.readFileSync(path.join(pkgDist, "modes", "interactive", "interactive-mode.js"), "utf-8");

	it("does not intercept /export before extension dispatch", () => {
		expect(src).not.toContain('text === "/export"');
	});
});

describe("main --export branch", () => {
	const src = fs.readFileSync(path.join(pkgDist, "main.js"), "utf-8");

	it("no longer early-exits into exportFromFile", () => {
		expect(src).not.toContain("if (parsed.export)");
	});

	it("keeps the statement that followed the removed block", () => {
		// Guards against deleting one line too many: the export branch sat
		// directly above the appMode declaration, and swallowing it turns every
		// startup into a ReferenceError.
		expect(src).toContain("let appMode = resolveAppMode(");
	});
});

describe("patched CLI smoke", () => {
	it("--version still boots past the removed export branch", () => {
		const res = spawnSync(process.execPath, [path.join(pkgDist, "cli.js"), "--version"], {
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(res.stderr).not.toContain("ReferenceError");
		expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
	});
});
