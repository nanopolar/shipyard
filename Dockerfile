FROM node:20-alpine

# Install Docker CLI and Compose plugin so we can run docker compose against the host daemon
RUN apk add --no-cache docker-cli docker-compose

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src/ ./src/

EXPOSE 3000

CMD ["node", "src/index.js"]
