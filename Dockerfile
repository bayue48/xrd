FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
RUN if [ -f pnpm-lock.yaml ]; then pnpm install --prod --frozen-lockfile; else pnpm install --prod; fi

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
EXPOSE 3000
CMD ["node", "src/server.js"]