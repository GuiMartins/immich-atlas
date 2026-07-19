FROM node:22-alpine

WORKDIR /app
COPY app/ ./

ENV NODE_ENV=production \
    DATA_DIR=/appdata \
    PORT=8080

EXPOSE 8080
VOLUME ["/appdata"]

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/api/status >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
