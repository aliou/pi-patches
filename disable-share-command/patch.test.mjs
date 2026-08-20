import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgDist = path.join(__dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist");

describe("BUILTIN_SLASH_COMMANDS", () => {
	it("no longer lists share", async () => {
		const mod = await import(pathToFileURL(path.join(pkgDist, "core", "slash-commands.js")).href);
		const names = mod.BUILTIN_SLASH_COMMANDS.map((command) => command.name);
		expect(names).not.toContain("share");
	});
});

describe("interactive /share dispatch", () => {
	const src = fs.readFileSync(path.join(pkgDist, "modes", "interactive", "interactive-mode.js"), "utf-8");

	it("does not intercept /share before extension dispatch", () => {
		expect(src).not.toContain('text === "/share"');
	});

	it("handleShareCommand is no longer called from the submit handler", () => {
		expect(src).not.toContain("await this.handleShareCommand()");
	});
});
