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
EXPOSE 3000
CMD ["node", "src/index.js"]
