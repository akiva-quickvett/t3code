// @effect-diagnostics nodeBuiltinImport:off - a synchronous digest names the image at module load.
import * as NodeCrypto from "node:crypto";

import { DEFAULT_POD_RUNTIME_IMAGE } from "@t3tools/contracts";

/**
 * T3's default agent image, built on the Docker host the first time a pod
 * needs it rather than pulled: its `.invalid` name never resolves, so Docker
 * can never pull another image in its place. Everything is pinned, so its
 * tag, a digest of this file, names one image and a change here builds a new
 * one.
 *
 * glibc and curl for the provider CLIs and their installers, the docker CLI
 * with compose for the pod's stack, git and ssh for the worktree. The CLIs
 * are the image's own copies: on a Linux host an instance's absolute binary
 * path still runs the host's install, mounted read-only, but a bare name, and
 * every instance on a macOS host, runs these. Nothing secret is in it; logins
 * come from the config dirs the pod mounts.
 *
 * Size is the CLIs' native binaries, which npm installs for this architecture
 * only. Codex's realtime-voice runtime is dropped: the app-server T3 runs never
 * uses it. Buildx stays, because compose builds a stack's images with it and
 * its fallback, the legacy builder, rejects BuildKit-only Dockerfiles.
 */
export const POD_AGENT_IMAGE_DOCKERFILE = `\
FROM docker:27.5.1-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c AS docker
FROM node:22.23.3-bookworm-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9
RUN apt-get update \\
  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client procps \\
  && rm -rf /var/lib/apt/lists/*
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=docker /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
RUN npm install --global --omit=dev \\
    @anthropic-ai/claude-code@2.1.306 \\
    @openai/codex@0.163.0 \\
    @earendil-works/pi-coding-agent@1.3.0 \\
    @xai-official/grok@1.0.62 \\
  && find "$(npm root --global)/@openai/codex" -type d -path '*/codex-resources/voice' -prune -exec rm -rf {} + \\
  && npm cache clean --force
`;

const T3_POD_AGENT_IMAGE_TAG = `${DEFAULT_POD_RUNTIME_IMAGE}:${NodeCrypto.createHash("sha256")
  .update(POD_AGENT_IMAGE_DOCKERFILE)
  .digest("hex")
  .slice(0, 12)}`;

/** The image a pod's agent container runs; the default setting names T3's own build. */
export const podAgentImageTag = (image: string) =>
  image === DEFAULT_POD_RUNTIME_IMAGE ? T3_POD_AGENT_IMAGE_TAG : image;

export const isT3PodAgentImage = (tag: string) => tag === T3_POD_AGENT_IMAGE_TAG;
