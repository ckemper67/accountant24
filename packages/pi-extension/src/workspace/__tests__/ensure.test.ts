import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ensureWorkspace } from "../ensure";

// Real fs + real git over a temp dir -- what the scaffold leaves on disk is the
// whole point of it.
let BASE = "";
let savedGitEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  BASE = mkdtempSync(join(tmpdir(), "a24-mcp-ensure-"));
  // Hermetic commit identity, so `git commit` succeeds without a global config.
  savedGitEnv = {
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
  };
  process.env.GIT_AUTHOR_NAME = "Test";
  process.env.GIT_AUTHOR_EMAIL = "test@test.com";
  process.env.GIT_COMMITTER_NAME = "Test";
  process.env.GIT_COMMITTER_EMAIL = "test@test.com";
});

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedGitEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const TEMPLATE_FILES = [
  "memory.md",
  ".gitignore",
  "ledger/accounts.journal",
  "ledger/commodities.journal",
  "ledger/main.journal",
];

function gitLog(): string {
  return spawnSync("git", ["log", "--oneline"], { cwd: BASE, encoding: "utf8" }).stdout ?? "";
}

describe("ensureWorkspace()", () => {
  test("should create the ledger and files directories", async () => {
    await ensureWorkspace(BASE);
    expect(existsSync(join(BASE, "ledger"))).toBe(true);
    expect(existsSync(join(BASE, "files"))).toBe(true);
  });

  test("should not create a sessions directory (that was pi session storage)", async () => {
    await ensureWorkspace(BASE);
    expect(existsSync(join(BASE, "sessions"))).toBe(false);
  });

  test("should write every template file", async () => {
    await ensureWorkspace(BASE);
    for (const rel of TEMPLATE_FILES) {
      expect(existsSync(join(BASE, rel))).toBe(true);
    }
  });

  test("should start memory.md empty", async () => {
    await ensureWorkspace(BASE);
    expect(readFileSync(join(BASE, "memory.md"), "utf8")).toBe("");
  });

  test("should seed the chart of accounts and the main journal's includes", async () => {
    await ensureWorkspace(BASE);
    expect(readFileSync(join(BASE, "ledger/accounts.journal"), "utf8")).toContain("account Assets:Cash");
    const main = readFileSync(join(BASE, "ledger/main.journal"), "utf8");
    expect(main).toContain("include commodities.journal");
    expect(main).toContain("include accounts.journal");
  });

  test("should ignore auth.json and the uv dir", async () => {
    await ensureWorkspace(BASE);
    const ignore = readFileSync(join(BASE, ".gitignore"), "utf8");
    expect(ignore).toContain("auth.json");
    expect(ignore).toContain("uv/");
  });

  test("should initialize a git repo with an initial commit", async () => {
    await ensureWorkspace(BASE);
    expect(existsSync(join(BASE, ".git"))).toBe(true);
    expect(gitLog()).toContain("Initial Accountant24 setup");
  });

  test("should not overwrite an existing file on a second run", async () => {
    await ensureWorkspace(BASE);
    writeFileSync(join(BASE, "memory.md"), "## user edits\n- keep me\n");

    await ensureWorkspace(BASE);

    expect(readFileSync(join(BASE, "memory.md"), "utf8")).toBe("## user edits\n- keep me\n");
  });

  test("should not create a second commit on an unchanged second run", async () => {
    await ensureWorkspace(BASE);
    const before = gitLog().trim().split("\n").length;

    await ensureWorkspace(BASE);

    expect(gitLog().trim().split("\n").length).toBe(before);
  });

  test("should scaffold a partial directory that has files but no main journal", async () => {
    writeFileSync(join(BASE, "memory.md"), "existing\n");
    await expect(ensureWorkspace(BASE)).resolves.toBeUndefined();
    expect(readFileSync(join(BASE, "memory.md"), "utf8")).toBe("existing\n");
    expect(existsSync(join(BASE, "ledger/accounts.journal"))).toBe(true);
    expect(existsSync(join(BASE, "ledger/main.journal"))).toBe(true);
  });

  test("should be a complete no-op when ledger/main.journal already exists", async () => {
    mkdirSync(join(BASE, "ledger"), { recursive: true });
    writeFileSync(join(BASE, "ledger/main.journal"), "; user's own journal\n");

    await ensureWorkspace(BASE);

    expect(readFileSync(join(BASE, "ledger/main.journal"), "utf8")).toBe("; user's own journal\n");
    expect(existsSync(join(BASE, "files"))).toBe(false);
    expect(existsSync(join(BASE, ".gitignore"))).toBe(false);
    expect(existsSync(join(BASE, ".git"))).toBe(false);
  });
});
