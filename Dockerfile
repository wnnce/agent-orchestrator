ARG AGENT_RUNTIME_BASE=agent-orchestrator-runtime-base:local

FROM ${AGENT_RUNTIME_BASE} AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
RUN bun install --frozen-lockfile
COPY src ./src
RUN bun build src/main.ts --target bun --outdir dist --external pg

FROM ${AGENT_RUNTIME_BASE}
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./package.json
COPY database ./database
COPY scripts/init-database.ts ./scripts/init-database.ts
COPY projects ./projects
COPY config.example.yaml ./config.example.yaml
RUN mkdir -p /app/.data
RUN chown -R agent:agent /app
USER agent
ENV PATH="/app/node_modules/.bin:${PATH}"
VOLUME ["/workspace"]
EXPOSE 7070
CMD ["bun", "run", "dist/main.js"]
