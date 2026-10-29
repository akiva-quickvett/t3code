# Headless Chromium pool for Railway. Build context is this directory.
# Keep the Playwright version in step with the repo's (playwright-core in
# apps/server): Playwright clients must match the server's version.
FROM mcr.microsoft.com/playwright:v1.60.0-noble

# certutil puts the pods proxy's root in Chrome's NSS database.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libnss3-tools tini \
    && rm -rf /var/lib/apt/lists/*

# Tailscale's static build (README: Tailnet). Railway runs amd64; bump the
# version and its checksum together, in step with deploy/railway/Dockerfile.
ARG TAILSCALE_VERSION=1.104.4
ARG TAILSCALE_SHA256=624ea093d47d62cf56f17b8332d74b8decda4a1faa610ebc60a1de334b2b3dc9
RUN curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_amd64.tgz" \
       -o /tmp/tailscale.tgz \
    && echo "${TAILSCALE_SHA256}  /tmp/tailscale.tgz" | sha256sum -c - \
    && tar -xzf /tmp/tailscale.tgz -C /usr/local/bin --strip-components=1 \
       "tailscale_${TAILSCALE_VERSION}_amd64/tailscale" "tailscale_${TAILSCALE_VERSION}_amd64/tailscaled" \
    && rm /tmp/tailscale.tgz \
    && tailscale version

WORKDIR /app
# The image ships the browsers but not the package.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --no-fund --no-audit playwright@1.60.0 && npm cache clean --force
COPY start.sh entrypoint.mjs front.mjs pods-proxy.mjs tailnet.mjs ./

USER pwuser
ENV PORT=3000 \
    CDP_PORT=9222
EXPOSE 3000 9222
ENTRYPOINT ["/app/start.sh"]
