# 日常工作台 · Personal Workbench 0.11.1

把「保存资料—说明用途—安排后续事项」放在同一条工作线上。首发客户端面向 Android、Windows 和 macOS；保留原有学习模块及数据。iPhone / iPad 不在首发范围内。

[官网与平台选择](https://youzi-dev.github.io/learning-workbench/) · [GitHub 版本页](https://github.com/youzi-dev/learning-workbench/releases) · [交付状态](docs/releases/personal-workbench-acceptance.md)

版本页中实际发布的附件才是可下载产物。本 README 中的版本号、构建命令和目标平台不表示附件已上传。当前是私人分发预发布路线，手工与真机验收已由用户豁免，不声称已执行；应用商店发布、公开签名和公证是独立状态。

## 从今天开始使用

1. 安装与你设备匹配的已发布包，打开应用。桌面安装名称仍可能显示「学习工作台」，应用身份保持不变。
2. 在「今日」写日常记录，添加待办；需要固定时间的事项放入日历。每天回看完成与未完成的事。
3. 在资料中保存本地文件或网址，写清用途，再安排阅读、整理或其他下一步。离线时可先保存获取意图；服务端自动采集需要网络、来源支持及访问权限。
4. 进入保留的学习模块，继续原站阅读、动手学习和可选 AI 教学。学习记录从用户自己的实际产出积累，软件不保证“看过即学会”。
5. 定期导出便携备份并另行保管；同步和本机缓存都不能替代独立备份。

本地日常功能可以先用。跨设备同步、服务器附件存储和网址自动获取需自行部署 HTTPS 服务端，并配置自己的账户及设备配对。本项目不提供现成云主机、域名或云账号；下载客户端不会自动获得云服务。

## 选择正确的客户端

| 平台 | 选择 | 分发边界 |
| --- | --- | --- |
| Android 10+ | APK | 使用固定私人分发签名；后续升级须沿用同一签名，私钥不公开 |
| Windows x64 | EXE 安装包 | 未签名开发版，系统可能显示未知发布者 |
| Mac Apple Silicon | arm64 ZIP | ad-hoc 签名，未进行 Apple 公证 |
| Intel Mac | x64 ZIP（仅有实际发布附件时可用） | ad-hoc 签名，未进行 Apple 公证 |

Mac 请在「关于本机」确认芯片。网页中的 Mac / Intel 用户代理不能可靠识别 Apple Silicon，官网只提示平台，不猜测架构，也不会自动下载或跳转。

## 资料、同步与数据

- 客户端资料文件采用 **1 GiB 单文件上限**；服务端采集最多 **2 个并发任务**。这是应用策略，不是云主机容量承诺。
- 资料文件本地缓存默认 **2 GiB**，按账户管理。优先清理未固定、未使用的旧文件；固定或正在使用的文件不能因此随意删除，空间不足会报告错误。此上限不包含数据库、便携备份、旧学习教材缓存或服务端数据。
- 桌面日常记录使用应用数据目录中的账户隔离 SQLite 数据；原有 `document-v1.json` / `state.json` 学习记录作为升级迁移来源保留。不要为了升级手动清空应用数据。
- 账号、权限变化会隔离相应数据。同步失败和未完成的本地修改有自己的状态；不要把“已保存到本机”当成已同步到服务器。
- 便携备份不包含 API Key、同步令牌或服务器运维密钥。备份包含个人内容，请自行决定保存和分享范围。
- 服务器运营者需要另行安排数据库、附件、加密密钥和离机副本。见[在线备份与隔离恢复](docs/operations/backup-restore.md)、[离机加密复制](docs/operations/offhost-backup.md)。

网址自动采集遵循 HTTPS、来源和权限限制，不保证任意 Bilibili、YouTube、Vimeo 或其他站内链接都可获取。具体样本结果与时间见[来源实测记录](docs/research/2026-10-24-capture-source-evidence.json)。需要授权的内容不绕过登录或访问控制。

## 保留的学习能力

- 原站阅读与可选 AI 教学：主动开启帮助，选择自己的接口、模型与 API Key。请求内容发送到所选服务商；阅读原网页需要网络。
- 原创 JavaScript 实践：函数、列表处理、请求路径三个单元，先读最小例子，再确认学过、写代码、查看真实结果并保存自己的解释。QuickJS Worker 无网络、磁盘或宿主接口，限制时间、内存与输出。
- 辅助对话独立保存，结论先进入主聊天草稿；录音识别也先进入草稿，均不自动发送。桌面语音使用本地引擎，权限与声音仍受设备环境影响。
- Docker 项目副本、命令、编辑及差异应用属于桌面功能，默认断网，依赖本机 Docker 环境。

[旧浏览器学习体验](https://youzi-dev.github.io/learning-workbench/learn/) 是既有学习页面，数据保存在该浏览器。它不是新日常工作台云部署，也不证明三端同步已上线。浏览器语音的内部可选实验及其限制见[公开源码说明](docs/public-source.md#可选浏览器语音构建边界)。

## 从源码运行

需要 Node.js ≥22.13.0、**pnpm 11.19.0**。服务端使用 Node 内置 SQLite，启动前运行兼容性检查；部署镜像采用运维文档中的固定 Node 版本。首次安装依赖、语音组件、Gradle 和 Android 依赖需要网络。

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm prepare:speech
pnpm dev
```

本地桌面启动后，日常功能先写本机数据。测试与开发数据应使用独立目录，勿把私人资料放进源码树。

### 客户端构建

```sh
# 当前 Mac 架构；Apple Silicon 上生成 arm64 目录
pnpm package:mac
# Intel Mac
pnpm package:mac:x64
# Windows x64 未签名安装包
pnpm package:win:installer:unsigned
```

桌面语音准备会下载并校验固定来源的引擎与模型。`package:mac` 产出应用目录，ZIP 为交付时另行归档；这些命令不上传 GitHub，也不完成公证或设备验收。

Android 需要 JDK 21、Android SDK 36、Gradle wrapper 8.14.3：

```sh
pnpm build:android
pnpm prepare:android-notices
pnpm sync:android
# 不需要私人分发密钥的本地调试包
cd android
./gradlew assembleDebug
```

私人签名发行包使用 `pnpm package:android`。运行前由维护者在源码外配置 `WORKBENCH_ANDROID_KEYSTORE`、`WORKBENCH_ANDROID_KEY_ALIAS`、`WORKBENCH_ANDROID_STORE_PASSWORD_FILE`、`WORKBENCH_ANDROID_KEY_PASSWORD_FILE`；后两项是仅操作者可读的密码文件路径。缺少签名输入会失败，不回退为 debug 签名。不得把密钥或密码文件加入仓库。

### 自建服务端与旧浏览器页面

```sh
pnpm verify:sqlite
pnpm build:server
pnpm build:capture
pnpm package:server
# 仅构建旧浏览器学习体验，不部署日常工作台云
pnpm build:browser
pnpm preview:browser --port 4175
```

服务端部署包、Linux Docker / Compose、HTTPS、账户配对和资源预算见[部署说明](docs/operations/deployment.md)。API 与私有采集 broker 的权限边界见[采集代理说明](docs/operations/capture-broker.md)。真实云主机、域名、S3 与离线密钥保管仍需运营者配置；构建成功不代表公网可用。

## 公开源码与许可

此仓库发布当前工作树经过明确清单导出的源码快照，不携带私人开发历史、用户记录、密钥、构建产物或下载的语音权重。完整规则与无工作流发布方式见[公开源码边界](docs/public-source.md)。当前发布不包含 GitHub 工作流，不宣称远端自动 CI 已运行。

原创代码采用 [MIT](LICENSE)，第三方依赖、原生组件、语音模型遵循各自许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [licenses](licenses)。第三方网站正文不作为本项目源码发布。
