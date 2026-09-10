// First-run workspace scaffold. Ported from packages/desktop/src/main/workspace.ts
// (the desktop app seeds the workspace at launch; the standalone MCP server does
// the same before it serves any tool). Differences from the desktop version:
// no Electron IPC, no `sessions/` dir (that was pi session storage), and the
// workspace dir comes from ../config (ACCOUNTANT24_WORKSPACE) rather than env.ts.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ACCOUNTANT24_WORKSPACE } from "../config";
import { commitAll, initRepo } from "./git";
import gitignore from "./templates/gitignore.tmpl";
import accountsJournal from "./templates/ledger/accounts.journal";
import commoditiesJournal from "./templates/ledger/commodities.journal";
import mainJournal from "./templates/ledger/main.journal";

/** Workspace scaffold manifest: relative path -> file contents. memory.md
 *  starts empty. Kept in sync with the desktop template by templates.sync.test.ts. */
const TEMPLATE_FILES: Record<string, string> = {
  "memory.md": "",
  ".gitignore": gitignore,
  "ledger/accounts.journal": accountsJournal,
  "ledger/commodities.journal": commoditiesJournal,
  "ledger/main.journal": mainJournal,
};

/**
 * Seed a fresh workspace. Safe to call on every launch.
 *
 * If `ledger/main.journal` already exists the workspace is considered set up
 * and this is a complete no-op -- the desktop app owns an existing
 * `~/.accountant24` (its layout is maintained by the numbered migrations in
 * packages/desktop/src/main/migrations/), and the MCP server must not be a
 * second, unversioned writer to it. This only scaffolds a genuinely new dir.
 */
export async function ensureWorkspace(home: string = ACCOUNTANT24_WORKSPACE): Promise<void> {
  if (existsSync(join(home, "ledger", "main.journal"))) return;

  for (const dir of ["ledger", "files"]) {
    mkdirSync(join(home, dir), { recursive: true });
  }

  for (const [relPath, content] of Object.entries(TEMPLATE_FILES)) {
    const outputPath = join(home, relPath);
    mkdirSync(dirname(outputPath), { recursive: true });
    if (!existsSync(outputPath)) writeFileSync(outputPath, content);
  }

  const freshRepo = await initRepo(home);
  if (freshRepo) {
    await commitAll(home, "Initial Accountant24 setup");
  }
}
