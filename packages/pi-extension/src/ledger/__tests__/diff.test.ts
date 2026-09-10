import { describe, expect, test } from "vitest";
import { generateDiffString } from "../diff";

/** Lines of a diff, for structural assertions. */
function rows(oldC: string, newC: string, ctx?: number): string[] {
  return generateDiffString(oldC, newC, ctx).diff.split("\n");
}

const lines = (n: number, prefix = "L") => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join("\n");

describe("generateDiffString()", () => {
  test("should return an empty diff and no firstChangedLine when nothing changed", () => {
    const r = generateDiffString("a\nb\nc\n", "a\nb\nc\n");
    expect(r.diff).toBe("");
    expect(r.firstChangedLine).toBeUndefined();
  });

  test("should mark added lines with +<lineno> and report the first changed line", () => {
    const r = generateDiffString("a\n", "a\nb\nc\n");
    expect(r.firstChangedLine).toBe(2);
    expect(r.diff.split("\n")).toEqual(expect.arrayContaining(["+2 b", "+3 c"]));
  });

  test("should mark removed lines with -<lineno>", () => {
    const r = rows("x\na\nb\n", "a\nb\n");
    expect(r).toEqual(expect.arrayContaining(["-1 x"]));
    // The trailing unchanged block (<= 2*ctx) is shown in full as context.
    expect(r).toEqual(expect.arrayContaining([" 2 a", " 3 b"]));
  });

  test("should show full context between two changes when the gap is small", () => {
    const oldC = `${lines(6)}\n`;
    const newC = oldC.replace("L1", "X1").replace("L6", "X6");
    const r = rows(oldC, newC);
    // L2..L5 are the interior context, all shown (gap 4 <= 2*ctx).
    expect(r).toEqual(expect.arrayContaining([" 2 L2", " 3 L3", " 4 L4", " 5 L5"]));
    expect(r).not.toContain(" ...".padStart(6));
  });

  test("should elide the middle of a large gap between two changes", () => {
    const body = lines(30);
    const oldC = `HEAD\n${body}\nTAIL\n`;
    const newC = `head\n${body}\ntail\n`;
    const r = rows(oldC, newC);
    expect(r.some((l) => l.trimStart().startsWith("..."))).toBe(true);
    // 4 leading + 4 trailing context rows around the ellipsis.
    expect(r.filter((l) => /^ +\d+ L\d+$/.test(l)).length).toBe(8);
  });

  test("should elide leading context far from the only change", () => {
    const head = lines(20);
    const r = rows(`${head}\nEND\n`, `${head}\nend\n`);
    expect(r.some((l) => l.trimStart().startsWith("..."))).toBe(true);
    // Only the 4 rows just before the change are kept.
    expect(r.filter((l) => /^ +\d+ L\d+$/.test(l)).length).toBe(4);
  });

  test("should elide trailing context far from the only change", () => {
    const tail = lines(20);
    const r = rows(`START\n${tail}\n`, `start\n${tail}\n`);
    expect(r.some((l) => l.trimStart().startsWith("..."))).toBe(true);
    expect(r.filter((l) => /^ +\d+ L\d+$/.test(l)).length).toBe(4);
  });

  test("should keep a short trailing context block without an ellipsis", () => {
    const r = rows("START\nt1\nt2\n", "start\nt1\nt2\n");
    expect(r).toEqual(expect.arrayContaining(["-1 START", "+1 start", " 2 t1", " 3 t2"]));
    expect(r.some((l) => l.trimStart().startsWith("..."))).toBe(false);
  });

  test("should keep a short leading context block without an ellipsis", () => {
    const r = rows("h1\nh2\nEND\n", "h1\nh2\nend\n");
    expect(r).toEqual(expect.arrayContaining([" 1 h1", " 2 h2", "-3 END", "+3 end"]));
    expect(r.some((l) => l.trimStart().startsWith("..."))).toBe(false);
  });

  test("should handle new content that does not end in a newline", () => {
    const r = generateDiffString("a\nb\n", "a\nB");
    expect(r.diff.split("\n")).toEqual(expect.arrayContaining(["-2 b", "+2 B"]));
  });
});
