# Minimal Node.js Alpine base image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy application files
COPY package.json ./
COPY app.js ./
COPY delta_bridge.js ./
COPY strategy_scanner.js ./
COPY signal_filter.js ./
COPY modules/ ./modules/

# Set production environment
ENV NODE_ENV=production
ENV PORT=5050

# Expose server port
EXPOSE 5050

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:5050/health || exit 1

# Start 24/7 trading bot
CMD ["node", "app.js"]
