# syntax=docker/dockerfile:1

FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
ARG APP_URL=http://localhost:3000
ENV NEXT_TELEMETRY_DISABLED=1 \
    APP_URL=${APP_URL}
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm run build:worker

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/dist-worker ./dist-worker

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
