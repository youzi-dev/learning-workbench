# Linux 服务器部署

这套配置在独立 Linux Docker 主机运行 API、私有采集 broker、Caddy、每日快照 scheduler，以及可选的加密复制 replicator。只由 Caddy 发布 80/443。代码与可执行部署工具已准备；实际云主机、公共域名、S3 目标及凭证尚未配置，不能称为已上线。

## 部署包与固定镜像

使用 `release/learning-workbench-server-0.11.1.tar.gz`。包内 `SHA256SUMS` 是各文件的确定性 SHA-256；在展开目录运行 `sha256sum -c SHA256SUMS`。服务器包只含预编译 server/capture bundle、指定配置、运维脚本、公开许可证与文档，不含客户端安装包、密钥、`.env`、数据、SDK、源工作区或依赖目录。

从源工作区准备时先执行 `pnpm build:server`、`pnpm build:capture`，再执行 `pnpm package:server`。打包器不自动构建、不联网、不安装依赖、不读取私有文件或上传注册表；必需 bundle 缺失即失败。部署包已含 bundle，无需在目标主机安装项目依赖。

主机须为专用 Linux Docker Engine / Compose v2，明确选定 `linux/arm64` 或 `linux/amd64`。Node 固定为已核实的 Node24.19.0 Debian index `sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df`。worker 同样使用此固定基础镜像，保留 Python、ffmpeg、iptables、util-linux、CA、UID10001 与 yt-dlp2026.10.21。构建会解析 apt/pip 的系统/传递依赖；固定基础输入不等于整个镜像可重复生成。操作员须在选定平台完成实际构建/正向采集验证，记录最终固定镜像 ID，并填入配置。不得将新源码基础镜像当作已运行的 worker，也不能悄悄切换现有服务。

从展开目录构建 worker，再检查平台与实际 ID（以下标签只是构建标签，不用于运行配置）：

```sh
docker build --platform linux/arm64 -f deploy/worker.Dockerfile -t workbench-worker:0.11.1 .
docker image inspect workbench-worker:0.11.1 --format '{{.Id}} {{.Os}}/{{.Architecture}}'
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
```

填写下列非秘密配置。真实域名需指向此主机，80/443 可达；管理员账户和设备配对是独立操作。

| 变量 | 值 |
| --- | --- |
| `WORKBENCH_DOMAIN` | 真实公共 DNS 域名，不含协议或路径 |
| `WORKBENCH_PLATFORM` | 明确的 Linux 平台 |
| `WORKBENCH_WORKER_IMAGE` | 已加载到此 daemon、匹配平台的 `sha256:<64hex>` 或 `仓库@sha256:<64hex>` |
| `WORKBENCH_DEPLOYMENT_ID` | 同 daemon 唯一，重启保持不变，1–48 位小写字母/数字/连字符 |
| `DOCKER_SOCKET_GID` | 目标主机 `stat -c '%g' /var/run/docker.sock` 的实际数字 |
| `WORKBENCH_ALLOWED_ORIGINS` | Android `https://localhost`，可再加一个明确 HTTPS 浏览器 origin |
| `WORKBENCH_COMPOSE_PROJECT` / `WORKBENCH_IMAGE_TAG` | 部署自己的项目名和镜像标签 |

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.yaml build
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
```

Docker 上下文默认拒绝所有内容，仅显式放行预编译 bundle、镜像输入与现有公开 notices。API 和 worker 保留所打包 npm 依赖的完整许可证；可选 replicator 另含 restic0.19.1 BSD2 全文。Node/Caddy/Docker CLI/restic 来源固定到官方镜像摘要。replicator 从同一固定 restic 镜像复制二进制及系统 CA bundle，使用正常 TLS 验证。

## 权限、持久化与健康

初始化容器无网络和 Docker socket，只接管空的明确命名卷，记录用途/UID/权限；已有卷必须匹配，不递归修改未知目录。数据、密钥、控制 socket、快照、恢复演练和 TLS 文件分卷。空密钥卷首次生成随机 32 字节 capture.key，目录0700/文件0600，之后不换钥；丢失、损坏或权限异常即拒绝启动。服务检查实际 Linux mountinfo，拒绝缺少精确持久挂载、overlay/tmpfs/网络文件系统、不符的读写模式及不安全 SQLite 版本。

API UID11000 是唯一业务写入者；scheduler 以同 UID 只读挂载活动数据，仅写独立快照卷，无密钥、无网络。broker UID12000/控制组12001，无容器网络，仅挂载控制目录及 Docker socket；它是受信任的主机控制器，Docker socket 允许控制主机。API 仅只读挂载控制目录并连接 socket，不持有 Docker socket。worker 无持久挂载，保留既有出站限制和资源上限。所有常驻服务只读根目录、删除 capabilities、no-new-privileges；Caddy 仅保留监听低端口所需能力。

Caddy 自动申请并持久保存公共 TLS，只转发 `/v1/*` 与 `/healthz`，其余404，访问日志关闭。`/healthz` 实际查询数据库并限时连接私有 broker，仅公开 ready/unavailable；业务路由继续认证。Docker unhealthy 本身不会触发容器重启，退出由 unless-stopped 恢复。

管理员显式创建账户和配对，输出的配对码仅在私有终端使用：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml exec api node /opt/workbench/cli.mjs provision --db /data/db.sqlite
docker compose --env-file deploy/.env -f deploy/compose.yaml exec api node /opt/workbench/cli.mjs pair --db /data/db.sqlite
docker compose --env-file deploy/.env -f deploy/compose.yaml exec api node /opt/workbench/cli.mjs revoke --db /data/db.sqlite --device EXACT_DEVICE_ID
```

## 快照、恢复与可选离机副本

每日北京时间03:00执行快照，首次/错过后补最近到期时段。独立 SQLite 运维锁不占用业务写锁；同根目录的备份、恢复、清理、复制互斥，忙时报 BACKUP_BUSY，崩溃后 OS 自动解锁。scheduler 不重入，每日最多三次，失败等待60秒/300秒；私有状态只在完成后记录成功，失败或超过26小时未成功会不健康。快照保留最近7个UTC日与4个UTC周的最新版本并取并集。

```sh
./deploy/backup.sh
./deploy/restore.sh snapshot-EXACT_SNAPSHOT_ID new-isolated-drill
```

恢复只写 recovery 卷内原先不存在的新目录，不挂载源数据或密钥，不切换服务。完整格式、校验和隔离演练见 [在线备份与隔离恢复](backup-restore.md)。可选 S3 加密复制、明确 init/once/serve 操作、过滤保留、隔离恢复及两种密钥的离线保管见 [离机加密复制](offhost-backup.md)。未配置 offhost 时基础服务照常工作；启动 optional 容器不等于已有独立副本。

正常停止/重建保留命名卷：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml stop
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d
```

生产不要使用 `down -v` 或删除卷。

## 只读公网检查

将一个已配对设备的 `token`（可连同 accountId/deviceId）保存到操作员独占、无符号链接、0600的 JSON 文件。不在命令参数或环境中传 token；不自动配对、不消费配对码。

```sh
node scripts/verify-cloud.mjs --base https://实际公共域名 --credential /exact/private/device.json
# 可选：同账户下已经存在的文件描述符 {sha256,size,mime}，仅作为下载校验依据。
node scripts/verify-cloud.mjs --base https://实际公共域名 --credential /exact/private/device.json --blob-evidence /exact/private/known-blob.json
```

源码工作区也可用 `pnpm verify:cloud -- ...`。必须显式提供 HTTPS origin 和私有凭证文件，无默认端点、无 TLS 绕过；拒绝本地/私有地址、userinfo、查询、片段和基础路径。DNS 仅启动时检查一次，不能当作 DNS 安全强制机制。所有请求为限时、限体积 GET，拒绝重定向，避免认证转发；输出仅含检查状态，不输出文档内容、原始服务器错误或凭证。

检查 ready200、认证 pull 结构、无认证 pull401、无认证已知格式文件路径401、私有 broker `/ready`404。提供已知文件描述符时流式核对认证下载哈希/大小及无认证拒绝；未提供明确显示 not-checked。必需输入、HTTP或结构失败退出非零/incomplete。这个结果只证明端点 smoke，不能证明电脑关机后可用、重启持久化、设备安装或云备份恢复。

单文件仍上限1GiB、两个并发采集任务。API/broker各2.25GiB scratch，双任务连同 worker/guard/proxy/备份上限需要约10.75GiB再加系统开销；建议从16GiB独立主机评估。实际磁盘需包含活动数据、上传/提交中间副本、多份快照、失败残留和隔离恢复副本。小样本本地成功不能证明最大负载容量或公网状态。
