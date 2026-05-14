#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/TenzinDhonyoe/beatmotion.git"
SKILL_SUBPATH=".claude/skills/beatmotion"
COMMAND_SUBPATH=".claude/commands/sync-beat.md"

target_root="$(pwd)"
force=0
for arg in "$@"; do
  case "$arg" in
    --user)  target_root="$HOME" ;;
    --force) force=1 ;;
    -h|--help)
      echo "Usage: install.sh [--user] [--force]"
      echo "  --user   install at ~/.claude/ (default: ./.claude/)"
      echo "  --force  overwrite existing skill / command files"
      exit 0
      ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

skill_dest="$target_root/$SKILL_SUBPATH"
command_dest="$target_root/$COMMAND_SUBPATH"

if [ "$force" -ne 1 ]; then
  if [ -e "$skill_dest" ]; then
    echo "Refusing to overwrite $skill_dest (pass --force to replace)." >&2
    exit 1
  fi
  if [ -e "$command_dest" ]; then
    echo "Refusing to overwrite $command_dest (pass --force to replace)." >&2
    exit 1
  fi
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git clone --depth 1 --quiet "$REPO" "$tmp/beatmotion"

mkdir -p "$(dirname "$skill_dest")"
rm -rf "$skill_dest"
mv "$tmp/beatmotion/$SKILL_SUBPATH" "$skill_dest"

mkdir -p "$(dirname "$command_dest")"
rm -f "$command_dest"
mv "$tmp/beatmotion/$COMMAND_SUBPATH" "$command_dest"

echo "Installed beatmotion:"
echo "  skill   → $skill_dest"
echo "  command → $command_dest"
echo
echo "Open Claude Code in this project, drop an audio file in, and type: /sync-beat"
