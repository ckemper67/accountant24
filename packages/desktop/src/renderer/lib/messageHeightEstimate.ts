// A rough, content-derived estimate of a rendered chat message's pixel height.
//
// Off-screen messages carry `content-visibility: auto`, so the browser skips
// their layout and paints them at their `contain-intrinsic-size` until they are
// scrolled into view once. A flat placeholder (the old `auto 24px` / `auto
// 60px`) is off by 10-100x for a real answer, so the scroll container is
// mis-sized and the scrollbar lurches as the reader scrolls a long transcript
// for the first time. Feeding a proportional estimate here keeps that first
// pass stable; the CSS `auto` keyword then remembers the real measured size.
//
// This is a deliberately cheap heuristic (O(parts), no text scan beyond
// `.length`), not a layout engine. Being roughly proportional is the whole
// job; exactness is not needed.

/** The shape this estimator reads off an assistant-ui message part. Everything
 *  is optional so an unknown part type degrades to the misc-part fallback. */
export interface EstimableMessagePart {
  type?: string;
  text?: string;
}

/** Characters that fit on one line in the ~44rem chat column at 16px. */
const CHARS_PER_LINE = 88;
/** Height of one wrapped text line (16px text, leading-relaxed). */
const LINE_PX = 26;
/** Vertical breathing room a rendered part adds beyond its text lines. */
const PART_SPACING_PX = 12;
/** A tool call renders as a collapsed card / chain-of-thought step. */
const TOOL_PART_PX = 96;
/** A part with no readable text (image, data, indicator, unknown). */
const MISC_PART_PX = 28;
/** Minimum for a user message: an empty bubble is still this tall. */
const USER_FLOOR_PX = 44;
/** Minimum for an assistant message. */
const ASSISTANT_FLOOR_PX = 28;

/** Estimate the rendered height, in CSS pixels, of a chat message with the
 *  given parts and role. `parts` is typed loosely (`unknown[]`) to match the
 *  assistant-ui message state without importing its part union; unrecognised
 *  shapes fall through to the misc-part fallback. Never returns less than the
 *  role's floor. */
export function estimateMessageHeightPx(parts: readonly unknown[] | undefined, role: string | undefined): number {
  const floor = role === "user" ? USER_FLOOR_PX : ASSISTANT_FLOOR_PX;
  if (!parts || parts.length === 0) return floor;

  let px = 0;
  for (const raw of parts) {
    const part = (raw ?? {}) as EstimableMessagePart;
    if (part.type === "tool-call") {
      px += TOOL_PART_PX;
      continue;
    }
    const text = typeof part.text === "string" ? part.text : "";
    if (text.length === 0) {
      px += MISC_PART_PX;
      continue;
    }
    px += Math.ceil(text.length / CHARS_PER_LINE) * LINE_PX + PART_SPACING_PX;
  }
  return Math.max(px, floor);
}

/** The `contain-intrinsic-size` value for a message: `auto` (so the real size
 *  is remembered once measured) plus the estimated placeholder. */
export function intrinsicSizeHint(parts: readonly unknown[] | undefined, role: string | undefined): string {
  return `auto ${estimateMessageHeightPx(parts, role)}px`;
}
