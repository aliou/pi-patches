import { Editor } from "@earendil-works/pi-tui/dist/components/editor.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeTui = { requestRender() {} };
const theme = { selectList: {} };

function makeEditor() {
  return new Editor(fakeTui, theme);
}

async function flushDebounce() {
  // ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS is 20ms; give it room plus a microtask
  // flush for the awaited provider call.
  vi.advanceTimersByTime(25);
  await Promise.resolve();
  await Promise.resolve();
}

describe("autocomplete-doubled-trigger patch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-triggers on a doubled trigger char after a null-returning bare trigger", async () => {
    const getSuggestions = vi.fn(async (lines, cursorLine, cursorCol) => {
      const textBeforeCursor = (lines[cursorLine] || "").slice(0, cursorCol);
      return textBeforeCursor === "?"
        ? null
        : { prefix: "?", items: [{ label: "skill-a", value: "skill-a" }] };
    });
    const editor = makeEditor();
    editor.setAutocompleteProvider({
      triggerCharacters: ["?"],
      getSuggestions,
      applyCompletion: () => {},
    });

    editor.insertCharacter("?");
    await flushDebounce();
    editor.insertCharacter("?");
    await flushDebounce();

    expect(getSuggestions).toHaveBeenCalledTimes(2);
    expect(editor.isShowingAutocomplete()).toBe(true);
  });

  it("keeps the popup closed for a bare trigger with a null-returning provider", async () => {
    const getSuggestions = vi.fn(async () => null);
    const editor = makeEditor();
    editor.setAutocompleteProvider({
      triggerCharacters: ["?"],
      getSuggestions,
      applyCompletion: () => {},
    });

    editor.insertCharacter("?");
    await flushDebounce();

    expect(editor.isShowingAutocomplete()).toBe(false);
  });

  it("does not re-trigger on a mid-token doubled char", async () => {
    const getSuggestions = vi.fn(async () => null);
    const editor = makeEditor();
    editor.setAutocompleteProvider({
      triggerCharacters: ["?"],
      getSuggestions,
      applyCompletion: () => {},
    });

    editor.insertCharacter("x");
    editor.insertCharacter("?");
    await flushDebounce();
    editor.insertCharacter("?");
    await flushDebounce();

    expect(getSuggestions).not.toHaveBeenCalled();
  });

  it("leaves the default @ flow unaffected", async () => {
    const getSuggestions = vi.fn(async () => ({ prefix: "@", items: [{ label: "file-a", value: "file-a" }] }));
    const editor = makeEditor();
    editor.setAutocompleteProvider({
      triggerCharacters: ["@"],
      getSuggestions,
      applyCompletion: () => {},
    });

    editor.insertCharacter("@");
    await flushDebounce();
    editor.insertCharacter("@");
    await flushDebounce();

    expect(editor.isShowingAutocomplete()).toBe(true);
  });
});
