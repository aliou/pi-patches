import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

describe("nix-highlighting patch", () => {
  it.each([
    ["component.astro", "astro"],
    ["change.diff", "diff"],
    ["config.hujson", "json"],
    ["settings.jsonc", "json"],
    ["lines.jsonl", "json"],
    ["justfile", "makefile"],
    ["page.mdx", "markdown"],
    ["module.mts", "typescript"],
    ["flake.nix", "nix"],
    ["script.nu", "nu"],
    ["main.zig", "zig"],
  ])("getLanguageFromPath(%s) === %s", (file, expected) => {
    expect(getLanguageFromPath(file)).toBe(expected);
  });
});
