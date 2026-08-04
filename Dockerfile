FROM node:22-alpine
WORKDIR /app
# Install deps first so image rebuilds after code-only edits stay cached
COPY app/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY app/ .
