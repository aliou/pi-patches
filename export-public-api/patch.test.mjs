import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportFromFile, exportSessionToHtml } from "@earendil-works/pi-coding-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("package index exports", () => {
	it("exports exportSessionToHtml", () => {
		expect(typeof exportSessionToHtml).toBe("function");
	});

	it("exports exportFromFile", () => {
		expect(typeof exportFromFile).toBe("function");
	});
});

describe("exportFromFile", () => {
	let tmpDir;
	let sessionPath;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-export-api-"));
		const now = new Date().toISOString();
		const lines = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "11111111-2222-3333-4444-555555555555",
				timestamp: now,
				cwd: tmpDir,
				source: "patch-test",
			}),
			JSON.stringify({
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: now,
				message: { role: "user", content: "hello from the export-public-api patch test" },
			}),
			JSON.stringify({
				type: "message",
				id: "entry-2",
				parentId: "entry-1",
				timestamp: now,
				message: { role: "assistant", content: "hi" },
			}),
		];
		sessionPath = path.join(tmpDir, "session.jsonl");
		fs.writeFileSync(sessionPath, `${lines.join("\n")}\n`);
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("writes an HTML file for a session jsonl", async () => {
		const outPath = path.join(tmpDir, "out.html");
		const result = await exportFromFile(sessionPath, outPath);
		expect(result).toBe(outPath);
		const html = fs.readFileSync(outPath, "utf-8");
		expect(html).toContain("<!DOCTYPE html>");
		// Session data is embedded base64-encoded; check it round-trips.
		const dataMatch = html.match(/id="session-data"[^>]*>([^<]+)</);
		const embedded = dataMatch ? JSON.parse(Buffer.from(dataMatch[1], "base64").toString("utf-8")) : null;
		expect(embedded?.header?.id).toBe("11111111-2222-3333-4444-555555555555");
	});

	it("rejects missing files", async () => {
		await expect(exportFromFile(path.join(tmpDir, "nope.jsonl"))).rejects.toThrow(/not found/i);
	});
});
