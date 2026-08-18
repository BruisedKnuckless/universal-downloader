FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

# Only used when TURSO_DATABASE_URL points at a local file:// database.
RUN mkdir -p uploads

EXPOSE 3000

CMD ["node", "src/server.js"]
