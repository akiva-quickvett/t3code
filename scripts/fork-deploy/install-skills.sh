#!/usr/bin/env bash
# Link the fork checkout's t3-orchestration skill into every Claude config dir,
# Codex's skills dir and ~/.agents/skills (L34). T3_DEPLOY_SKILL_DIRS
# (colon-separated skills dirs) replaces the discovery.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CHECK=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --check) CHECK=1 ;;
    *)
      echo "usage: install-skills.sh [--check] [--dry-run]" >&2
      exit 2
      ;;
  esac
done

SOURCE="$CHECKOUT/.agents/skills/t3-orchestration"
[[ -f $SOURCE/SKILL.md ]] || die "skill source $SOURCE/SKILL.md is missing; land the skill in the fork checkout first, or pass --no-skills to swap.sh"
[[ $CHECK == 0 ]] || exit 0

if [[ -n ${T3_DEPLOY_SKILL_DIRS:-} ]]; then
  IFS=: read -ra dirs <<<"$T3_DEPLOY_SKILL_DIRS"
else
  dirs=()
  while IFS= read -r dir; do dirs+=("$dir"); done < <(helper skill-dirs "$USERDATA/settings.json")
fi

for dir in "${dirs[@]}"; do
  link="$dir/t3-orchestration"
  if [[ -e $link && ! -L $link ]]; then
    # A real copy from before the move: set aside, never delete.
    run mv "$link" "$link.bak-$TS"
  fi
  run mkdir -p "$dir"
  run ln -sfn "$SOURCE" "$link"
done
[[ $DRY_RUN == 1 ]] || log "t3-orchestration linked into ${#dirs[@]} skills dir(s)"
