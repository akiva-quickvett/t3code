#!/bin/sh
# Hands the secrets to the front on stdin and execs tini without them, so no
# process keeps them in its environment: /proc/<pid>/environ outlives
# `delete process.env`, and Chrome runs unsandboxed as the same user.
exec env -u BROWSERS_TOKEN -u TS_AUTHKEY /usr/bin/tini -- node /app/entrypoint.mjs <<SECRETS
${BROWSERS_TOKEN:-}
${TS_AUTHKEY:-}
SECRETS
