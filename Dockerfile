# syntax=docker/dockerfile:1
# One Dockerfile, two targets: production (binary only) and staging (binary + claude + agent-browser).
FROM node:24.21.0-bookworm-slim AS web
# npm >= 11.13 is needed for min-release-age (Node 24's bundled npm already has it); the explicit pin below is an npm release older than 14 days and is asserted.
ARG NPM_VERSION=11.19.1
RUN npm install -g npm@${NPM_VERSION}
WORKDIR /src/web
COPY web/package*.json web/.npmrc ./
# @teb-ooo/* comes from the internal registry (web/.npmrc, no credentials; ADR 0012). The build is given an
# `npm-registry` host entry by factoryd (build.extra_hosts) because builds run on the default bridge network.
RUN npm ci
COPY web/ ./
RUN npm run build                      # -> /src/web/dist

FROM golang:1.27-bookworm AS build
ENV GOPRIVATE=github.com/teb-ooo/*
WORKDIR /src
COPY go.mod go.sum ./
# The netrc build secret lets `go mod download` fetch the private factory-go module.
RUN --mount=type=secret,id=netrc,target=/root/.netrc go mod download
COPY . .
COPY --from=web /src/web/dist ./web/dist
RUN CGO_ENABLED=0 go build -o /out/server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot AS production
COPY --from=build /out/server /server
EXPOSE 8080
ENTRYPOINT ["/server"]

FROM ubuntu:26.04 AS staging
ARG S6_OVERLAY_VERSION=3.2.3.2
ARG CLAUDE_CODE_VERSION
ARG BD_VERSION=1.2.2
ARG AGENT_BROWSER_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git tmux jq xz-utils build-essential postgresql-client && rm -rf /var/lib/apt/lists/*
# s6-overlay
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz /tmp
RUN tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz && tar -C / -Jxpf /tmp/s6-overlay-x86_64.tar.xz && rm -f /tmp/s6-overlay-*.tar.xz
# gitleaks: the pre-commit secret scan (BOOTSTRAP 4.6); pinned and checksum-verified
ARG GITLEAKS_VERSION=8.30.1
ARG GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
ADD https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz /tmp/gitleaks.tgz
RUN echo "${GITLEAKS_SHA256}  /tmp/gitleaks.tgz" | sha256sum -c - && tar -C /usr/local/bin -xzf /tmp/gitleaks.tgz gitleaks && rm /tmp/gitleaks.tgz
# go + node toolchains for in-place rebuilds
COPY --from=golang:1.27-bookworm /usr/local/go /usr/local/go
COPY --from=node:24.21.0-bookworm-slim /usr/local /usr/local/node
ARG NPM_VERSION=11.19.1
ENV PATH="/usr/local/go/bin:/usr/local/node/bin:/home/agent/.local/bin:/home/agent/go/bin:${PATH}"
# npm is a script with an `env node` shebang: node must be on PATH before it runs
RUN /usr/local/node/bin/npm install -g --prefix /usr/local/node npm@${NPM_VERSION} && /usr/local/node/bin/npm config ls -l | grep -q '^min-release-age'
# Both ubuntu:24.04 and 26.04 ship a stock `ubuntu` user at uid 1000: delete it first (ADR 0003).
RUN userdel -r ubuntu && useradd -m -u 1000 -s /bin/bash agent
# The private Go module (factory-go) comes from a module cache baked at image build: staging containers hold no
# GitHub credentials (ADR 0011). @teb-ooo/* npm packages are read from the internal registry at runtime, which
# needs no credentials (ADR 0012). `factory rebuild` refreshes the baked Go cache.
COPY --from=build --chown=1000:1000 /go/pkg/mod /home/agent/go/pkg/mod
COPY web/.npmrc /tmp/npmrc
RUN cp /tmp/npmrc /home/agent/.npmrc && chown 1000:1000 /home/agent/.npmrc && rm /tmp/npmrc
ENV GOPRIVATE=github.com/teb-ooo/* GOFLAGS=-mod=mod
USER agent
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- ${CLAUDE_CODE_VERSION} \
 && /usr/local/node/bin/npm install -g --prefix /home/agent/.local @beads/bd@${BD_VERSION} \
 && mkdir -p /home/agent/go/bin \
 && GOBIN=/home/agent/go/bin GOPATH=/tmp/gopath GOMODCACHE=/tmp/gomod GOCACHE=/tmp/gocache \
    sh -c 'go install github.com/sqlc-dev/sqlc/cmd/sqlc@latest && go install github.com/pressly/goose/v3/cmd/goose@latest' \
 && chmod -R u+w /tmp/gomod && rm -rf /tmp/gopath /tmp/gomod /tmp/gocache
# bd sends anonymous usage metrics to a third party by default: off for the agent user (ADR 0078)
RUN bd metrics off
# (tools are built with temporary GOPATH/module/build caches so the layer keeps only the binaries: ~2.3 GB smaller)
# agent-browser: the agent's interactive browser (BOOTSTRAP 9.12). Its Chrome also serves the Playwright smoke tests.
USER root
# `agent-browser install --with-deps` hard-codes `sudo apt-get`: install sudo for this one step and purge it after.
# The package declares node >=24, which the image now provides (ADR 0072, 0073).
# Root's npm uses the canonical .npmrc, so this global install also runs under the 14-day release-age gate.
COPY web/.npmrc /root/.npmrc
RUN apt-get update && apt-get install -y --no-install-recommends sudo \
 && /usr/local/node/bin/npm install -g agent-browser@${AGENT_BROWSER_VERSION} \
 && agent-browser install --with-deps \
 && rm -rf /root/.agent-browser \
 && SUDO_FORCE_REMOVE=yes apt-get purge -y sudo && rm -rf /var/lib/apt/lists/* \
 && agent-browser --version
# root's bd (the same binary is on PATH) must not send metrics either: shells opened with `docker exec` run as root
RUN bd metrics off
USER agent
RUN agent-browser install   # per-user browser cache for the agent user
COPY --chown=agent bin/factory-mcp /usr/local/bin/factory-mcp
USER root
COPY s6/ /etc/s6-overlay/s6-rc.d/
COPY bin/factory-app /usr/local/bin/factory-app
# claude-start, the hooks and hook-event are factory-owned and arrive read-only at /opt/factory-kit (composegen mounts
# FACTORY_ROOT/agent-kit), never from the app repository. This shim is all the image holds of them.
RUN printf '#!/bin/sh\nexec /opt/factory-kit/bin/claude-start "$@"\n' > /usr/local/bin/claude-start && chmod 755 /usr/local/bin/claude-start
# /app is bind-mounted over the image at runtime, so ship the first binary outside it (copied in by the app service).
COPY --from=build /out/server /opt/factory/server
ENV S6_KEEP_ENV=1 S6_BEHAVIOUR_IF_STAGE2_FAILS=2
WORKDIR /app
ENTRYPOINT ["/init"]
