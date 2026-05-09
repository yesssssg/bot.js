FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install --only=production

COPY . .

CMD ["node", "bot.js"]
