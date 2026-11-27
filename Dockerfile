FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/

RUN npm --prefix backend install --omit=dev && npm --prefix frontend install

COPY . .
RUN npm --prefix frontend run build

EXPOSE 5000
CMD ["node", "backend/server.js"]
