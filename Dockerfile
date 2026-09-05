FROM node:22-alpine

RUN apk add --no-cache unzip

WORKDIR /app
COPY package.json ./
COPY scripts/ ./scripts/

CMD ["node", "scripts/fetch-export-stats.mjs", "--state-dir", "/state", "--output", "/state/stats.json"]
