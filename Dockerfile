# ═══════════════════════════════════════════════════════════════
# SMARTBOARD — PRODUCTION DOCKERFILE
# ═══════════════════════════════════════════════════════════════

FROM node:20-slim

# Install sqlite3 dependencies
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application code
COPY . .

# Create persistent storage volumes
RUN mkdir -p uploads
VOLUME ["/app/uploads", "/app/database.sqlite"]

EXPOSE 3000

# Start application
CMD ["npm", "start"]
