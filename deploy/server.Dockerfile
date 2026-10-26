# Server artifacts are built before Docker; no package manager, SDK, or source tree is copied.
FROM node@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS api
WORKDIR /opt/workbench
COPY dist-server/*.mjs ./
COPY dist-server/migrations ./migrations
COPY licenses/ /opt/workbench/licenses/
ENV NODE_ENV=production HOME=/tmp
USER 11000:11000
ENTRYPOINT ["node", "/opt/workbench/deploy.mjs"]
CMD ["api"]

FROM docker@sha256:be132a9f282288de4afaf63379dff75711fda0147c6b72a9df44e51841402144 AS docker-cli
FROM api AS broker
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
USER 12000:12001
CMD ["broker"]

FROM caddy@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
USER 13000:13000
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

# Official restic 0.19.1 multi-platform index. No restic or remote credentials enter API/scheduler.
FROM restic/restic@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510 AS restic-binary
FROM api AS replicator
COPY --from=restic-binary /usr/bin/restic /usr/bin/restic
COPY --from=restic-binary /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY deploy/licenses/ /opt/workbench/deploy-licenses/
USER 11000:11000
ENTRYPOINT ["node", "/opt/workbench/offhost.mjs"]
CMD ["serve"]
