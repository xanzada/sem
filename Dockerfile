FROM mcr.microsoft.com/playwright:v1.49.0-noble

RUN apt-get update && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --include=dev || npm install --include=dev

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production \
    NODE_PATH=/app/node_modules \
    DISPLAY=:99 \
    PORT=8080 \
    HEADLESS=false \
    NO_SANDBOX=true \
    TZ=Asia/Almaty

EXPOSE 8080 6080

COPY docker/start.sh /start.sh
RUN chmod +x /start.sh && mkdir -p /app/data/shots

CMD ["/start.sh"]
