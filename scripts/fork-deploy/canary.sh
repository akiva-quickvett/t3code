#!/usr/bin/env bash
# Seed ~/.t3-canary from live state with migrate-dev-db (sanitised, not a raw
# copy) and serve a build on :8450 in tmux session t3code-canary.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat >&2 <<'EOF'
usage: canary.sh <build-dir> [--projects N] [--threads-per-project N] [--with-secrets] [--dry-run]
EOF
  exit 2
}

BUILD="" PROJECTS=5 THREADS=10 SECRETS=0
while (($#)); do
  case "$1" in
    --projects)
      PROJECTS="${2:-}"
      shift
      ;;
    --threads-per-project)
      THREADS="${2:-}"
      shift
      ;;
    --with-secrets) SECRETS=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -*) usage ;;
    *) BUILD="$1" ;;
  esac
  shift
done
[[ -n $BUILD ]] || usage
BUILD="$(cd "$BUILD" && pwd -P)"
require_build "$BUILD"

# Live state is only read (migrate-dev-db snapshots it read-only); everything
# written goes to the canary home, under its own session and port.
LIVE_USERDATA="$USERDATA"
T3_HOME="${T3_CANARY_HOME:-$HOME/.t3-canary}"
USERDATA="$T3_HOME/userdata"
SESSION="${T3_CANARY_SESSION:-t3code-canary}"
SERVE_ARGS="${T3_CANARY_SERVE_ARGS:-serve --port 8450}"
HEALTH_URL="${T3_CANARY_HEALTH_URL:-}"

require_single_pane
stop_server
run "$NODE" "$BUILD/apps/server/scripts/migrate-dev-db.ts" \
  --base-dir "$T3_HOME" --source "$LIVE_USERDATA/statev2.sqlite" \
  --projects "$PROJECTS" --threads-per-project "$THREADS"
if [[ $SECRETS == 1 ]]; then
  run rm -rf "$USERDATA/secrets"
  run cp -a "$LIVE_USERDATA/secrets" "$USERDATA/secrets"
fi
start_server "$BUILD"
wait_healthy || die "canary not healthy; inspect tmux session '$SESSION'"
log "canary up in tmux session '$SESSION'"
