#!/usr/bin/env bash
#
# Install (or reinstall) this skill into Hermes' skills directory.
#
# There is no CLI command for installing a skill from a local directory
# (`hermes skills install` only takes a registry identifier or an HTTPS URL to
# a SKILL.md; `hermes skills tap add` only takes a GitHub repo) -- see
# packages/pi-extension/hermes/README.md. This script is the copy step.
#
# Run from anywhere; it resolves its own location, so it works from any
# checkout of this repo. Re-run after pulling to pick up skill updates --
# it overwrites the previous copy, so don't hand-edit the installed one.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)" # .../skills/finance/accountant
DEST="${HERMES_HOME:-$HOME/.hermes}/skills/finance/accountant"

if [ ! -f "$SKILL_DIR/SKILL.md" ]; then
  echo "error: $SKILL_DIR does not look like a skill (no SKILL.md)" >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -R "$SKILL_DIR" "$DEST"

echo "Installed the accountant skill to $DEST"
