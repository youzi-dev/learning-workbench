# Worker uses no database and no persistent host mounts. Runtime network policy
# is installed by the separate namespace guard, never by this nonroot process.
FROM node@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-pip ffmpeg iptables util-linux ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/downloader \
 && /opt/downloader/bin/pip install --no-cache-dir 'yt-dlp==2026.10.21' \
 && groupadd --gid 10001 workbench \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin workbench
ENV PATH="/opt/downloader/bin:$PATH" HOME=/work
COPY deploy/capture-dist/ /opt/workbench/
COPY deploy/egress-guard.sh /opt/workbench/egress-guard.sh
COPY licenses/ /opt/workbench/licenses/
USER 10001:10001
WORKDIR /work
ENTRYPOINT ["node","/opt/workbench/worker.mjs"]
