# 公开源码快照

公开仓库为 [youzi-dev/learning-workbench](https://github.com/youzi-dev/learning-workbench)。发布使用当前工作树经过明确清单挑选的文件；不读取、复制或推送 `.git/` 和私人开发历史。源码公开、客户端附件上传、签名与公证、设备验收、商店发布、云部署分别记录，任何一项不能代替其他项。

## 导出

```sh
node scripts/export-public-source.mjs --output .cache/public-source-0.11.1-new --omit-workflows
```

当前发布账号没有 workflow scope，使用显式 `--omit-workflows` 跳过整个 `.github/workflows/`。不修改 GitHub 权限，也不宣称自动 CI 已运行。不带此选项时仍执行既有默认策略：所选 `.github/` 文件（包括工作流）参加扫描和导出。重复、未知参数或缺少参数值会失败。

`--source` 可指定源码目录；`--output` 必须是尚不存在的新目录。项目内部仅允许 `.cache/` 的新子目录，也可写到项目外。脚本不会覆盖已有目录，不会自动删除失败输出。导出后必须核对清单、构建与实际发布内容，再以新快照更新已有公开仓库，不把私人开发仓库历史推到远端。

## 允许范围

| 范围 | 明确选择的内容 |
| --- | --- |
| 根文件 | 原有 README、LICENSE、第三方/贡献/安全/变更说明、package/pnpm、index、tsconfig、vite/vitest 配置、`.gitignore`；补入 `.dockerignore`、`capacitor.config.ts`、`vite.android.config.ts` |
| `src/`、`scripts/` | 原有 TS/JS/CSS/JSON/HTML/SVG 源码与维护脚本规则 |
| `server/`、`worker/` | 服务端 TS、迁移 SQL，采集 Worker TS；不包含数据库、数据或生成 bundle |
| `android-web/` | Android 的 HTML 入口 |
| Android 固定文件 | 根与 app Gradle 配置、settings/variables/proguard、manifest、wrapper 脚本及 properties；文件名在导出脚本逐一列出 |
| Android 原生目录 | `app/src/main/java/`、`app/src/androidTest/java/`、`app/src/main/res/`、`app/src/main/assets/licenses/` 中明确的 Java/XML/PNG/TXT/JSON 类型；生成 Web assets 不在范围中 |
| 固定 wrapper | 仅 `android/gradle/wrapper/gradle-wrapper.jar`，同时核对 ZIP magic 与固定 SHA-256，不允许任意 JAR |
| `deploy/` | 仅 `server.Dockerfile`、`worker.Dockerfile`、`Caddyfile`、`compose.yaml`、`backup.sh`、`restore.sh`、`egress-guard.sh`、`egress.conf`、`.env.example`，以及公开 `licenses/` 文本；不遍历运营者其他文件 |
| `assets/`、`browser/` | 原有图标、图片、entitlements，以及旧浏览器入口、manifest、图标与来源说明 |
| `licenses/` | 原字节许可证与 notices，包括无扩展名的 LICENSE/COPYING/NOTICE/AUTHORS 名称、原生依赖许可；不截断或改写全文 |
| `tests/` | 原有测试代码与 JSON/HTML/TXT 夹具；额外仅允许三个确定的原创夹具 `fixtures/workbench/schedule.csv`、`schedule.ics` 和固定 magic/hash 的 `reading-two-pages.pdf` |
| `website/`、`.github/` | 静态官网源文件、公开协作配置；工作流是否包含由上述显式选项决定 |
| `docs/` | 仅本文、`operations/deployment.md`、`operations/backup-restore.md`、`operations/offhost-backup.md`、`operations/capture-broker.md`、`releases/personal-workbench-acceptance.md` 与其引用的 `research/2026-10-24-capture-source-evidence.json` |

README、LICENSE、package.json、pnpm-lock.yaml 必须存在。README 与所选公开 Markdown 文档的相对链接必须能在快照中找到，引用未选择的私人说明会阻止导出。不扩大为整份 research/spec/plans 目录，也不包含截图、用户历史或本机 QA 记录。

固定二进制的 SHA-256：

- Gradle wrapper：`7d3a4ac4de1c32b59bc6a4eb8ecb8e612ccd0cf1ae1e99f66902da64df296172`
- 原创双页 PDF 测试夹具：`ccf50fc7169305910b032eadcf22cd47e61341d9835a3a8b8011f8ab220ae6a1`

两者仍参加凭据和个人路径扫描，固定 hash 仅为已知必要二进制解除文本 NUL 限制；改动字节需重新审阅，不接受任意 PDF/JAR。

## 清单与文件模式

`PUBLIC_SOURCE_MANIFEST.json` 使用 schemaVersion / policyVersion **2**，记录 `omitWorkflows`、排序后的文件相对路径、字节数、SHA-256 和 `mode`（`0644` 或 `0755`）。`sourceTreeSha256` 是 `files` 数组紧凑 JSON 的 SHA-256，包含文件模式；清单自身不递归参与散列，不写本机绝对路径。

文件逐字节复制。仅已选择的维护脚本与固定 wrapper/部署脚本可以保留原有执行位；其余文件统一为0644。导出目录、子目录以0755申请创建（受运行环境 umask 约束）。发布时应保留清单与执行模式，使 `android/gradlew`、可执行备份脚本能直接运行。

## 隔离与失败条件

`.git/`、`.cache/`、`node_modules/`、语音权重 `resources/`、`build/`、`.gradle/`、`dist*` 和发布目录不进入快照。Android `local.properties`、签名材料、生成 capacitor Web payload、部署 `capture-dist/`、真实 `.env` 和私人运营文件均不选择；只有固定 `deploy/.env.example` 可以公开。

嵌套用户数据、私人目录、备份、教材缓存、凭据/签名目录仍排除。所选文件出现意外扩展名、隐藏名、空格、非 ASCII 文件名或符号链接会失败。确切文件与目录的祖先也检查符号链接；读取通过禁止跟随链接和真实路径/文件身份检查，必须留在源码内。

单文件上限8MiB，总量64MiB。图片核对常见文件头；未特许为固定二进制的文本不能有 NUL。构建时下载的依赖、语音模型、运行时和实际安装包不进入源码快照。

扫描覆盖常见 OpenAI/DeepSeek/Anthropic、GitHub、AWS、Google、Slack、Stripe token 形状、私钥头、带密码的 HTTP(S) URL，以及个人 home 路径。包括图片和固定二进制在内的每个所选字节都扫描；诊断只给类别及相对文件名，不打印命中内容或本机路径。

明确的 `YOUR_API_KEY`、短虚构 Key、example/test/invalid 保留域名 URL 可以原样保留。常规虚构账号路径、localhost 测试凭据和现有 `x:y` URL 安全夹具仅在 `tests/` 内按原策略豁免；运行机器真实账号不享受此例外。完整 token 即便在测试中也拒绝，应在运行时构造虚构值，不能脱敏后发布真实私人输入。正则不能识别所有秘密或个人信息，维护者仍需审阅来源、用途和许可。

所有校验完成后才创建输出，采用排他写入并检查输出目录身份和真实父目录。失败输出保留供检查，不递归清理可能被并发替换的路径。普通路径替换能被发现，但不能承诺阻止所有并发竞态；仅成功退出且与清单逐项一致的快照可以发布。

## 可选浏览器语音构建边界

旧浏览器学习入口仍使用既有部署。普通 `pnpm build:browser` 不准备可选语音、不下载模型，公开入口默认不启用浏览器语音实验。源码中的固定来源/许可/hash 元数据和准备脚本可公开；`.cache/browser-local-voice/`、生成的 `dist-browser/optional-asr/` 和权重不进入源码快照。

内部实验必须明确设置 `WORKBENCH_BROWSER_ASR=1`，先构建 shell，再在具备明确模型交付 URL 和真实 Worker/Worklet 源码时运行 `pnpm prepare:browser-asr`。准备过程核对固定来源、大小与 SHA；失败或半份输出不可部署。模型单独下载，不把 optional-asr 放进默认 shell 的安装预缓存。源码存在不证明任意浏览器、麦克风、手机或模型再分发已通过验收。

## 验证与发布交接

```sh
node node_modules/vitest/vitest.mjs run tests/public-source.test.ts
node --test website/downloads.test.mjs
node website/verify.mjs
```

测试在临时目录使用虚构资料，读取已选真实构建输入和原创夹具核对副本/hash/mode；不导出真实私人 profile。覆盖默认策略、精确新增路径、篡改二进制拒绝、生成物/用户数据隔离、扫描失败、链接闭包、符号链接、目录保护与无工作流模式。

公开前由维护者对最终完整快照检查每个文件的 bytes/SHA/mode 与清单，运行适当项目检查和构建；针对 GitHub 附件核对后才启用官网 URL。更新 Pages 仅覆盖官网着陆页文件并保留既有 `learn/`，不以未审阅的新浏览器构建替换旧数据入口。
