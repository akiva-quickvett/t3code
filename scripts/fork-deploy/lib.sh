# shellcheck shell=bash
# Shared by canary.sh, swap.sh, rollback.sh and install-skills.sh. Every path,
# name and timing is an env override so tests run against a scratch HOME.

FORK_DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

T3_HOME="${T3_DEPLOY_HOME:-$HOME/.t3}"
USERDATA="$T3_HOME/userdata"
BUILDS="${T3_DEPLOY_BUILDS:-$HOME/t3-builds}"
CHECKOUT="${T3_DEPLOY_CHECKOUT:-$HOME/projects/t3code}"
SESSION="${T3_DEPLOY_SESSION:-t3code}"
SERVE_ARGS="${T3_DEPLOY_SERVE_ARGS:-serve --tailscale-serve --tailscale-serve-port 8443}"
HEALTH_URL="${T3_DEPLOY_HEALTH_URL:-}"
HEALTH_TIMEOUT="${T3_DEPLOY_HEALTH_TIMEOUT:-60}"
STOP_TIMEOUT="${T3_DEPLOY_STOP_TIMEOUT:-60}"
IDLE_WAIT_MINUTES="${T3_DEPLOY_IDLE_WAIT_MINUTES:-30}"
IDLE_INTERVAL="${T3_DEPLOY_IDLE_INTERVAL:-30}"
POLL="${T3_DEPLOY_POLL:-2}"
LOG_DIR="${T3_DEPLOY_LOG_DIR:-$T3_HOME/deploy}"
NODE="${T3_DEPLOY_NODE:-node}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DRY_RUN=0
FOREGROUND=0
STOPPED=0

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() {
  log "ERROR: $*"
  exit 1
}

# Mutating steps go through run so --dry-run prints them instead.
run() {
  log "+ $*"
  [[ $DRY_RUN == 1 ]] || "$@"
}

helper() { "$NODE" "$FORK_DEPLOY_DIR/helper.ts" "$@"; }

# Swap and rollback stop the server whose tmux session may be running this
# shell, so they re-exec themselves in a new session (setsid) and log to a file.
# macOS has no setsid; nohup alone is enough there for tests. The child drops
# TMUX: once detached it is no longer inside the session it stops.
detach_unless_foreground() {
  local name="$1"
  shift
  [[ $FOREGROUND == 1 || $DRY_RUN == 1 ]] && return 0
  mkdir -p "$LOG_DIR"
  local logfile="$LOG_DIR/$TS$name.log"
  if command -v setsid >/dev/null; then
    setsid nohup env -u TMUX "$0" --foreground "$@" >"$logfile" 2>&1 </dev/null &
  else
    nohup env -u TMUX "$0" --foreground "$@" >"$logfile" 2>&1 </dev/null &
  fi
  echo "Running detached (pid $!). Log: $logfile"
  exit 0
}

refuse_inside_session() {
  if [[ -n ${TMUX:-} && "$(tmux display-message -p '#S' 2>/dev/null)" == "$SESSION" ]]; then
    die "running inside tmux session '$SESSION', which this script stops; drop --foreground"
  fi
}

# Stop and start type into the session's active pane, so it must be the only one.
require_single_pane() {
  session_exists || return 0
  local panes
  panes="$(tmux list-panes -s -t "=$SESSION" | wc -l | tr -d ' ')"
  [[ $panes == 1 ]] || die "tmux session '$SESSION' has $panes panes; close all but the server's"
}

active_runs() { helper active-runs "$USERDATA/statev2.sqlite"; }

# Waits for zero active runs; returns 1 if the window closes first.
wait_until_idle() {
  local deadline=$((SECONDS + IDLE_WAIT_MINUTES * 60)) n
  while true; do
    n="$(active_runs)" || die "idle check failed on $USERDATA/statev2.sqlite"
    if [[ $n == 0 ]]; then
      log "idle: no active runs"
      return 0
    fi
    log "busy: $n active run(s)"
    if [[ $DRY_RUN == 1 ]]; then
      log "dry run: a real run would wait up to ${IDLE_WAIT_MINUTES}m"
      return 0
    fi
    ((SECONDS + IDLE_INTERVAL <= deadline)) || return 1
    sleep "$IDLE_INTERVAL"
  done
}

check_free_space() {
  local used free
  used="$(du -sk "$USERDATA" | cut -f1)"
  free="$(df -Pk "$T3_HOME" | awk 'NR == 2 { print $4 }')"
  log "userdata ${used} KiB, free ${free} KiB"
  ((free >= 2 * used)) || die "less than 2x userdata free on $T3_HOME; refusing before any stop"
}

session_exists() { tmux has-session -t "=$SESSION" 2>/dev/null; }

# The server writes its origin to server-runtime.json once listening and clears
# it on graceful shutdown.
runtime_origin() {
  [[ -n $HEALTH_URL ]] && {
    echo "$HEALTH_URL"
    return
  }
  sed -n 's/.*"origin":"\([^"]*\)".*/\1/p' "$USERDATA/server-runtime.json" 2>/dev/null
}

responds() { [[ -n $1 ]] && curl -fsS -o /dev/null --max-time 5 "$1/"; }

# C-c through the session (a graceful SIGINT, so the server releases its lock
# and tears down Tailscale Serve), then wait for the owner lock and the port.
# Never signals a PID; never matches processes by name.
stop_server() {
  local origin deadline
  origin="$(runtime_origin || true)"
  if session_exists; then
    run tmux send-keys -t "=$SESSION:" C-c
  else
    log "no tmux session '$SESSION'"
  fi
  [[ $DRY_RUN == 1 ]] && return 0
  deadline=$((SECONDS + STOP_TIMEOUT))
  until helper lock-free "$USERDATA"; do
    ((SECONDS < deadline)) || die "server still holds $USERDATA/server-owner.sqlite after ${STOP_TIMEOUT}s"
    sleep "$POLL"
  done
  while responds "$origin" 2>/dev/null; do
    ((SECONDS < deadline)) || die "$origin still answers after ${STOP_TIMEOUT}s"
    sleep "$POLL"
  done
  if session_exists; then run tmux kill-session -t "=$SESSION"; fi
  STOPPED=1
  log "stopped"
}

# A login shell in a fresh session, then the serve command typed into it:
# the same shape as the hand-run server, so it gets the user's PATH (node) and
# the pane survives a crash with the output on screen.
start_server() {
  local build="$1" args cmd
  read -ra args <<<"$SERVE_ARGS"
  cmd="$(printf '%q ' "$NODE" "$build/apps/server/dist/bin.mjs" "${args[@]}" --base-dir "$T3_HOME")"
  run tmux new-session -d -s "$SESSION" -c "$build"
  run tmux send-keys -t "=$SESSION:" "$cmd" Enter
}

wait_healthy() {
  [[ $DRY_RUN == 1 ]] && return 0
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) origin
  while ((SECONDS < deadline)); do
    origin="$(runtime_origin || true)"
    if responds "$origin" 2>/dev/null; then
      log "healthy: $origin"
      return 0
    fi
    sleep "$POLL"
  done
  log "not healthy within ${HEALTH_TIMEOUT}s"
  return 1
}

current_build() {
  if [[ -L $BUILDS/current ]]; then readlink "$BUILDS/current"; else echo "$CHECKOUT"; fi
}

require_build() {
  [[ -f $1/apps/server/dist/bin.mjs ]] || die "$1 has no apps/server/dist/bin.mjs"
  [[ -d $1/node_modules ]] || die "$1 has no node_modules (run vp i there)"
}

# ln -sfn replaces the symlink itself rather than writing inside its target.
# An empty previous removes the previous link (no swap has happened yet).
flip_to() {
  local target="$1" previous="$2"
  run mkdir -p "$BUILDS"
  if [[ -n $previous ]]; then
    run ln -sfn "$previous" "$BUILDS/previous"
  else
    run rm -f "$BUILDS/previous"
  fi
  run ln -sfn "$target" "$BUILDS/current"
}

previous_link() { readlink "$BUILDS/previous" 2>/dev/null || true; }

# stop -> optionally restore a backup -> flip back -> start -> health, leaving
# the previous link at $3. The failed state is moved aside, never deleted.
rollback_to() {
  local target="$1" backup="$2" previous="$3"
  log "rolling back to $target"
  stop_server
  if [[ -n $backup ]]; then
    log "restoring $backup"
    run mv "$USERDATA" "$USERDATA.failed-$TS"
    run mv "$backup" "$USERDATA"
  fi
  flip_to "$target" "$previous"
  start_server "$target"
  wait_healthy || die "rollback build $target is not healthy either; inspect tmux session '$SESSION'"
  log "rolled back to $target"
}
