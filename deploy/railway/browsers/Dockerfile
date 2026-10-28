# Headless Chromium pool for Railway. Build context is this directory.
# Keep the Playwright version in step with the repo's (playwright-core in
# apps/server): Playwright clients must match the server's version.
FROM mcr.microsoft.com/playwright:v1.60.0-noble

RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# The image ships the browsers but not the package.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --no-fund --no-audit playwright@1.60.0 && npm cache clean --force
COPY entrypoint.mjs ./

USER pwuser
ENV PORT=3000 \
    CDP_PORT=9222
EXPOSE 3000 9222
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/entrypoint.mjs"]
