# 0.11.1 GitHub 预览交付（2026-10-27）

[GitHub 0.11.1 预览版](https://github.com/youzi-dev/learning-workbench/releases/tag/v0.11.1) 已发布 Android APK、Windows x64 安装程序、Mac arm64 / x64 ZIP 和自建服务端包。Android versionCode 为 11001，沿用既有签名与应用身份。8 个附件的远端 SHA-256 和大小与本地一致；Mac 包内容、可执行权限和符号链接、安卓签名/清单、许可证及私人文件排除检查通过。Windows 安装程序及对应解包内容已核对，未执行安装。先前 0.11.0 产物保留。

自动化回归为 100 个文件、1309 项通过、1 项跳过；类型和桌面/浏览器/Android/服务端构建通过。桌面 1280 与手机 375 尺寸的今日、资料页已截图检查，16 组文字对比度通过。源码采用筛选后的公开快照，不包含私人开发历史。

资料来源的已记录范围：[2026-10-24 来源实测证据](../research/2026-10-24-capture-source-evidence.json)。记录时间为 2026-10-23 16:54–16:57 UTC（北京时间 10 月 24 日），yt-dlp 2026.10.21，镜像 `workbench-test-capture:2026-10-24`，镜像摘要按每条结果记录：W3C 样本为 `sha256:25bfab55247f6463bda8de336ba5fec62241ca4fbc841f49a32967af4e4fb350`，W3Schools MP4 样本为 `sha256:cfc445fc80242c5f0b5a80f58003fc7aa8aefc84502c438d456e69404afd6c43`。W3C 的指定图片、PDF、网页选中图片，以及 W3Schools 的指定 MP4 样本通过；Bilibili、YouTube、Vimeo 的记录样本未取得已校验文件。这是对应时间、环境和具体 URL 的结果，不代表站内任意链接都可获取，本轮未重新下载这些样本。

离线粘贴请求只保存脱敏目录和本机获取意图。完整临时网址由设备保护存储保留最多 24 小时；Android 使用提供者强制到期密钥，浏览器和桌面在访问时拒绝过期输入、下次执行清理，不声称进程关闭时已删除。过期后要求重新提供链接。

真实云主机、域名、HTTPS、S3 和离线密钥保管仍未配置。私人安装包、公开签名/公证和商店发布是不同状态。用户已豁免手工/真机验收，不声称已执行。

# 0.11.0 私人交付状态

用户已豁免手工/真机验收，不追加此类交付门槛。构建产物、代码测试、设备安装和外部基础设施分别记录。

- Android、Windows、macOS 的已有私人安装包和哈希/检查记录保留在发布目录；统一记录入口为 `release/private-release-checksums.json`，各平台详见 `release/android-checksums.json`、`release/mac-checksums.json`、`release/windows-checksums.json`。这些记录由原构建流程生成，本次服务器工具不重新构建或修改客户端。macOS ad hoc/未公证，Windows 未签名，不能称为公开商店发布。
- 服务端部署包目标为 `release/learning-workbench-server-0.11.0.tar.gz`，包内及旁置 SHA256SUMS 校验每个显式文件；只有实际打包成功并检查输出后才算已生成。所需 server/capture bundle 须先完成构建。部署说明见 `docs/operations/deployment.md`。
- 当前代码具备 Linux持久卷部署、每日本地快照、可选 restic加密复制、独立新目录恢复和只读公网端点检查。聚焦测试及隔离演练只证明其各自覆盖范围；实际构建/本地运行证据由根任务保留，不能从此文推断已在云上执行。
- 实际云主机、公网域名/证书、S3仓库/凭证、采集密钥和Android签名密钥的外部离线保管尚未配置；真实公网 smoke、独立S3复制与云端恢复未完成。运行工具或本地加密演练不改变这些外部状态。

源码工作记录入口：`.superpowers/sdd/2026-10-23-personal-workbench/task-12c-report.md`、`task-12b2-report.md`、`task-12b3-report.md`；这些内部工程记录不进入服务器部署包。后续外部资源准备后，按运维文档实际执行并单独记录结果。
