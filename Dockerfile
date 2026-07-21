FROM caddy:2-alpine AS web

COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY index.html manifest.json sw.js icon-192.png icon-512.png apple-touch-icon.png /srv/
COPY css /srv/css
COPY js /srv/js
COPY assets /srv/assets

FROM node:24-alpine AS app

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY js/engine.js js/room.js js/ai.js ./js/
COPY data ./data

RUN mkdir -p /data/rooms && chown -R node:node /data
USER node

EXPOSE 3000
CMD ["node", "server/index.js"]
