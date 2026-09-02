import { describe, expect, it } from "vitest";
import { estimateMessageHeightPx, intrinsicSizeHint } from "../messageHeightEstimate";

// Spec constants (from messageHeightEstimate.ts):
//   CHARS_PER_LINE 88, LINE_PX 26, PART_SPACING_PX 12, MAX_TEXT_PART_PX 4000,
//   CHAIN_TRIGGER_PX 44, MISC_PART_PX 28, USER_FLOOR_PX 44, ASSISTANT_FLOOR_PX 28
// A text part contributes  min(ceil(len / 88) * 26 + 12, 4000).
// Reasoning / tool-call parts render collapsed: they add nothing individually,
// but a message with any of them adds one CHAIN_TRIGGER_PX (44).

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

    it("should scale linearly under the cap: 3520 chars -> 1052", () => {
      // ceil(3520/88)=40 -> 40*26 + 12 = 1052, still below MAX_TEXT_PART_PX
      expect(estimateMessageHeightPx([{ type: "text", text: "z".repeat(3520) }], "assistant")).toBe(1052);
    });

    it("should cap a single huge text part at 4000", () => {
      // ceil(200000/88)=2273 -> 2273*26 + 12 = 59110, capped to 4000
      expect(estimateMessageHeightPx([{ type: "text", text: "z".repeat(200_000) }], "assistant")).toBe(4000);
    });

    it("should charge nothing for an empty text part (floor wins)", () => {
      expect(estimateMessageHeightPx([{ type: "text", text: "" }], "assistant")).toBe(28);
    });

    it("should still count a real text part alongside an empty one", () => {
      // "" -> 0, "hi" -> 38
      const parts = [
        { type: "text", text: "" },
        { type: "text", text: "hi" },
      ];
      expect(estimateMessageHeightPx(parts, "assistant")).toBe(38);
    });
  });

  describe("collapsed chain parts (reasoning / tool-call)", () => {
    it("should charge one trigger row (44) for a lone reasoning part regardless of its text length", () => {
      expect(estimateMessageHeightPx([{ type: "reasoning", text: "r".repeat(5000) }], "assistant")).toBe(44);
    });

    it("should charge one trigger row (44) for a lone tool-call part", () => {
      expect(estimateMessageHeightPx([{ type: "tool-call", toolName: "query" }], "assistant")).toBe(44);
    });

    it("should charge the trigger row only once for several chain parts", () => {
      const parts = [
        { type: "reasoning", text: "first" },
        { type: "tool-call", toolName: "a" },
        { type: "reasoning", text: "second" },
        { type: "tool-call", toolName: "b" },
      ];
      expect(estimateMessageHeightPx(parts, "assistant")).toBe(44);
    });
  });

  describe("non-text, non-chain parts", () => {
    it("should charge the misc fallback (28) for a typed part with no readable text", () => {
      expect(estimateMessageHeightPx([{ type: "image" }], "assistant")).toBe(28);
    });

    it("should charge nothing for a null entry in the parts array (floor wins)", () => {
      expect(estimateMessageHeightPx([null], "assistant")).toBe(28);
    });

    it("should treat a text part with a non-string text field as empty (floor wins)", () => {
      expect(estimateMessageHeightPx([{ type: "text", text: 123 }], "assistant")).toBe(28);
    });
  });

  describe("multiple parts", () => {
    it("should sum a text answer (38) and a collapsed chain (44) -> 82", () => {
      const parts = [
        { type: "reasoning", text: "w".repeat(88) },
        { type: "tool-call", toolName: "query" },
        { type: "text", text: "here is the answer" },
      ];
      expect(estimateMessageHeightPx(parts, "assistant")).toBe(38 + 44);
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
