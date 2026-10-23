#!/usr/bin/env bash
# Swap the live server to a build: idle check -> free-space check -> stop ->
# back up userdata -> flip ~/t3-builds/current -> start -> health, with an
# automatic rollback. See docs/operations/fork-deploy.md.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  echo "usage: swap.sh <build-dir> [--dry-run] [--foreground] [--no-skills]" >&2
  exit 2
}

BUILD="" SKILLS=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --foreground) FOREGROUND=1 ;;
    --no-skills) SKILLS=0 ;;
    -*) usage ;;
    *) BUILD="$arg" ;;
  esac
done
[[ -n $BUILD ]] || usage
BUILD="$(cd "$BUILD" && pwd -P)"

require_build "$BUILD"
[[ -f $USERDATA/statev2.sqlite ]] || die "no database at $USERDATA/statev2.sqlite"
[[ $SKILLS == 0 ]] || "$FORK_DEPLOY_DIR/install-skills.sh" --check
PREVIOUS="$(current_build)"
PREVIOUS_LINK="$(previous_link)"
[[ $PREVIOUS != "$BUILD" ]] || die "$BUILD is already current"
[[ $FOREGROUND == 0 || $DRY_RUN == 1 ]] || refuse_inside_session
require_single_pane

args=("$BUILD")
[[ $SKILLS == 1 ]] || args+=(--no-skills)
detach_unless_foreground "" "${args[@]}"

BACKUP="$USERDATA.bak-$TS"

# Between the stop and the new build's start, any failure would leave the
# server down. If the old server never let go, starting another against its
# lock would only fail, so that case is reported and left alone.
on_abort_after_stop() {
  set +e
  if [[ $STOPPED == 0 ]]; then
    log "swap aborted: the server was sent Ctrl-C but did not stop; not starting another. It may not come back: inspect tmux session '$SESSION'"
    return
  fi
  log "swap aborted after stop; restarting $PREVIOUS (backup, possibly partial: $BACKUP)"
  flip_to "$PREVIOUS" "$PREVIOUS_LINK"
  start_server "$PREVIOUS"
  wait_healthy || log "previous build $PREVIOUS is not healthy either; inspect tmux session '$SESSION'"
}

log "swap $PREVIOUS -> $BUILD"
check_free_space
wait_until_idle || die "still busy after ${IDLE_WAIT_MINUTES}m; aborting, server left running"

trap on_abort_after_stop EXIT
stop_server
run cp -a "$USERDATA" "$BACKUP"
flip_to "$BUILD" "$PREVIOUS"
start_server "$BUILD"
trap - EXIT

if ! wait_healthy; then
  rollback_to "$PREVIOUS" "$BACKUP" "$PREVIOUS_LINK"
  die "swap failed; rolled back to $PREVIOUS (failed state in $USERDATA.failed-$TS)"
fi

if [[ $SKILLS == 1 ]]; then
  # The new build is already live: a skill link failure is reported, not rolled back.
  if [[ $DRY_RUN == 1 ]]; then
    "$FORK_DEPLOY_DIR/install-skills.sh" --dry-run
  else
    "$FORK_DEPLOY_DIR/install-skills.sh" || log "WARNING: skill install failed; rerun install-skills.sh"
  fi
fi
log "swap done: $BUILD is live; backup at $BACKUP"
