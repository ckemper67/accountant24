import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scratchRoot } from "../scratch";

describe("scratchRoot()", () => {
  const original = process.env.ACCOUNTANT24_SCRATCH_DIR;

  beforeEach(() => {
    delete process.env.ACCOUNTANT24_SCRATCH_DIR;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.ACCOUNTANT24_SCRATCH_DIR;
    else process.env.ACCOUNTANT24_SCRATCH_DIR = original;
  });

  it("should return the OS temp dir when ACCOUNTANT24_SCRATCH_DIR is unset", () => {
    expect(scratchRoot()).toBe(tmpdir());
  });

  it("should return the OS temp dir when ACCOUNTANT24_SCRATCH_DIR is empty", () => {
    process.env.ACCOUNTANT24_SCRATCH_DIR = "";
    expect(scratchRoot()).toBe(tmpdir());
  });

  it("should return ACCOUNTANT24_SCRATCH_DIR when it is set to a path", () => {
    process.env.ACCOUNTANT24_SCRATCH_DIR = "/mnt/workspace/.scratch";
    expect(scratchRoot()).toBe("/mnt/workspace/.scratch");
  });
});
