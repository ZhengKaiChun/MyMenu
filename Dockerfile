FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && groupadd --gid 10001 menu && useradd --uid 10001 --gid menu --no-create-home menu
COPY server ./server
RUN mkdir -p /app/.runtime/media && chown -R menu:menu /app/.runtime
USER menu
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 MEDIA_DIR=/app/.runtime/media
EXPOSE 3000
CMD ["node","server/src/main.mjs"]
