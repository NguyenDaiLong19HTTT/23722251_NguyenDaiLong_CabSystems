FROM node:24.19.0-bookworm AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run db:generate && npm run probe:generate && npm run build

FROM node:24.19.0-bookworm
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
