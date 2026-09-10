FROM node:20-alpine

WORKDIR /app

# Install OpenSSL 3 for Prisma
RUN apk add --no-cache openssl

# Copy package files first for better Docker layer caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy Prisma schema
COPY prisma ./prisma/

# Generate Prisma Client with the correct Alpine/OpenSSL engine
RUN npx prisma generate

# Copy application source
COPY . .

# Build application
RUN npm run build

EXPOSE 3000

CMD ["node", "dist/bot/index.js"]
