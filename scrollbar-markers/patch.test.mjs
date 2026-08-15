// Guards the pi-tui and pi-coding-agent scrollbar marker patches.
//
// Sweeps every scroll position of a transcript whose content lines carry a
// background reaching the scrollbar column (what a user message looks like),
// and resolves the terminal SGR state at each marker glyph. Fails on unpatched
// code, where `scrollbarMarkers` is ignored and no glyph is ever painted.

import { InteractiveMode, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { ScrollView, Text, VStack } from "@earendil-works/pi-tui";
import { getScrollViewBox, getScrollbarGeometry, renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { describe, expect, it } from "vitest";

const MESSAGE_BG = "\x1b[48;2;30;30;40m";
const THUMB_BG = "2;64;64;64";
const LABEL_FG = "2;255;255;0";
const USER_FG = "2;0;128;255";

/** Resolve the foreground/background in effect where the marker glyph is drawn. */
function stateAtGlyph(line) {
  const glyph = line.indexOf("▄");
  if (glyph < 0) return null;
  let fg = null;
  let bg = null;
  const sgr = /\x1b\[([0-9;]*)m/g;
  let match;
  while ((match = sgr.exec(line)) && match.index < glyph) {
    const codes = match[1] === "" ? ["0"] : match[1].split(";");
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === "0") {
        fg = null;
        bg = null;
      } else if (code === "38" || code === "48") {
        const count = codes[i + 1] === "2" ? 4 : 2;
        const value = codes.slice(i + 1, i + 1 + count).join(";");
        if (code === "38") fg = value;
        else bg = value;
        i += count;
      } else if (code === "39") fg = null;
      else if (code === "49") bg = null;
    }
  }
  return { fg, bg };
}

describe("scrollbar markers at every scroll position", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `${MESSAGE_BG}${`line ${i}`.padEnd(60)}\x1b[49m`);
  const scrollView = new ScrollView(new Text(lines.join("\n"), 0, 0), {
    follow: "end",
    primary: true,
    scrollbar: "always",
    scrollbarStyle: (text) => `\x1b[48;${THUMB_BG}m${text}\x1b[49m`,
    scrollbarMarkerStyles: {
      label: () => `\x1b[49m\x1b[38;${LABEL_FG}m▄\x1b[39m`,
      user: () => `\x1b[49m\x1b[38;${USER_FG}m▄\x1b[39m`,
    },
  });
  scrollView.scrollbarMarkers = () => [
    { position: 0.3, kind: "label" },
    { position: 0.7, kind: "user" },
  ];

  const root = new VStack([
    { component: scrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: new Text("dock", 0, 0), basis: "auto", grow: 0 },
  ]);

  // Two frames: the first establishes layout, the second is measured.
  renderLayoutFrame(root, 40, 24, () => {});
  const geometry = getScrollbarGeometry(getScrollViewBox(renderLayoutFrame(root, 40, 24, () => {}), scrollView));
  const rowOf = (fraction) => geometry.trackTop + Math.round(fraction * (geometry.trackHeight - 1));
  const markers = [
    { kind: "label", row: rowOf(0.3), fg: LABEL_FG },
    { kind: "user", row: rowOf(0.7), fg: USER_FG },
  ];

  let painted = 0;
  let onThumb = 0;
  let offThumb = 0;
  let colorLost = 0;
  let thumbHalfWrong = 0;
  let backgroundLeaked = 0;

  for (let scrollTop = 0; scrollTop <= geometry.maxScrollTop; scrollTop++) {
    scrollView.scrollTo(scrollTop);
    const frame = renderLayoutFrame(root, 40, 24, () => {});
    const live = getScrollbarGeometry(getScrollViewBox(frame, scrollView));
    for (const marker of markers) {
      const state = stateAtGlyph(frame.lines[marker.row] ?? "");
      if (!state) continue;
      painted++;
      if (state.fg !== marker.fg) colorLost++;
      if (marker.row >= live.thumbTop && marker.row < live.thumbTop + live.thumbHeight) {
        onThumb++;
        if (state.bg !== THUMB_BG) thumbHalfWrong++;
      } else {
        offThumb++;
        if (state.bg !== null) backgroundLeaked++;
      }
    }
  }

  const expected = (geometry.maxScrollTop + 1) * markers.length;

  it(`paints every marker at every scroll position (${painted}/${expected})`, () => {
    expect(painted).toBe(expected);
  });

  it("exercises both on-thumb and off-thumb placements", () => {
    expect(onThumb).toBeGreaterThan(0);
    expect(offThumb).toBeGreaterThan(0);
  });

  it(`keeps each marker's own color (${colorLost} lost)`, () => {
    expect(colorLost).toBe(0);
  });

  it(`gives markers over the thumb the thumb background (${thumbHalfWrong} wrong)`, () => {
    expect(thumbHalfWrong).toBe(0);
  });

  it(`never leaks the message background into a marker (${backgroundLeaked} leaked)`, () => {
    expect(backgroundLeaked).toBe(0);
  });
});

// A background reset only counts in command position. These styles must behave
// like the separated `\x1b[49m\x1b[38;...m` form above: over the thumb the reset
// is stripped so the thumb background shows, while a 49 that is really a color
// index or color component is left intact.
describe("49 reset handling over the thumb", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `${MESSAGE_BG}${`line ${i}`.padEnd(60)}\x1b[49m`);

  it.each([
    ["49 combined with the foreground", `\x1b[49;38;${LABEL_FG}m▄\x1b[39m`, LABEL_FG],
    ["49 as a 256-color index", `\x1b[49m\x1b[38;5;49m▄\x1b[39m`, "5;49"],
    ["49 as a color component", `\x1b[49m\x1b[38;2;0;49;0m▄\x1b[39m`, "2;0;49;0"],
  ])("%s", (name, markerStyle, wantFg) => {
    const view = new ScrollView(new Text(lines.join("\n"), 0, 0), {
      follow: "end",
      primary: true,
      scrollbar: "always",
      scrollbarStyle: (text) => `\x1b[48;${THUMB_BG}m${text}\x1b[49m`,
      scrollbarMarkerStyles: { label: () => markerStyle },
    });
    const viewRoot = new VStack([
      { component: view, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: new Text("dock", 0, 0), basis: "auto", grow: 0 },
    ]);
    renderLayoutFrame(viewRoot, 40, 24, () => {});
    const viewGeometry = getScrollbarGeometry(getScrollViewBox(renderLayoutFrame(viewRoot, 40, 24, () => {}), view));
    // Place the marker in the middle of the thumb at the current scroll position.
    const thumbRow = viewGeometry.thumbTop + Math.floor(viewGeometry.thumbHeight / 2);
    view.scrollbarMarkers = () => [{ position: (thumbRow - viewGeometry.trackTop) / (viewGeometry.trackHeight - 1), kind: "label" }];
    const frame = renderLayoutFrame(viewRoot, 40, 24, () => {});
    const live = getScrollbarGeometry(getScrollViewBox(frame, view));
    const state = stateAtGlyph(frame.lines[thumbRow] ?? "");
    const covered = thumbRow >= live.thumbTop && thumbRow < live.thumbTop + live.thumbHeight;

    expect({ name, covered, state: state !== null }, "marker painted over the thumb").toMatchObject({
      covered: true,
      state: true,
    });
    expect(state?.fg, "marker keeps its foreground").toBe(wantFg);
    expect(state?.bg, "thumb background survives").toBe(THUMB_BG);
  });
});

// Markers are opt-in: a ScrollView without a provider must paint none.
it("paints no markers without a provider", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `${MESSAGE_BG}${`line ${i}`.padEnd(60)}\x1b[49m`);
  const plain = new ScrollView(new Text(lines.join("\n"), 0, 0), {
    follow: "end",
    primary: true,
    scrollbar: "always",
    scrollbarStyle: (text) => `\x1b[48;${THUMB_BG}m${text}\x1b[49m`,
  });
  const plainRoot = new VStack([{ component: plain, basis: 0, grow: 1, shrink: 1, minSize: 1 }]);
  renderLayoutFrame(plainRoot, 40, 24, () => {});
  const plainFrame = renderLayoutFrame(plainRoot, 40, 24, () => {});
  expect(plainFrame.lines.some((line) => line.includes("▄"))).toBe(false);
});

describe("InteractiveMode transcript marker API", () => {
  const proto = InteractiveMode.prototype;

  it.each(["getTranscriptMarkers", "getLabeledTranscriptTargets", "getTranscriptMarkerKind", "measureComponentHeight"])(
    "InteractiveMode.prototype.%s exists",
    (method) => {
      expect(typeof proto[method]).toBe("function");
    },
  );

  describe("getTranscriptMarkerKind", () => {
    const classify = (child, labeled) =>
      proto.getTranscriptMarkerKind.call(null, child, {
        messages: new Set(),
        entryIds: new Set(),
        texts: new Set(),
        ...labeled,
      });

    const userComponent = new UserMessageComponent("what is the plan?");
    const assistantLike = { lastMessage: { role: "assistant", content: [] } };
    const customEntryLike = { entry: { id: "entry-7" } };

    it("gives unlabeled components no marker", () => {
      expect(classify(userComponent, {})).toBeUndefined();
      expect(classify(assistantLike, {})).toBeUndefined();
      expect(classify(customEntryLike, {})).toBeUndefined();
    });

    it("gives a labeled assistant message a label marker", () => {
      expect(classify(assistantLike, { messages: new Set([assistantLike.lastMessage]) })).toBe("label");
    });

    it("gives a labeled custom entry a label marker", () => {
      expect(classify(customEntryLike, { entryIds: new Set(["entry-7"]) })).toBe("label");
    });

    it("gives a labeled user message a label marker", () => {
      expect(classify(userComponent, { texts: new Set(["what is the plan?"]) })).toBe("label");
    });

    it("does not mark a user message labeled by another entry's text", () => {
      expect(classify(userComponent, { texts: new Set(["a different message"]) })).toBeUndefined();
    });
  });
});
