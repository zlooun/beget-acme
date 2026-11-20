FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS runtime
WORKDIR /app
ENV NODE_ENV=production ACME_STATE_DIR=/state ACME_OUTPUT_DIR=/output
LABEL org.opencontainers.image.title="beget-acme" org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/zlooun/beget-acme"
# Runtime contains only production dependencies and compiled code.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY .env.example LICENSE ./
RUN mkdir -p /state /output
# Simple first startup; override with Compose user or docker run --user for non-root.
# Mounted directory ownership is managed by the operator, never changed at startup.
USER 0:0
HEALTHCHECK --interval=5m --timeout=15s --start-period=30s CMD node dist/cli.js status --check
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["run"]
