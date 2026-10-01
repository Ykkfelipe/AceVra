# Provider-neutral container for the AceVra account API. TLS terminates at the platform
# edge; the process speaks plain HTTP (and can later also host long-lived WebSockets).
FROM node:24-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY migrations ./migrations
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
USER node
CMD ["node", "--import", "tsx", "src/server.ts"]
