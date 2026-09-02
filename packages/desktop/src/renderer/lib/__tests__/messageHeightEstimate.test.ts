import { describe, expect, it } from "vitest";
import { estimateMessageHeightPx, intrinsicSizeHint } from "../messageHeightEstimate";

// Spec constants (from messageHeightEstimate.ts):
//   CHARS_PER_LINE 88, LINE_PX 26, PART_SPACING_PX 12,
//   TOOL_PART_PX 96, MISC_PART_PX 28, USER_FLOOR_PX 44, ASSISTANT_FLOOR_PX 28
// A text part contributes  ceil(len / 88) * 26 + 12.

describe("estimateMessageHeightPx()", () => {
  describe("floors", () => {
    it("should return the user floor (44) for no parts and role user", () => {
      expect(estimateMessageHeightPx(undefined, "user")).toBe(44);
    });

    it("should return the assistant floor (28) for an empty parts array and role assistant", () => {
      expect(estimateMessageHeightPx([], "assistant")).toBe(28);
    });

    it("should treat an unknown role as non-user (floor 28)", () => {
      expect(estimateMessageHeightPx(undefined, undefined)).toBe(28);
    });

    it("should apply the user floor when content estimates below it", () => {
      // one line: ceil(1/88)*26 + 12 = 38, below the user floor of 44
      expect(estimateMessageHeightPx([{ type: "text", text: "a" }], "user")).toBe(44);
    });
  });

  describe("text parts", () => {
    it("should estimate 38 for a short single-line assistant text part", () => {
      // ceil(2/88)=1 -> 1*26 + 12 = 38
      expect(estimateMessageHeightPx([{ type: "text", text: "hi" }], "assistant")).toBe(38);
    });

    it("should wrap at 88 chars per line: 880 chars is 10 lines -> 272", () => {
      // ceil(880/88)=10 -> 10*26 + 12 = 272
      expect(estimateMessageHeightPx([{ type: "text", text: "x".repeat(880) }], "assistant")).toBe(272);
    });

    it("should round line count up, not down: 89 chars is 2 lines -> 64", () => {
      // ceil(89/88)=2 -> 2*26 + 12 = 64  (a floor()/round() bug would give 38)
      expect(estimateMessageHeightPx([{ type: "text", text: "y".repeat(89) }], "assistant")).toBe(64);
    });

    it("should scale linearly for very large text with no cap: 8800 chars -> 2612", () => {
      // ceil(8800/88)=100 -> 100*26 + 12 = 2612
      expect(estimateMessageHeightPx([{ type: "text", text: "z".repeat(8800) }], "assistant")).toBe(2612);
    });

    it("should count a reasoning part's text the same as a text part", () => {
      // ceil(176/88)=2 -> 2*26 + 12 = 64
      expect(estimateMessageHeightPx([{ type: "reasoning", text: "r".repeat(176) }], "assistant")).toBe(64);
    });
  });

  describe("non-text parts", () => {
    it("should charge 96 for a tool-call part", () => {
      expect(estimateMessageHeightPx([{ type: "tool-call" }], "assistant")).toBe(96);
    });

    it("should charge the misc fallback (28) for a part with no readable text", () => {
      expect(estimateMessageHeightPx([{ type: "image" }], "assistant")).toBe(28);
    });

    it("should charge the misc fallback for a null entry in the parts array", () => {
      expect(estimateMessageHeightPx([null], "assistant")).toBe(28);
    });

    it("should charge the misc fallback for a non-string text field", () => {
      expect(estimateMessageHeightPx([{ type: "text", text: 123 }], "assistant")).toBe(28);
    });
  });

  describe("multiple parts", () => {
    it("should sum a one-line reasoning part (38) and a tool call (96) -> 134", () => {
      expect(
        estimateMessageHeightPx(
          [
            { type: "reasoning", text: "w".repeat(88) },
            { type: "tool-call", toolName: "query" },
          ],
          "assistant",
        ),
      ).toBe(134);
    });

    it("should sum three short text parts: 3 * 38 = 114", () => {
      const parts = [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
        { type: "text", text: "three" },
      ];
      expect(estimateMessageHeightPx(parts, "assistant")).toBe(114);
    });
  });
});

describe("intrinsicSizeHint()", () => {
  it("should format as `auto <px>px`", () => {
    expect(intrinsicSizeHint([{ type: "text", text: "hi" }], "assistant")).toBe("auto 38px");
  });

  it("should use the role floor when there are no parts", () => {
    expect(intrinsicSizeHint(undefined, "user")).toBe("auto 44px");
    expect(intrinsicSizeHint([], "assistant")).toBe("auto 28px");
  });
});
