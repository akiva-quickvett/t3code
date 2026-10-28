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

mkdir -p "$home/.t3" "$home/.claude" "$home/.config" "$home/.local/bin" "$home/.ssh" "$home/work"
chmod 700 "$home/.ssh"

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

cd "$home/work"
exec setpriv --reuid="$user" --regid="$user" --init-groups \
  env HOME="$home" USER="$user" LOGNAME="$user" SHELL=/bin/bash \
  node /opt/t3code/apps/server/dist/bin.mjs serve \
  --host 0.0.0.0 --port "${PORT:-8080}" "$home/work" \
  > >(redact) 2>&1
