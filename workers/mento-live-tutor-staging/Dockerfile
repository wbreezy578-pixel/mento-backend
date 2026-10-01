FROM node:22-bookworm-slim

# The LiveKit worker establishes TLS connections to LiveKit Cloud. The slim
# base image does not include the system trust store by default.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src

ENV NODE_ENV=production
CMD ["node", "--import", "tsx", "src/agent.ts", "start"]
