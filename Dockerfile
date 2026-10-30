FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS runtime
WORKDIR /app
ENV NODE_ENV=production ACME_STATE_DIR=/state ACME_OUTPUT_DIR=/output
LABEL org.opencontainers.image.title="beget-acme" org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/zlooun/beget-acme"
# Runtime contains only production dependencies and compiled code.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY .env.example LICENSE ./
RUN mkdir -p /state /output && chown -R 10001:10001 /state /output
# Safe default; Compose user or docker run --user can override the UID/GID.
USER 10001:10001
HEALTHCHECK --interval=5m --timeout=15s --start-period=30s CMD node dist/cli.js status --check
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["run"]
