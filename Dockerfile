FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

RUN apk add --no-cache sqlite

COPY . .

RUN mkdir -p uploads

EXPOSE 3000

CMD ["node", "src/server.js"]
