FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src

ENV NODE_ENV=production
CMD ["node", "--import", "tsx", "src/agent.ts", "start"]
