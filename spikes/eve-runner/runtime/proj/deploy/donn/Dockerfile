# Spike: a self-host image for an eve 0.83.2 agent (spec 25 §4). Build context: the agent dir.
FROM node:26-slim AS build
WORKDIR /agent
RUN npm install -g pnpm@12.14.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm 12 may exit non-zero on ERR_PNPM_IGNORED_BUILDS after a complete install.
RUN pnpm install --frozen-lockfile; test -d node_modules/eve
COPY . .
ARG EVE_BUILD_FLAGS=""
RUN pnpm exec eve build $EVE_BUILD_FLAGS

FROM node:26-slim
WORKDIR /agent
# The Docker sandbox shells out to a `docker` CLI; the daemon comes from a mounted socket.
COPY --from=docker:28.3-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build /agent/.output ./.output
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
EXPOSE 3000
# The local Workflow world keeps run state here; mount a volume to keep it.
VOLUME /agent/.eve
CMD ["node", ".output/server/index.mjs"]
