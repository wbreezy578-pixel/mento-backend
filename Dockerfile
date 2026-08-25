FROM node:22-bookworm-slim AS build

WORKDIR /workspace/mento

RUN apt-get update \
	&& apt-get install -y --no-install-recommends openssl \
	&& rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npx prisma generate
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build \
	DIRECT_URL=postgresql://build:build@localhost:5432/build \
	JWT_SECRET=build-only-placeholder \
	GEMINI_API_KEY=build-only-placeholder \
	SUPABASE_URL=https://build-only.invalid \
	SUPABASE_SERVICE_ROLE_KEY=build-only-placeholder \
	SUPABASE_ANON_KEY=build-only-placeholder \
	PAYMENT_WEBHOOK_AUTH_SECRET=build-only-placeholder \
	SIMLI_API_KEY=build-only-placeholder \
	SIMLI_AVATAR_ID=build-only-placeholder \
	npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends openssl \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=build /workspace/mento/package.json ./package.json
COPY --from=build /workspace/mento/package-lock.json ./package-lock.json
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /workspace/mento/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /workspace/mento/node_modules/@prisma/client ./node_modules/@prisma/client

RUN chown -R node:node ./node_modules/.prisma ./node_modules/@prisma
COPY --from=build /workspace/mento/.next ./.next
COPY --from=build /workspace/mento/public ./public
COPY --from=build /workspace/mento/prisma ./prisma
COPY --from=build /workspace/mento/app ./app
COPY --from=build /workspace/mento/lib ./lib
COPY --from=build /workspace/mento/services ./services
COPY --from=build /workspace/mento/server.ts ./server.ts
COPY --from=build /workspace/mento/instrumentation.ts ./instrumentation.ts
COPY --from=build /workspace/mento/instrumentation.node.ts ./instrumentation.node.ts
COPY --from=build /workspace/mento/proxy.ts ./proxy.ts
COPY --from=build /workspace/mento/next.config.ts ./next.config.ts
COPY --from=build /workspace/mento/tsconfig.json ./tsconfig.json

EXPOSE 3000

USER node

CMD ["npm", "start"]
