FROM node:18-alpine

# System dependencies
RUN apk add --no-cache p7zip

# Build app
COPY ./ /app
RUN npm run build

# Runtime
ENV WIKICOMMA_CONFIG=config-scp.json
CMD ["npm", "start"]
