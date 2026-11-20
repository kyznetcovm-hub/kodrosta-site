FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY migrations ./migrations
COPY runtime-yandex ./runtime-yandex
COPY public ./public
USER node
ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
CMD ["node","runtime-yandex/server.mjs"]
