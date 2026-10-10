FROM node:20-bookworm-slim

# Build tools for webtorrent's optional native modules (uTP, WebRTC)
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

ENV PORT=8080 \
    DOWNLOAD_DIR=/downloads \
    TORRENT_PORT=6881 \
    DHT_PORT=6882 \
    NODE_ENV=production

EXPOSE 8080 6881/tcp 6881/udp 6882/udp
VOLUME ["/downloads"]

CMD ["node", "src/server.js"]
