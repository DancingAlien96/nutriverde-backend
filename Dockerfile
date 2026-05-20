# syntax=docker/dockerfile:1.6

# ---------- Stage 1: build ----------
FROM node:20-alpine AS build

WORKDIR /app

# Solo deps primero para aprovechar la cache cuando solo cambia el código
COPY package.json package-lock.json* ./
COPY prisma ./prisma

# OpenSSL es necesario para Prisma
RUN apk add --no-cache openssl
RUN npm ci

# Genera el cliente Prisma para Linux (ARM64 o x86_64 según el host)
RUN npx prisma generate

# Copia el resto y compila TS → JS
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- Stage 2: runtime ----------
FROM node:20-alpine AS runtime

WORKDIR /app

# OpenSSL para Prisma + tini para señales correctas
RUN apk add --no-cache openssl tini

ENV NODE_ENV=production
ENV PORT=4001

# Copiamos node_modules del stage de build (incluye prisma CLI y tsx, que
# necesitamos en runtime para `prisma migrate deploy` y `prisma db seed`).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY prisma ./prisma

# Carpeta de uploads (debería montarse como volumen)
RUN mkdir -p uploads && chown -R node:node uploads

USER node

EXPOSE 4001

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
