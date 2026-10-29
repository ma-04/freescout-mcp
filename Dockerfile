# syntax=docker/dockerfile:1
# freescout-mcp, Streamable HTTP mode. Build on the target host (linux/arm64 or amd64):
#   docker build -t freescout-mcp .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Inside the container the server listens on all interfaces; restricting who can reach it is the
# job of the published port (docker-compose binds it to the Tailscale IP only), plus MCP_TOKEN.
ENV MCP_HOST=0.0.0.0 \
    MCP_PORT=8787 \
    MCP_ALLOW_PUBLIC_BIND=1
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "dist/http.js"]
