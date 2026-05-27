FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY web/dist ./web/dist
COPY data ./data

ENV NODE_ENV=production
EXPOSE 8789
CMD ["node", "src/server.js"]
