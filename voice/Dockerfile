# The voice host runs the same here as it does on a laptop, which is the whole
# point: what gets tested locally is what gets deployed.
FROM node:24-alpine

# No compiler, no python, no build-essential, and alpine's musl is not a risk,
# because every dependency here is pure JavaScript. Opus is `opusscript` and
# Discord's aes-256-gcm comes from Node's own crypto. That was a deliberate
# choice, and this three line image is what it bought.
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src

# Node 24 runs TypeScript directly, so there is no build step and no compiled
# output that can drift from the source.
USER node

# Outbound only. Discord voice dials out over UDP and OpenAI over TLS; nothing
# ever connects in, so the image exposes no port.
CMD ["node", "src/index.ts"]
