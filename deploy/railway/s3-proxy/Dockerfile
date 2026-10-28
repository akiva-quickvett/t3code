# Read-only S3 proxy. Build context is this directory. Setup: README.md.
FROM node:24.21.0-alpine
WORKDIR /app
COPY package.json server.mjs sigv4.mjs ./
USER node
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
