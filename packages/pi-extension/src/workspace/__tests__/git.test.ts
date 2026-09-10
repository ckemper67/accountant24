import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { commitAll, initRepo } from "../git";

// Real git against real temp repos -- the I/O boundary these helpers exist for.
const BASE = mkdtempSync(join(tmpdir(), "a24-mcp-git-"));

afterAll(() => rmSync(BASE, { recursive: true, force: true }));

function freshDir(): string {
  return mkdtempSync(join(BASE, "repo-"));
}

function setIdentity(dir: string): void {
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

function log(dir: string): string {
  return spawnSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" }).stdout ?? "";
}

describe("initRepo()", () => {
  test("should create a .git directory and return true on a fresh dir", async () => {
    const dir = freshDir();
    expect(await initRepo(dir)).toBe(true);
    expect(existsSync(join(dir, ".git"))).toBe(true);
  });

  test("should return false when the directory is already a repo", async () => {
    const dir = freshDir();
    await initRepo(dir);
    expect(await initRepo(dir)).toBe(false);
  });
});

describe("commitAll()", () => {
  test("should stage and commit every file with the given message", async () => {
    const dir = freshDir();
    await initRepo(dir);
    setIdentity(dir);
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "b.txt"), "b");

    await commitAll(dir, "Initial Accountant24 setup");

    expect(log(dir)).toContain("Initial Accountant24 setup");
    const tracked = spawnSync("git", ["ls-files"], { cwd: dir, encoding: "utf8" }).stdout;
    expect(tracked).toContain("a.txt");
    expect(tracked).toContain("b.txt");
  });

  test("should not create a commit when there is nothing to commit", async () => {
    const dir = freshDir();
    await initRepo(dir);
    setIdentity(dir);
    writeFileSync(join(dir, "a.txt"), "a");
    await commitAll(dir, "first");

    await commitAll(dir, "second");

    expect(log(dir)).not.toContain("second");
  });
});

describe("when git is not installed", () => {
  let previousPath: string | undefined;

  beforeEach(() => {
    previousPath = process.env.PATH;
    // A PATH with no git in it: the spawn fails with ENOENT, the same way it
    // would on a machine without git.
    process.env.PATH = join(BASE, "no-such-bin");
    return () => {
      process.env.PATH = previousPath;
    };
  });

  test("initRepo() should resolve false instead of throwing", async () => {
    await expect(initRepo(freshDir())).resolves.toBe(false);
  });

  test("commitAll() should resolve instead of throwing", async () => {
    await expect(commitAll(freshDir(), "message")).resolves.toBeUndefined();
  });
});
