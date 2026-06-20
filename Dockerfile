FROM node:20-slim

# Playwright용 Chromium 시스템 의존성
RUN apt-get update && apt-get install -y \
  chromium \
  fonts-noto-cjk \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY . .
RUN mkdir -p data uploads

EXPOSE 3000
CMD ["node", "server.js"]
