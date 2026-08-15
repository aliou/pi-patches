import { Markdown } from "@earendil-works/pi-tui/dist/components/markdown.js";
import { describe, expect, it } from "vitest";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const noop = (s) => s;
const theme = {
  codeBlock: noop,
  codeBlockPaddingTop: noop,
  codeBlockPaddingBottom: noop,
  bold: noop,
  italic: noop,
  strikethrough: noop,
  underline: noop,
  heading: noop,
  code: noop,
  link: noop,
  linkUrl: noop,
  quote: noop,
  quoteBorder: noop,
  hr: noop,
  listBullet: noop,
  codeBlockBorder: noop,
};

const W = 40;
const doc = "para1\n\n```js\nconst x = 1\n```\n\npara2";

describe("markdown-code-block patch", () => {
  const lines = new Markdown(doc, 0, 0, theme, undefined, {}).render(W).map(strip);

  it("renders no ``` fences", () => {
    expect(lines.some((l) => l.includes("```"))).toBe(false);
  });

  it("renders a top padding line (▀)", () => {
    expect(lines).toContain("▀".repeat(W));
  });

  it("renders a bottom padding line (▄)", () => {
    expect(lines).toContain("▄".repeat(W));
  });

  it("renders the code text", () => {
    expect(lines.some((l) => l.includes("const x = 1"))).toBe(true);
  });

  it("renders no blank lines around the block", () => {
    expect(lines.some((l) => l.trim() === "")).toBe(false);
  });
});
