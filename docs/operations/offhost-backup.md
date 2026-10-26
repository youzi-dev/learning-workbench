# 可选的离机加密复制

此处交付操作工具。实际 S3 存储、凭证、离线密钥保管和公网服务仍未配置；本地加密仓库演练只能证明加密复制与隔离恢复流程。每日同盘快照与独立 S3 副本是两个状态。

## 独立准备私有目录

专用 Linux 主机需支持 Docker Compose v2。只为此用途创建一个原先不存在的目录；已有未知目录应先检查，不能递归改权限或所有者。以下命令遇到已有目录会停止：

```sh
sudo mkdir -m 0700 /srv/workbench-offhost
sudo chown 11000:11000 /srv/workbench-offhost
sudo install -o 11000 -g 11000 -m 0600 /dev/null /srv/workbench-offhost/repository
sudo install -o 11000 -g 11000 -m 0600 /dev/null /srv/workbench-offhost/password
sudo install -o 11000 -g 11000 -m 0600 /dev/null /srv/workbench-offhost/credentials.json
```

用安全编辑器直接填写这三个明确文件，不要把秘密放在命令参数、shell 历史、`.env`、日志或聊天里：

- `repository`：一行 `s3:https://实际公共S3端点/专用bucket/前缀`。必须 HTTPS，不含用户名、密码、查询或片段。拒绝本地路径、IP 端点和解析为私有地址的端点；一次 DNS 检查不等于 DNS 安全隔离。
- `password`：独立随机的 restic 加密口令，至少 20 字符且有足够不同字符。永久安全保管；丢失后不能解密仓库。不要使用示例值或已有账户口令。
- `credentials.json`：对象只包含 `accessKeyId`、`secretAccessKey`，可选 `region`、`sessionToken`。使用仅限此 bucket/前缀的专用访问权限；保留策略需要读、写及删除自身快照元数据的权限。

文件须是 UID11000 所有的普通文件，权限 `0600`（只读文件也可），目录 `0700`；不允许符号链接或组/其他用户访问。容器只读挂载到 `/operator`。在 `deploy/.env` 中增加 `WORKBENCH_OFFHOST_DIRECTORY=/srv/workbench-offhost`，这里只放路径。AWS 密钥仅由进程读取后传给 restic 子进程的最小环境；不继承 AWS profile、执行钩子、代理、TLS 跳过变量或其他宿主环境。

显式初始化选定的新仓库，然后执行首次复制：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml --profile offhost build replicator
docker compose --env-file deploy/.env -f deploy/compose.yaml --profile offhost run --rm --no-deps replicator init
docker compose --env-file deploy/.env -f deploy/compose.yaml --profile offhost run --rm --no-deps replicator once
docker compose --env-file deploy/.env -f deploy/compose.yaml --profile offhost up -d replicator
```

`init` 只由操作员显式运行；服务不会自动初始化仓库。先启动基础部署以初始化备份卷并产生完整快照。`replicator` 不挂载活动数据库、采集密钥、控制 socket 或 Docker socket；只挂载备份卷（RW 用于既有锁和私有状态）及只读凭证，有出站网络、64 MiB 临时空间、UID11000、只读根目录、无 capabilities。API 和 scheduler 继续无远端凭证；scheduler 无网络。

每次选择最新完整且属于此工具的快照，新增时才做全量哈希/数据库验证；持有同一个 SQLite 运维锁直到异步复制和保留完成。这个锁不阻塞业务 API 写入，但备份/恢复/清理可能暂时报 `BACKUP_BUSY`。传输仅包含相对 `snapshot-*` 目录，不包含父目录、锁、状态或密钥。restic 的稳定 host 为部署 ID，固定 tag 为 `personal-workbench`。保留仅筛选同 host/tag，以 `host,tags` 分组，保留 7 日 + 4 周；不会因每次目录名变化产生无限独立分组。

默认执行 `forget` 而不执行 `prune`。这会删除符合筛选条件的旧快照引用，不保证立即回收仓库字节。磁盘回收是单独的操作员步骤：先确认仓库完全专用、检查所有 host/tag 的快照与恢复需要，再使用同版本 restic 执行 `prune`；它是仓库级操作，不应在共享仓库上自动执行。

只有 backup 和 retention 都成功才记录成功 ID/时间。私有 `.replication-status.json` 只包含状态与通用错误码；原始 restic 输出丢弃。每次尝试至少间隔五分钟，单进程不重入；总传输超时两小时，SIGTERM 会终止子进程并释放运维锁。没有配置、无完整快照、失败或成功超过 26 小时均使 health 失败。仅启动容器不代表已有独立副本。每次后台 tick 和 health 都重新读取当前配置；私有成功记录包含仓库、部署 ID、加密口令及凭证的 SHA-256 身份摘要，不保存原值。配置身份变化或旧记录未绑定身份时，必须重新复制后才健康。显式 `once` 有界执行一次当前最新快照检查/复制，可跳过后台的五分钟冷却；后台仍保持重试间隔，未实际检查的延后调用不报告完成。

## 从加密仓库恢复到独立新目录

先由操作员为 UID11000 建立专用 `0700` 父目录 `/srv/workbench-recovery`（只创建原先不存在的目录），再以 UID11000 执行恢复。恢复需要同样的固定 Node24.19.0 / SQLite3.53.3 运行时及 restic0.19.1；以 `verify` 实际检查快照记录，不能改 manifest 来绕过 SQLite 版本要求。把仓库和加密口令文件安全放在恢复机的专用私有目录，UID11000 可读。为 restic 子进程设置最小环境与上文的固定文件路径，AWS 值从 JSON 在进程内读取；不要在交互 shell 中导出秘密。

操作员可在隔离恢复机运行以下 Node 模块（使用服务端源码同环境，或自行审阅的等价恢复脚本）；把 `EXACT_RESTIC_SNAPSHOT_ID` 和 `EXACT_SNAPSHOT_DIRECTORY` 替换为 `restic snapshots --host 部署ID --tag personal-workbench` 查到的确切值。`snapshots` 的原始输出只在操作员私有终端查看，不能进入服务日志。

```js
// 保存为专用私有恢复目录下的 recover.mjs；以下 bundle 来自同一服务器 kit。
import {spawnSync} from 'node:child_process';
import {readFileSync, existsSync, mkdirSync, chmodSync, lstatSync} from 'node:fs';
const privateRoot = '/srv/workbench-offhost';
const credentials = JSON.parse(readFileSync(`${privateRoot}/credentials.json`, 'utf8'));
const destination = '/srv/workbench-recovery/new-drill';
if (existsSync(destination)) throw Error('DESTINATION_EXISTS');
mkdirSync(destination, {mode: 0o700});
if (lstatSync(destination).uid !== process.getuid()) throw Error('PRIVATE_OWNER_REQUIRED');
const env = {PATH:'/usr/bin:/bin', HOME:'/tmp', TMPDIR:'/tmp',
 RESTIC_REPOSITORY_FILE:`${privateRoot}/repository`, RESTIC_PASSWORD_FILE:`${privateRoot}/password`,
 AWS_ACCESS_KEY_ID:credentials.accessKeyId, AWS_SECRET_ACCESS_KEY:credentials.secretAccessKey,
 ...(credentials.region ? {AWS_DEFAULT_REGION:credentials.region} : {}),
 ...(credentials.sessionToken ? {AWS_SESSION_TOKEN:credentials.sessionToken} : {})};
const run = (args) => {
 const result = spawnSync('/usr/bin/restic', ['--no-cache', ...args],
  {env, stdio:'ignore', timeout:7200000, killSignal:'SIGKILL'});
 if (result.error || result.status !== 0) throw Error('RESTIC_RECOVERY_FAILED');
};
run(['restore','EXACT_RESTIC_SNAPSHOT_ID','--host','STABLE_DEPLOYMENT_ID',
 '--tag','personal-workbench','--target',destination]);
const snapshot = `${destination}/EXACT_SNAPSHOT_DIRECTORY`;
chmodSync(snapshot, 0o700); // restic 保存的原权限本已私有；只操作此次新恢复目录。
const verified = spawnSync(process.execPath,
 ['/opt/workbench/backup.mjs','verify','--snapshot',snapshot], {stdio:'inherit'});
if (verified.error || verified.status !== 0) throw Error('RESTORED_SNAPSHOT_NOT_VERIFIED');
const restored = spawnSync(process.execPath,
 ['/opt/workbench/backup.mjs','restore','--snapshot',snapshot,
 '--destination',`${destination}/verified-application`], {stdio:'inherit'});
if (restored.error || restored.status !== 0) throw Error('ISOLATED_RESTORE_FAILED');
```

上述恢复命令要求恢复目录父级也是操作员独占私有目录，并由 UID11000 创建；事先确认三个输入文件的真实路径、UID11000、`0600` 权限和父目录无符号链接，可先用生产 `readReplicationConfig` 同等校验。恢复输出先由已有 backup verifier 校验完整 inventory、数据库与文件哈希，再恢复成 `verified-application/db.sqlite` 与 `blobs/`。目标须不存在；不激活、不替换活动数据。若 restic 保存的是绝对路径，应按 `restic ls` 观察的实际目录定位，不能猜测路径后宣称已恢复。

## 两种密钥的独立离线保管

采集输入的加密密钥和 Android release 签名 keystore 是不同秘密。二者都不进入普通快照、S3 快照目录或服务器部署包；实际外部保管仍未配置。restic 仓库口令也需独立备份。

准备已挂载的离线介质，以及只读、私有的独立强口令文件。目标文件必须原先不存在，先使用 `test ! -e` 检查，禁止 `--yes` 覆盖。以下例子要求操作员安装 GnuPG；口令仅通过文件读取，明文只经过管道，不写普通临时文件：

```sh
# 管道失败必须中断；不要开启 shell 命令追踪。
set -o pipefail
test ! -e /mnt/offline/capture-key.gpg
docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T api node --input-type=module -e 'import {readFileSync} from "node:fs"; process.stdout.write(readFileSync("/keys/capture.key"))' | gpg --batch --pinentry-mode loopback --passphrase-file /mnt/operator-private/offline-passphrase --symmetric --cipher-algo AES256 --output /mnt/offline/capture-key.gpg
# 在持有 Android 发布密钥的机器上单独执行；替换为已有 keystore 的确切路径。
test ! -e /mnt/offline/android-release-keystore.gpg
gpg --batch --pinentry-mode loopback --passphrase-file /mnt/operator-private/offline-passphrase --symmetric --cipher-algo AES256 --output /mnt/offline/android-release-keystore.gpg /exact/private/path/android-release.keystore
```

使用 `gpg --decrypt` 向私有管道回读并比较原件哈希，独立保存 keystore alias、签名证书 SHA-256 与 keystore/key 口令（可放在另一份操作员加密文档中）；不要把口令写入公开验收记录。恢复 capture.key 要回到专用密钥卷、同 UID11000/0600，并在启动前核验为原先 32 字节；不要通过删除卷来触发新钥生成。采集输入有原始 24 小时到期时间，恢复不续期；密钥丢失不能从快照重建，过期输入也不承诺可重建。
