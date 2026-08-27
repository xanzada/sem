FROM mcr.microsoft.com/playwright:v1.62.1-noble

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify \
      fonts-inter fonts-noto-color-emoji fonts-noto-core fonts-dejavu-core \
      libnss3-tools \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
# Пакеты ставим без install-скриптов: better-sqlite3 13 приносит готовые
# N-API prebuilds, а браузеры уже лежат в /ms-playwright базового образа,
# поэтому компилятор (make/g++) в образе не нужен.
RUN npm ci --include=dev --ignore-scripts || npm install --include=dev --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts

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
