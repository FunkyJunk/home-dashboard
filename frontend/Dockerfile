FROM nginx:alpine

# Copy the whole static tree rather than naming each file. The previous
# per-file COPY list silently omitted anything new: login.html and passkey.js
# were added, committed, built and deployed green, and still 404'd in
# production because they were never in the image. A build that succeeds while
# shipping an incomplete site is the worst kind of failure, so the file list is
# no longer something that can drift out of sync with the directory.
#
# .dockerignore keeps scratch and test files out. nginx.conf is copied again
# below because it belongs in conf.d, not the web root.
COPY . /usr/share/nginx/html/
RUN rm -f /usr/share/nginx/html/Dockerfile \
          /usr/share/nginx/html/nginx.conf \
          /usr/share/nginx/html/.dockerignore

# Build provenance. The frontend has no process to hold env vars, so the values
# are baked into a static file that Settings > Build fetches. Frontend and
# backend are built by separate matrix jobs and can end up at different commits,
# which is exactly what this makes visible.
ARG BUILD_COMMIT=""
ARG BUILD_REF=""
ARG BUILD_TIME=""
ARG BUILD_RUN_NUMBER=""
ARG BUILD_RUN_URL=""
RUN printf '{"commit":"%s","ref":"%s","builtAt":"%s","ciRunNumber":"%s","ciRunUrl":"%s"}\n' \
      "$BUILD_COMMIT" "$BUILD_REF" "$BUILD_TIME" "$BUILD_RUN_NUMBER" "$BUILD_RUN_URL" \
      > /usr/share/nginx/html/build.json

COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
