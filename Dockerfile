FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

COPY package*.json ./

# Use npm install instead of npm ci (more forgiving)
RUN npm install --only=production

COPY . .

CMD ["node", "bot.js"]
