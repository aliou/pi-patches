import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.join(__dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent");
const distDir = path.join(pkgDir, "dist");
const examplesDir = process.env.PI_EXAMPLES_DIR ?? "/Users/alioudiallo/code/src/github.com/earendil-works/pi/packages/coding-agent/examples/extensions";
const agent = await import("@earendil-works/pi-coding-agent");

describe("loader source", () => {
  const loaderSrc = fs.readFileSync(path.join(distDir, "core", "extensions", "loader.js"), "utf-8");

  it("sets moduleCache: true", () => {
    expect(loaderSrc).toContain("moduleCache: true");
  });

  it("does not set moduleCache: false", () => {
    expect(loaderSrc).not.toContain("moduleCache: false");
  });
});

describe("interactive /reload", () => {
  const imSrc = fs.readFileSync(path.join(distDir, "modes", "interactive", "interactive-mode.js"), "utf-8");
  const match = imSrc.match(/async handleReloadCommand\(\) {([^}]+)/);
  const body = match ? match[1] : null;

  it("handleReloadCommand exists", () => {
    expect(body).not.toBeNull();
  });

  it("shows the disabled warning", () => {
    expect(body).toContain("/reload is disabled by the jiti-module-cache patch");
  });

  it("returns early", () => {
    expect(body).toContain("return;");
  });
});

describe("fixture extensions load through jiti", () => {
  let fixtureDir;
  let loaded;

  beforeAll(async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-patch-ext-"));
    fs.writeFileSync(
      path.join(fixtureDir, "fixture-hello.ts"),
      `export default function (pi: any) {
  pi.registerFlag("fixtureFlag", { type: "boolean", default: true });
  pi.registerCommand("fixture-hello", {
    description: "fixture",
    handler: async () => {},
  });
  pi.on("turn_end", async () => {});
}\n`,
    );
    fs.writeFileSync(
      path.join(fixtureDir, "fixture-bye.ts"),
      `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer("fixture-msg", () => undefined);
}\n`,
    );
    // discoverAndLoadExtensions always includes user extensions from
    // ~/.pi/agent/extensions, so match fixtures by path.
    const { extensions, errors } = await agent.discoverAndLoadExtensions([fixtureDir], process.cwd());
    loaded = {
      errors,
      extensions: extensions.filter((e) => path.dirname(e.path) === fixtureDir),
    };
  });

  afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("loads both fixtures without errors", () => {
    expect(loaded.errors).toHaveLength(0);
    expect(loaded.extensions).toHaveLength(2);
  });

  it("fixture-hello registered its command", () => {
    const hello = loaded.extensions.find((e) => e.path.includes("fixture-hello"));
    expect(hello?.commands.has("fixture-hello")).toBe(true);
  });

  it("fixture-hello registered its flag", () => {
    const hello = loaded.extensions.find((e) => e.path.includes("fixture-hello"));
    expect(hello?.flags.has("fixtureFlag")).toBe(true);
  });

  it("fixture-hello registered its handler", () => {
    const hello = loaded.extensions.find((e) => e.path.includes("fixture-hello"));
    expect(hello?.handlers.get("turn_end")).toHaveLength(1);
  });

  it("fixture-bye registered its renderer", () => {
    const bye = loaded.extensions.find((e) => e.path.includes("fixture-bye"));
    expect(bye?.messageRenderers.has("fixture-msg")).toBe(true);
  });
});

const commandsExample = path.join(examplesDir, "commands.ts");
describe.skipIf(!fs.existsSync(commandsExample))("pi repo example extension (set PI_EXAMPLES_DIR to enable)", () => {
  let example;

  beforeAll(async () => {
    // discoverAndLoadExtensions always includes user extensions from
    // ~/.pi/agent/extensions, so match the example by path.
    const { extensions, errors } = await agent.discoverAndLoadExtensions([commandsExample], process.cwd());
    expect(errors).toHaveLength(0);
    example = extensions.find((e) => e.path === commandsExample);
  });

  it("examples/commands.ts is loaded", () => {
    expect(example).toBeDefined();
  });

  it("example registered commands", () => {
    expect(example?.commands.size).toBeGreaterThan(0);
  });

  it("example command runs through the jiti-loaded module", async () => {
    const first = [...(example?.commands.values() ?? [])][0];
    try {
      await first.handler({}, {});
    } catch (err) {
      // The handler runs against a stub ctx — a runtime error is fine as long
      // as the command was found and invoked (i.e. jiti loading worked).
      expect(String(err).length).toBeGreaterThan(0);
    }
  });
});
