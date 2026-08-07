FROM node:20-alpine AS build
WORKDIR /app
# better-sqlite3 is a native module with no musl prebuild - compile it here
# with build tools, then copy just the built node_modules into the slim
# runtime image below.
RUN apk add --no-cache python3 make g++
COPY package.json ./
RUN npm install --omit=dev

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Build provenance, surfaced at /api/build and on Settings > Build. Set by CI
# (.github/workflows/build-and-push.yml); empty when built by hand, which is
# itself worth being able to see. Declared after the COPYs so these values -
# which change on every commit - cannot invalidate the dependency layer above.
ARG BUILD_COMMIT=""
ARG BUILD_REF=""
ARG BUILD_TIME=""
ARG BUILD_RUN_NUMBER=""
ARG BUILD_RUN_URL=""
ARG BUILD_IMAGE=""
ENV BUILD_COMMIT=$BUILD_COMMIT \
    BUILD_REF=$BUILD_REF \
    BUILD_TIME=$BUILD_TIME \
    BUILD_RUN_NUMBER=$BUILD_RUN_NUMBER \
    BUILD_RUN_URL=$BUILD_RUN_URL \
    BUILD_IMAGE=$BUILD_IMAGE

EXPOSE 3000
CMD ["node", "src/index.js"]
