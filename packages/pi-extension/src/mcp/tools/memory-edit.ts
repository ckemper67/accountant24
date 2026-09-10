import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { MEMORY_PATH } from "../../config";
import { generateDiffString } from "../../ledger/diff";
import { writerMutex } from "../mutex";
import type { McpToolSpec } from "../registry";
import { commitWorkspace, errorText, text } from "./_shared";

function readMemory(): string {
  try {
    return existsSync(MEMORY_PATH) ? readFileSync(MEMORY_PATH, "utf8") : "";
  } catch {
    return "";
  }
}

/**
 * Apply an anchored replacement to memory.md and return the new content.
 *
 * Rules (the reason memory_edit exists instead of a raw file write):
 *  - Empty memory: `oldText` must be empty; `newText` becomes the whole file.
 *  - Non-empty memory: `oldText` must match exactly once. Zero matches or
 *    several are rejected -- the caller must anchor with more context.
 *  - Replacing the entire current content in one call is rejected as a
 *    wholesale rewrite; edits must be incremental.
 *
 * Exported for direct testing.
 */
export function applyMemoryEdit(current: string, oldText: string, newText: string): string {
  if (current.trim() === "") {
    if (oldText !== "") {
      throw new Error("memory.md is empty. Pass an empty oldText to create it with newText.");
    }
    return newText;
  }

  if (oldText === "") {
    throw new Error("oldText is required: give an exact, unique snippet of the current memory to replace.");
  }
  if (oldText.trim() === current.trim()) {
    throw new Error(
      "That oldText spans the whole file -- a wholesale rewrite is not allowed. Make a smaller, targeted edit.",
    );
  }

  const first = current.indexOf(oldText);
  if (first === -1) {
    throw new Error("oldText was not found in memory.md. Read the file and copy an exact snippet.");
  }
  if (current.indexOf(oldText, first + oldText.length) !== -1) {
    throw new Error("oldText appears more than once in memory.md. Include more surrounding context to make it unique.");
  }
  return current.slice(0, first) + newText + current.slice(first + oldText.length);
}

const inputSchema = {
  oldText: z
    .string()
    .describe(
      "An exact, unique snippet of the current memory.md to replace. Pass an empty string only to " +
        "create memory.md for the first time.",
    ),
  newText: z.string().describe("The replacement text for oldText."),
};

export const memoryEditSpec: McpToolSpec<typeof inputSchema> = {
  name: "memory_edit",
  config: {
    title: "Edit memory",
    description:
      "The only sanctioned way to change memory.md. Give `oldText` (an exact, unique snippet of the " +
      "current memory) and the `newText` to put in its place; pass an empty `oldText` to create the " +
      "file the first time. Wholesale rewrites of a non-empty memory are refused -- make small, " +
      "targeted edits. The change is committed to the workspace git repo.",
    inputSchema,
  },
  handler(args) {
    return writerMutex.runExclusive(async () => {
      try {
        const current = readMemory();
        const next = applyMemoryEdit(current, args.oldText as string, args.newText as string);
        writeFileSync(MEMORY_PATH, next);
        await commitWorkspace("Update memory");
        const { diff } = generateDiffString(current, next);
        return text(
          diff ? `memory.md updated:\n\n${diff}` : "memory.md unchanged (oldText and newText are identical).",
        );
      } catch (err) {
        return errorText(err);
      }
    });
  },
};
