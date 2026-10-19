
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle

RUN npm run build


FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --include=dev \
    && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY example-client ./example-client
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /app/src/db ./src/db

# Seed currently runs through tsx, so retain tsx in production.
USER node

EXPOSE 3000

CMD ["sh", "-c", "npm run db:migrate && npm run db:seed && npm start"]