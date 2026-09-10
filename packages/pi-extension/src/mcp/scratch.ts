import { tmpdir } from "node:os";

/**
 * Root directory for `query` spill-to-disk scratch files.
 *
 * Nous Hermes runs a stdio MCP server as a local subprocess on the Hermes
 * host, so on the default `local` terminal backend the server shares a
 * filesystem with the agent's file-read tool and `os.tmpdir()` is safe -- the
 * same choice `ledger/query.ts` already bakes in.
 *
 * `ACCOUNTANT24_SCRATCH_DIR` overrides it for the one case where the two
 * diverge: a non-local backend (Docker/SSH/Modal) where the workspace is a
 * shared mount. Point it at a gitignored directory inside that mount so the
 * agent can read what the server wrote.
 */
export function scratchRoot(): string {
  const override = process.env.ACCOUNTANT24_SCRATCH_DIR;
  return override && override.length > 0 ? override : tmpdir();
}
