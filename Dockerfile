FROM node:22-alpine

WORKDIR /app

# Install deps first (better layer caching). --omit=dev keeps the image lean.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Drop root: run as the built-in unprivileged `node` user. Own the app dir so
# the runtime .env param backup (saveParamsToEnv) can still be written.
RUN chown -R node:node /app
USER node

CMD ["node", "bot.js"]
