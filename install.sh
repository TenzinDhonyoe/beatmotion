#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/TenzinDhonyoe/beatmotion.git"
SKILL_SUBPATH=".claude/skills/beatmotion"

target_root="$(pwd)"
force=0
for arg in "$@"; do
  case "$arg" in
    --user)  target_root="$HOME" ;;
    --force) force=1 ;;
    -h|--help)
      echo "Usage: install.sh [--user] [--force]"
      echo "  --user   install at ~/.claude/skills/ (default: ./.claude/skills/)"
      echo "  --force  overwrite an existing skill directory"
      exit 0
      ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

dest="$target_root/$SKILL_SUBPATH"
if [ -e "$dest" ] && [ "$force" -ne 1 ]; then
  echo "Refusing to overwrite $dest (pass --force to replace)." >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git clone --depth 1 --quiet "$REPO" "$tmp/beatmotion"

mkdir -p "$(dirname "$dest")"
rm -rf "$dest"
mv "$tmp/beatmotion/$SKILL_SUBPATH" "$dest"

echo "Installed beatmotion at $dest"
echo "Open Claude Code in this project and say: 'sync animations to song.mp3'"
