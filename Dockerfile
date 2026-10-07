FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8099 \
    DATA_DIR=/data \
    TZ=Europe/Berlin

RUN apk add --no-cache tzdata
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

CMD ["node", "src/server.js"]
