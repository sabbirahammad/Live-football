FROM node:22-bookworm-slim

WORKDIR /app

# Install Python runtime and pip for the IPTV scraper.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip python3-venv ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install Node dependencies first for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app source, including the embedded IPTV scraper.
COPY . .

# Install Python scraper dependencies from the embedded package.
RUN python3 -m pip install --break-system-packages -e tools/iptv-scraper

ENV NODE_ENV=production
ENV IPTV_SCRAPER_PYTHON=python3

EXPOSE 5000

CMD ["npm", "start"]
