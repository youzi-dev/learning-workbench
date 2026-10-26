# 在线备份与隔离恢复（本地运维工具）

本工具提供 SQLite 在线一致性快照、已提交文件复制、校验、保留策略及新目录恢复。业务写入仍由 API 完成。它不提供公网备份接口，不会部署云服务，也不会把同盘副本称为独立备份。

## 命令

使用生产服务相同的 Node 24 运行环境。SQLite 必须通过 `server/database.ts` 的已修复 WAL-reset 漏洞版本检查，数据库 `user_version` 必须为 1。构建服务器后，独立入口为 `dist-server/backup.mjs`：

```sh
node scripts/build-server.mjs
node dist-server/backup.mjs create --db /srv/workbench-source/db.sqlite --blob-dir /srv/workbench-source/blobs --backup-root /srv/workbench-backups
node dist-server/backup.mjs verify --snapshot /srv/workbench-backups/snapshot-YYYYMMDDTHHMMSSsssZ-UUID
node dist-server/backup.mjs restore --snapshot /srv/workbench-backups/snapshot-YYYYMMDDTHHMMSSsssZ-UUID --destination /srv/workbench-recovery/drill-NEW
node dist-server/backup.mjs prune --backup-root /srv/workbench-backups
```

路径仅为示例，命令不带生产路径默认值。所有参数必须显式指定。提供规范化的绝对路径；路径及已有父级中的符号链接均会被拒绝（macOS 的 `/tmp`、`/var` 别名也属于符号链接，可先用 `realpath` 取得规范路径）。备份根目录、恢复父目录由当前操作系统用户独占，权限必须为 `0700`；文件创建为 `0600`。不要将备份根目录放在源文件目录内，不要让备份根目录包含源数据库或源文件目录。

`restore` 只接受不存在的新目标。已有目标，即使为空，也不会被覆盖或合并。它先完整校验快照，在随机临时目录重建、重新打开 SQLite 检查完整性、外键、全部表的记录摘要和游标/回执，再发布到新目标。恢复后的布局为 `db.sqlite` 和 `blobs/`。备份及原始业务数据不会被恢复工具改写。实际切换服务、替换现有数据和生产启动不属于此命令。

输出只包括状态、数量、快照标识和哈希，不输出数据库内容、URL、配对码、设备明文令牌或采集密钥。保留策略无法管理的文件名会报告；可能包含敏感字符的名字统一显示为 `[redacted-name]`。脚本接口的 `untouched` 返回原始目录条目，调用者应按敏感信息处理。

## 一致性边界

1. 使用单独的只读 SQLite 连接和真实的 `node:sqlite.backup()`。源 API 不暂停，仍可写入自己的数据库连接。绝不以普通文件复制源数据库及 WAL 代替 SQLite 在线备份。
2. 在线备份完成后立即记录数据库哈希，之后才只读枚举该快照的全部 SQL 表。不会实例化 Auth、CaptureQueue 或其他会迁移、清理输入、修改时间戳的服务。快照验证使用 SQLite `immutable=1` URI，避免 WAL 格式快照被只读打开时生成旁路文件；此选项**仅用于已完成的独立快照**，绝不能用于活动源数据库。
3. 遍历任意模块的 JSON 对象，递归识别 `sha256`、`size`、`mime` 三字段的文件描述符。范围包括当前记录、墓碑、历史 change log、批次/冲突回执及采集回执；未知模块无需中央模块名单。只有描述符对象自身明确写有 `availability: pending` 或 `link-only` 才不要求已提交文件，父对象及 `state: cancelled/pending` 不会隐藏嵌套附件。
4. 当前 DiskBlobStore 的已提交字节和 `<sha256>.json` 标记在业务提交后必须保持不变，且不做垃圾回收。备份保守复制所有账户下的已提交字节和原始标记，逐项流式计算和检查 SHA-256、大小、描述符一致性；因此也保留“文件已提交、采集队列尚未 finalize”的孤立对象。未来增加删除或 GC 前，必须加入备份引用 pin 协议；不能直接删除这些文件。
5. 仅有字节、没有 durable 标记的文件不算已提交。`upload-*`、分片、临时结果、broker scratch 和采集加密密钥都不进入备份。未完成上传要在恢复后由客户端持久化 staging 重新发起，不能从本快照续传服务端分片。

数据库保留全部表的原始内容，包括未知模块、冲突、墓碑、change cursor、幂等批次及操作回执、撤销设备、queued/leased 采集任务，以及加密的 `capture_inputs` 和原有绝对到期时间。保护性运维快照可含这些密文；普通账户导出逻辑没有变更。采集解密密钥必须单独安全恢复，不要放进快照或日志。恢复不会延长输入或租约时限；服务按原有规则在重启/下一次租约处理时清理到期输入、回收过期租约。

## 发布、锁与保留

每次运行使用唯一 `.partial-*` 目录。数据库、已提交文件、原始 sidecar、版本 1 manifest 和带 manifest 哈希的 `complete.json` 都校验并 fsync 后，才重命名为 `snapshot-*`。manifest 包含创建时间、Node/SQLite 运行版本、schema 版本、数据库及每份文件的相对路径/大小/SHA-256、全部表的数量与逻辑摘要及恢复不变量。恢复要求与快照记录一致的 SQLite 版本；版本差异应先在相同固定运行环境中验证，不能靠修改 manifest 绕过。

失败的 `.partial-*` 不会被当成好备份，也不会自动删除。工具同时拒绝任意 manifest 版本升级、路径穿越、相对路径碰撞、符号链接、额外未登记文件及哈希不匹配。哈希用于检测损坏，不是对抗拥有备份写权限者的数字签名；目录访问控制及离机加密仍然必需。

备份根目录中的 `.backup-lock.sqlite` 是本工具独占的运维锁库，包含 application_id、版本和锁所有权标识，不包含业务数据。首次创建先生成完整私有临时库，再用原子、不覆盖的硬链接发布。已有未知锁文件会被拒绝。备份、验证、恢复和清理通过同一根目录的 `BEGIN EXCLUSIVE` 互斥；忙时最多等待约 1 秒后报 `BACKUP_BUSY`。进程退出或崩溃后 SQLite/操作系统自动释放锁，不依赖可能永久遗留的 PID 锁。崩溃残留临时目录保持原样并报告，不能据此判断锁仍被持有。

成功发布后保留最近 7 个不同 UTC 日期的最新快照，加上最近 4 个不同 UTC 周（周一开始）的最新快照，取并集，同一个快照只保留一次。`prune` 可对已有成功快照重新执行同一策略。只删除当前根目录下由本工具所有、完整且重新通过全部校验的快照；未知文件/目录、损坏快照、未完成目录及锁初始化残留均不删除。不会跨目录递归清理，也不会清理正在运行的其他备份。

恢复也锁定快照父目录，避免正在恢复的输入被保留策略删除。因此快照父目录必须是当前用户独占、可写的私有工作目录。离机只读介质上的副本应先复制到独占的可写恢复工作区（保留目录结构及字节），然后运行 `verify` / `restore`；工具不会复制源锁库或信任介质上的锁元数据，也不会为了读取只读介质跳过互斥校验。

## 可重复的隔离演练

```sh
node scripts/verify-backup.mjs
node node_modules/vitest/vitest.mjs run tests/server/backup.test.ts
```

演练脚本只建立自己拥有的临时数据目录与临时构建入口，使用虚构数据，启动两个真实 HTTP API 进程和真实 SQLite/DiskBlobStore。源 API 保持运行，并在在线备份期间完成 HTTP 写入。它验证恢复后认证、记录与墓碑、未知模块、历史记录、批次/冲突回执去重、游标连续性、认证文件下载及哈希、无权限下载被拒，核对恢复没有改写源或备份，最终清理自己的临时环境。输出仅为数量、布尔结果和哈希。

聚焦测试额外检查必需文件缺失/损坏、待上传与孤立提交边界、真实 queued/leased 采集任务及密文输入的时间戳/过期规则、路径及 sidecar 篡改、目标已有数据不变、保留策略、真实跨进程互斥和强制终止后的自动解锁。采集边界使用受控结果，不声称已验收真实下载器。

每日调度现见 [Linux 部署](deployment.md)，可选加密复制与隔离恢复现见 [离机备份](offhost-backup.md)。实际独立 S3 副本、密钥外部托管、云环境部署与生产恢复仍未配置或执行。同盘本地快照和上述隔离测试均不等于独立备份或云端恢复。大文件复制/校验使用固定大小缓冲区；逻辑数据库验证会枚举 SQL 表并在内存中计算记录摘要，大规模数据部署前应评估这一部分的峰值内存。
