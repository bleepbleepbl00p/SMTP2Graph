FROM node:20-alpine

ARG VERSION
LABEL version="SMTP2Graph v${VERSION}"

# Install runtime dependencies for WebUI (express, ajv, helmet, express-rate-limit are externals)
COPY package.json package-lock.json /opt/smtp2graph/
RUN cd /opt/smtp2graph && npm ci --omit=dev && rm package.json package-lock.json
ENV NODE_PATH=/opt/smtp2graph/node_modules

# Add SMTP2Graph binary
COPY dist/server.js /usr/local/bin/smtp2graph.js
COPY docker/startup.sh /usr/local/bin/startup.sh
COPY docker/test.sh /usr/local/bin/test.sh
RUN chmod 755 /usr/local/bin/startup.sh /usr/local/bin/test.sh

# Add non-root user and set up data directory
RUN addgroup -S smtp2graph && adduser -S smtp2graph -G smtp2graph
RUN mkdir -p /data/logs /data/queue /data/failed && \
    chown -R smtp2graph:smtp2graph /data

WORKDIR /data
VOLUME /data
EXPOSE 587
EXPOSE 3000

# Health check — probe SMTP port
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD nc -z localhost 587 || exit 1

USER smtp2graph

ENTRYPOINT ["/bin/sh", "/usr/local/bin/startup.sh"]
