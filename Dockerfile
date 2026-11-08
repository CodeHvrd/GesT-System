FROM node:22-slim

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY tsconfig.json next.config.ts tailwind.config.ts postcss.config.mjs components.json ./
COPY src ./src

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

RUN mkdir -p /app/data && npm run build

EXPOSE 8080
CMD ["sh", "-c", "npx next start -H 0.0.0.0 -p ${PORT:-8080}"]
