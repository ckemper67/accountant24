# Accountant24 on Nous Hermes

Run the Accountant24 agent's ledger tools inside [Nous Hermes][hermes], with no
dependency on the Electron app or the pi coding-agent runtime. Two pieces:

| Piece | What it is | Installed with |
| --- | --- | --- |
| **MCP server** (`accountant24-mcp.js`) | stdio server exposing `query`, `lookup`, `validate`, `add_transactions`, `add_balance_assertions`, `add_prices`, `bulk_edit`, `memory_edit`; scaffolds a fresh workspace on startup | `hermes mcp add` |
| **Skill** (`skills/finance/accountant/`) | the persona + procedure, and `reference/accountant-prompt.md` (the ported system prompt) | its own `scripts/install.sh` |

Hermes manages its own per-turn context and memory; this integration doesn't
inject either -- the model calls `lookup` / `query` when it needs ledger state,
and durable facts go in Hermes' own memory, not a separate file.

[hermes]: https://github.com/nousresearch/hermes-agent

## Prerequisites

- **Hermes** with `terminal.backend: local`. A stdio MCP server runs as a local
  subprocess on the Hermes host; on a Docker/SSH/Modal backend it and the
  agent's file tools would see different filesystems.
- **`hledger`** on `PATH` (the server checks `hledger --version` on startup and
  exits with an install message if missing).
- **Node** (to run the bundle) -- ships with Hermes.

## Get the MCP server

**Already have the Accountant24 desktop app installed?** `accountant24-mcp.js`
ships inside it (an `extraResources` entry, built alongside the pi extension
bundle) at a fixed path -- no checkout, no build step:

- macOS: `/Applications/Accountant24.app/Contents/Resources/accountant24-mcp.js`

**No desktop app, just this repo?** Build it from the repo root:

```sh
npm ci
node scripts/bundle-extension.ts
```

That writes `packages/pi-extension/dist/accountant24-mcp.js` (self-contained;
`dist/` is gitignored, so rebuild after pulling).

## Install

1. **MCP server**

   ```sh
   hermes mcp add accountant \
     --env ACCOUNTANT24_WORKSPACE=~/.accountant24 \
     --command node \
     --args /ABS/PATH/TO/accountant24-mcp.js
   ```

   `--args` must be the last option (it greedily consumes everything after
   it), so `--env` and `--command` come first. Use whichever path applies
   from "Get the MCP server" above. Confirmed live: connects and discovers all
   8 tools with their descriptions, then prompts to enable them. Say `y`.
   `terminal.backend: local` still needs to be set separately if it isn't
   already (see `config.example.yaml` for the hand-edit form of everything
   above, if you'd rather skip the CLI).

2. **Skill** -- there is no CLI install for a local skill directory (`hermes
   skills install` only takes a registry identifier or an HTTPS URL to a
   SKILL.md; `hermes skills tap add` only takes a GitHub repo), so this is a
   copy into `~/.hermes/skills/finance/accountant/`. The skill carries its own
   installer:

   ```sh
   packages/pi-extension/hermes/skills/finance/accountant/scripts/install.sh
   ```

   Re-run it after pulling to pick up skill updates -- it overwrites the
   previous copy. `HERMES_HOME` is honored if you don't use the default
   `~/.hermes`. This needs a checkout of this repo regardless of where the MCP
   server came from -- the skill isn't (yet) shipped inside the packaged app.

3. **Workspace** -- if `~/.accountant24` (or your chosen path) doesn't exist,
   the server scaffolds it (dirs, starter journals, empty `memory.md`, git
   repo) on first launch. If it already has a `ledger/main.journal` the server
   leaves it untouched -- in particular, the desktop app's own
   `~/.accountant24` is untouched.

## Verify

```sh
hermes mcp test accountant   # connection + tool discovery, no LLM call
```

In a Hermes session: `/reload-mcp` if the server was already running, then ask
a finance question, or `/accountant`.

## Notes

- **`ACCOUNTANT24_WORKSPACE`** must be set in the MCP server's `env:` (Hermes
  filters the stdio environment) -- that's what `--env` above does.
- **Writes are committed.** Every successful write commits the workspace git
  repo; a write that left the ledger invalid is left uncommitted so `git
  checkout` recovers it. This is more aggressive than the desktop app, which
  commits only when the agent asks.
- **`trust: untrusted`** in the `mcp_servers` block makes the five writers
  require approval; the read-only tools are annotated `readOnlyHint` and stay
  ungated.
- The `memory_edit` tool and `memory.md` exist for other MCP clients but the
  skill doesn't use them under Hermes -- see the note at the top.
