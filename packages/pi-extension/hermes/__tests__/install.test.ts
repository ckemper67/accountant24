import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

// There is no Hermes CLI command to install a skill from a local directory
// (`hermes skills install` wants a registry id or an HTTPS URL; `hermes
// skills tap add` wants a GitHub repo), so the skill ships its own installer.
// This runs it against a fake HERMES_HOME the way a real install would.

const SKILL_DIR = join(import.meta.dirname, "..", "skills", "finance", "accountant");
const INSTALL_SH = join(SKILL_DIR, "scripts", "install.sh");

let HERMES_HOME = "";

beforeEach(() => {
  HERMES_HOME = mkdtempSync(join(tmpdir(), "a24-hermes-home-"));
});

afterEach(() => rmSync(HERMES_HOME, { recursive: true, force: true }));

function run(env: Record<string, string> = {}): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("bash", [INSTALL_SH], { encoding: "utf8", env: { ...process.env, ...env } });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", status: e.status ?? 1 };
  }
}

describe("skills/finance/accountant/scripts/install.sh", () => {
  test("should copy the skill into $HERMES_HOME/skills/finance/accountant", () => {
    const { status } = run({ HERMES_HOME });
    expect(status).toBe(0);
    const dest = join(HERMES_HOME, "skills", "finance", "accountant");
    expect(existsSync(join(dest, "SKILL.md"))).toBe(true);
    expect(existsSync(join(dest, "reference", "accountant-prompt.md"))).toBe(true);
    expect(existsSync(join(dest, "scripts", "install.sh"))).toBe(true);
  });

  test("should default to ~/.hermes when HERMES_HOME is unset", () => {
    const home = mkdtempSync(join(tmpdir(), "a24-home-"));
    try {
      const { status } = run({ HOME: home, HERMES_HOME: "" });
      expect(status).toBe(0);
      expect(existsSync(join(home, ".hermes", "skills", "finance", "accountant", "SKILL.md"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("should overwrite a previous install rather than merge stale files into it", () => {
    const dest = join(HERMES_HOME, "skills", "finance", "accountant");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "stale.md"), "leftover from an older version");

    run({ HERMES_HOME });

    expect(existsSync(join(dest, "stale.md"))).toBe(false);
    expect(existsSync(join(dest, "SKILL.md"))).toBe(true);
  });

  test("should be safe to run twice in a row", () => {
    expect(run({ HERMES_HOME }).status).toBe(0);
    const { status } = run({ HERMES_HOME });
    expect(status).toBe(0);
    expect(existsSync(join(HERMES_HOME, "skills", "finance", "accountant", "SKILL.md"))).toBe(true);
  });
});
