import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Isolate from the user's global agent dir: extensions, settings, auth all
// resolve under PI_CODING_AGENT_DIR. Must be set before importing pi-coding-agent.
const stubAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-patch-agent-"));
process.env.PI_CODING_AGENT_DIR = stubAgentDir;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.join(__dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent");
const distDir = path.join(pkgDir, "dist");
const examplesDir = process.env.PI_EXAMPLES_DIR ?? "/Users/alioudiallo/code/src/github.com/earendil-works/pi/packages/coding-agent/examples/extensions";
const agent = await import("@earendil-works/pi-coding-agent");

let failed = 0;
const assert = (name, cond) => {
  console.log(`${cond ? "ok" : "not ok"} - ${name}`);
  if (!cond) failed++;
};

// 1. Verify moduleCache: true in loader
const loaderPath = path.join(distDir, "core", "extensions", "loader.js");
const loaderSrc = fs.readFileSync(loaderPath, "utf-8");
assert("loader sets moduleCache: true", loaderSrc.includes("moduleCache: true"));
assert("loader does not set moduleCache: false", !loaderSrc.includes("moduleCache: false"));

// 2. Verify /reload is disabled in interactive mode
const imPath = path.join(distDir, "modes", "interactive", "interactive-mode.js");
const imSrc = fs.readFileSync(imPath, "utf-8");
const handleReloadCommand = imSrc.match(/async handleReloadCommand\(\) {([^}]+)/);
assert("handleReloadCommand exists", !!handleReloadCommand);
if (handleReloadCommand) {
  const body = handleReloadCommand[1];
  assert(
    "handleReloadCommand shows disabled warning",
    body.includes("/reload is disabled by the jiti-module-cache patch"),
  );
  assert("handleReloadCommand returns early", body.includes("return;"));
}

// 3. Verify agent dir isolation
assert("PI_CODING_AGENT_DIR is set", process.env.PI_CODING_AGENT_DIR === stubAgentDir);
assert("agent dir resolves to stub", agent.getAgentDir() === stubAgentDir);

// 4. Load real dummy fixture extensions from a temp dir (exercises jiti transpile)
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-patch-ext-"));
try {
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

  const { extensions, errors } = await agent.discoverAndLoadExtensions([fixtureDir], process.cwd());
  assert("fixtures load without errors", errors.length === 0);
  assert("both fixture extensions load", extensions.length === 2);

  if (extensions.length === 2) {
    const hello = extensions.find((e) => e.path.includes("fixture-hello"));
    const bye = extensions.find((e) => e.path.includes("fixture-bye"));
    assert("fixture-hello registered its command", !!hello && hello.commands.has("fixture-hello"));
    assert("fixture-hello registered its flag", !!hello && hello.flags.has("fixtureFlag"));
    assert("fixture-hello handler registered", !!hello && (hello.handlers.get("turn_end") ?? []).length === 1);
    assert("fixture-bye registered its renderer", !!bye && bye.messageRenderers.has("fixture-msg"));
  }
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}

// 5. Load a real example extension from the pi repo and run its command
if (fs.existsSync(examplesDir)) {
  const commandsExt = path.join(examplesDir, "commands.ts");
  if (fs.existsSync(commandsExt)) {
    const { extensions, errors } = await agent.discoverAndLoadExtensions([commandsExt], process.cwd());
    assert("examples/commands.ts loads without errors", errors.length === 0);
    assert("examples/commands.ts is loaded", extensions.length === 1);

    const ext = extensions[0];
    if (ext) {
      assert("example registered commands", ext.commands.size > 0);
      const first = [...ext.commands.values()][0];
      if (first) {
        try {
          await first.handler({}, {});
          assert("example command runs through jiti-loaded module", true);
        } catch (err) {
          // Handler runs against a stub ctx — runtime errors are fine as long as
          // the command was found and invoked (i.e. jiti loading worked).
          const msg = err instanceof Error ? err.message : String(err);
          assert(`example command invoked (runtime error ok: ${msg.slice(0, 60)})`, msg.length > 0);
        }
      }
    }
  } else {
    console.log("skip - examples/commands.ts not found; set PI_EXAMPLES_DIR");
  }
} else {
  console.log("skip - pi examples dir not found; set PI_EXAMPLES_DIR");
}

fs.rmSync(stubAgentDir, { recursive: true, force: true });

if (failed) {
  console.error(`\n${failed} patch assertion(s) failed`);
  process.exit(1);
}
console.log("\nall patch assertions passed");
