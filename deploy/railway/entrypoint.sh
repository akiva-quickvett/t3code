#!/usr/bin/env bash
# Railway entrypoint: prepares the persisted home on the volume, then runs
# `t3 serve` as the unprivileged t3 user. Runs as root so it can fix the
# ownership of a volume that Railway mounts empty and root-owned.
set -euo pipefail

user=t3
home=/home/$user

mkdir -p "$home"

# Seed shell dotfiles once. Never overwrite: after the first boot the volume
# is the source of truth, including any edits made inside the instance.
for file in /opt/t3-home-skel/.[!.]*; do
  target="$home/$(basename "$file")"
  [ -e "$target" ] || cp -a "$file" "$target"
done

mkdir -p "$home/.t3" "$home/.claude" "$home/.config" "$home/.local/bin" "$home/.ssh" "$home/.tailscale" "$home/work"
chmod 700 "$home/.ssh" "$home/.tailscale"

# Fresh volumes and anything a root shell created belong to root. Only touch
# what is mis-owned so a large ~/work does not get rewritten on every boot,
# and skip node_modules trees, which only t3 writes, to keep boot fast.
find "$home" -xdev -name node_modules -prune -o \
  \( ! -user "$user" -o ! -group "$user" \) -exec chown -h "$user:$user" {} +

# `t3 serve` prints a one-time admin pairing token at every start: bare, in
# the pairing URL, URL-encoded in the app link, and as a QR code. Railway keeps
# stdout as deploy logs, so strip every form; fresh links come from `t3 pair`
# in an SSH session instead.
redact() {
  LC_ALL=C.UTF-8 sed -u -E \
    -e 's/(token(=|%3D))[^&[:space:]]+/\1[redacted]/gI' \
    -e 's/^([[:space:]]*Token:[[:space:]]*).+/\1[redacted]/' \
    -e '/^[[:space:]]*[█▀▄][█▀▄[:space:]]*$/d'
}

as_user() {
  setpriv --reuid="$user" --regid="$user" --init-groups \
    env -u TS_AUTHKEY -u HUB_ACCESS_TOKEN HOME="$home" USER="$user" LOGNAME="$user" \
    SHELL=/bin/bash "$@"
}

# Keeps a helper running; its exit never takes the server down.
keep() {
  local name=$1
  shift
  while :; do
    "$@" || true
    echo "$name exited, restarting in 10 s"
    sleep 10
  done
}

# Agents use the hub only when its key is set and the node is on the tailnet
# at boot; otherwise Claude Code keeps its own login. A bare
# ANTHROPIC_AUTH_TOKEN would point Claude Code's own login at the wrong key.
unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY

# Tailscale, so agents reach the CLIProxyAPI hub (README: Hub over Tailscale).
# Userspace networking because Railway has no TUN device; the state on the
# volume keeps the node's identity, so TS_AUTHKEY is only needed once.
ts_join() {
  local state="" keyfile
  for _ in $(seq 30); do
    state=$(timeout 5 tailscale status --json 2>/dev/null | jq -r '.BackendState // empty') || true
    case "$state" in "" | NoState | Starting) sleep 1 ;; *) break ;; esac
  done
  if [ "$state" = NeedsLogin ] && [ -n "${TS_AUTHKEY:-}" ]; then
    keyfile=$(mktemp)
    printf '%s' "$TS_AUTHKEY" > "$keyfile"
    tailscale up --auth-key="file:$keyfile" --hostname=qa-bot-t3 --accept-dns=false \
      --accept-routes=false --shields-up --timeout=60s >/dev/null 2>&1 \
      || echo "tailscale: up failed (expired or used auth key?)"
    rm -f "$keyfile"
  fi
  echo "tailscale: $(timeout 5 tailscale status --json 2>/dev/null \
    | jq -r '"\(.BackendState) \(.Self.DNSName // "")"' || echo unreachable)"
}

if [ -n "${TS_AUTHKEY:-}" ] || [ -s "$home/.tailscale/tailscaled.state" ]; then
  install -d -o "$user" -g "$user" -m 755 /run/tailscale
  # The Railway-to-hub path drops full 1280-byte tailnet packets: small
  # replies arrive, TLS handshakes stall. 1200 leaves room.
  keep tailscaled as_user TS_DEBUG_MTU=1200 tailscaled --tun=userspace-networking \
    --state="$home/.tailscale/tailscaled.state" \
    --socket=/run/tailscale/tailscaled.sock \
    --outbound-http-proxy-listen=127.0.0.1:1055 --socks5-server=127.0.0.1:1056 \
    > "$home/.tailscale/tailscaled.log" 2>&1 &
  keep hub-forward as_user node /usr/local/lib/hub-forward.mjs &
  # In the foreground (90 s at most) so the hub decision below sees the result.
  ts_join || true
else
  echo "tailscale: off (no TS_AUTHKEY and no saved state)"
fi

if [ -z "${HUB_ACCESS_TOKEN:-}" ]; then
  echo "hub: off (no HUB_ACCESS_TOKEN)"
# Running only: Starting also exits 0 but means the control plane is unreachable.
elif ! timeout 10 tailscale status --json 2>/dev/null | jq -e '.BackendState == "Running"' >/dev/null; then
  echo "hub: off (tailscale is not up)"
else
  export ANTHROPIC_AUTH_TOKEN=$HUB_ACCESS_TOKEN ANTHROPIC_BASE_URL=http://127.0.0.1:8317 \
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
  # Through the hub, Claude Code falls back to a 5 minute prompt cache; ask
  # for the subscription's 1 hour. Never overrides an explicit choice.
  settings=$home/.claude/settings.json
  {
    if [ ! -s "$settings" ]; then
      echo '{"promptCacheTtl": "1h"}' > "$settings"
    elif ! jq -e 'has("promptCacheTtl")' "$settings" >/dev/null 2>&1; then
      jq '.promptCacheTtl = "1h"' "$settings" > "$settings.tmp" && mv "$settings.tmp" "$settings" \
        || { rm -f "$settings.tmp"; false; }
    fi
    chown "$user:$user" "$settings"
  } || echo "hub: settings.json not updated"
  echo "hub: on (${HUB_URL:-https://omarchy.tail43a582.ts.net:8317})"
fi

cd "$home/work"
exec setpriv --reuid="$user" --regid="$user" --init-groups \
  env -u TS_AUTHKEY -u HUB_ACCESS_TOKEN HOME="$home" USER="$user" LOGNAME="$user" SHELL=/bin/bash \
  node /opt/t3code/apps/server/dist/bin.mjs serve \
  --host 0.0.0.0 --port "${PORT:-8080}" "$home/work" \
  > >(redact) 2>&1
