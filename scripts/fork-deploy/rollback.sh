#!/usr/bin/env bash
# Put the previous build back by hand: idle check -> stop -> restore a backup
# (or keep today's data) -> flip current back -> start -> health.
# swap.sh runs the same steps itself when its health check fails.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat >&2 <<'EOF'
usage: rollback.sh (--restore <latest|backup-dir> | --keep-data) [--to <build-dir>]
                   [--force] [--dry-run] [--foreground]
  --restore    replace userdata with a backup (discards everything since that swap)
  --keep-data  run the previous build on the current userdata
  --to         build to return to (default: ~/t3-builds/previous)
  --force      skip the idle check
EOF
  exit 2
}

TARGET="" RESTORE="" KEEP=0 FORCE=0
original_args=("$@")
while (($#)); do
  case "$1" in
    --restore)
      RESTORE="${2:-}"
      shift
      ;;
    --keep-data) KEEP=1 ;;
    --to)
      TARGET="${2:-}"
      shift
      ;;
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --foreground) FOREGROUND=1 ;;
    *) usage ;;
  esac
  shift
done
[[ -n $RESTORE || $KEEP == 1 ]] || usage
[[ -z $RESTORE || $KEEP == 0 ]] || usage

if [[ -z $TARGET ]]; then
  [[ -L $BUILDS/previous ]] || die "no $BUILDS/previous; pass --to <build-dir>"
  TARGET="$(readlink "$BUILDS/previous")"
fi
require_build "$TARGET"
[[ $TARGET != "$(current_build)" ]] || die "$TARGET is already current"

if [[ $RESTORE == latest ]]; then
  RESTORE="$(find "$T3_HOME" -maxdepth 1 -name 'userdata.bak-*' -type d | sort | tail -n 1)"
  [[ -n $RESTORE ]] || die "no userdata.bak-* in $T3_HOME"
  log "latest backup is $(basename "$RESTORE") (taken ${RESTORE##*.bak-} UTC)"
fi
[[ -z $RESTORE || -d $RESTORE ]] || die "no backup at $RESTORE"
[[ $FOREGROUND == 0 || $DRY_RUN == 1 ]] || refuse_inside_session
require_single_pane

detach_unless_foreground "-rollback" "${original_args[@]}"

if [[ $FORCE == 0 ]]; then
  wait_until_idle || die "still busy after ${IDLE_WAIT_MINUTES}m; aborting (--force skips this)"
fi
rollback_to "$TARGET" "$RESTORE" "$(current_build)"
