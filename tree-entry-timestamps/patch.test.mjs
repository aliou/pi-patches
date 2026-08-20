import * as path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgDist = path.join(__dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist");

function messageNode(id, parentId, timestamp, text, children = []) {
	return {
		entry: {
			type: "message",
			id,
			parentId,
			timestamp,
			message: { role: "user", content: text },
		},
		children,
	};
}

let themeReady = false;
async function ensureTheme() {
	if (themeReady) return;
	const theme = await import(pathToFileURL(path.join(pkgDist, "modes", "interactive", "theme", "theme.js")).href);
	theme.initTheme();
	themeReady = true;
}

describe("tree entry timestamps", () => {
	it("renders ISO 8601 for non-today entries and time + relative for today", async () => {
		const now = new Date();
		const pad = (n) => String(n).padStart(2, "0");

		// Today entry: built from today's Y/M/D, 30 minutes back (clamped), so
		// the same-day branch is guaranteed regardless of when the test runs.
		const today = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate(),
			now.getHours(),
			Math.max(0, now.getMinutes() - 30),
		);
		const diffMin = Math.floor((now.getTime() - today.getTime()) / 60000);
		const expectedToday = `${pad(today.getHours())}:${pad(today.getMinutes())} (${diffMin < 1 ? "now" : `${diffMin}m ago`})`;

		// Past entry: fixed local date, so the ISO output is deterministic.
		const past = new Date(2020, 4, 13, 14, 23, 0);
		const expectedPast = "2020-05-13 14:23";

		const leaf = messageNode("leaf", "root", today.toISOString(), "second turn");
		const root = messageNode("root", null, past.toISOString(), "hello world", [leaf]);

		await ensureTheme();
		const mod = await import(
			pathToFileURL(path.join(pkgDist, "modes", "interactive", "components", "tree-selector.js")).href
		);
		const component = new mod.TreeSelectorComponent([root], "leaf", 12);
		const lines = component.getTreeList().render(200);

		// Last line is the status line; rows come before it.
		const rows = lines.slice(0, -1);
		expect(rows.length).toBe(2);
		expect(rows[0]).toContain(expectedPast);
		expect(rows[0]).toContain("hello world");
		expect(rows[1]).toContain(expectedToday);
		expect(rows[1]).toContain("second turn");
	});
});
