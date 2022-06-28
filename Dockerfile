FROM node:18-alpine

# System dependencies
RUN apk add --no-cache p7zip

# Copy source
COPY ./ /app
WORKDIR /app
RUN mkdir /app/storage

# Build app
RUN npm install
RUN npm run build

# Runtime
ENV WIKICOMMA_CONFIG=config-scp.json
CMD ["npm", "start"]
