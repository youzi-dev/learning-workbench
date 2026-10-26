# 日常工作台下载官网

静态中文页面，沿用既有配色与响应式布局；无外部字体、图片、统计脚本或表单。页面上的学习示意是代码绘制的示意图，不是客户端验收截图。

## 本地检查与预览

```sh
node website/verify.mjs
node --test website/downloads.test.mjs
python3 -m http.server 4174 --directory website --bind 127.0.0.1
```

打开 `http://127.0.0.1:4174`。ES modules 需要 HTTP，不使用 `file://`。自动检查覆盖锚点、资源、语义基础、设备识别、真实 DOM 上的下载状态和链接安全；仍需从 375px / 1280px 的页面截图检查布局。

## 发布配置

仅在对应附件实际上传、公开并读回核对后修改 `config.js`：

```js
version: '0.11.1',
downloads: {
  android: null,
  windowsX64: null,
  macArm64: null,
  macX64: null,
},
```

每个字段独立接受 `null` 或公开 HTTPS 附件 URL。空值显示“准备中”，没有伪造的 `href`；改变配置时也会移除旧链接。URL 不得含用户名、密码或片段，文件名必须与 `version` 及架构完全匹配：

| 字段 | 0.11.1 的附件名 |
| --- | --- |
| `android` | `learning-workbench-android-private-0.11.1.apk` |
| `windowsX64` | `learning-workbench-win-x64-unsigned-development-0.11.1-setup.exe` |
| `macArm64` | `learning-workbench-mac-arm64-private-0.11.1.zip` |
| `macX64` | `learning-workbench-mac-x64-private-0.11.1.zip`（可选） |

`repositoryUrl` 使用已存在的规范仓库 `https://github.com/youzi-dev/learning-workbench`，自动提供源码、README、许可和 notices 链接；不自动生成 Actions 成功声明。`releaseUrl` 只有在实际版本发布后填写。`buildsUrl` 单独可选，未配置回到页面状态说明。

`browserUrl` 默认空，旧 `/learn/` 是既有学习体验，不是日常工作台云部署。页面不启用新的浏览器应用部署。

设备识别只用于推荐标记，所有平台始终可手动选择，无自动下载、跳转、遥测或用户代理上传。Android 优先于 Linux；iPhone / iPad 和触屏 Macintosh 排除为 iOS。Mac 不根据 `MacIntel` 猜芯片，保留 Apple Silicon / Intel 手动选择；Linux 和未知平台显示全部选择。

## GitHub Pages 更新边界

当前 Pages 使用 `gh-pages` 根目录，已有 `learn/` 部署。更新官网时只覆盖本目录对应的着陆页文件，必须保留既有 `learn/` 内容；不要把新的客户端构建覆盖到旧浏览器数据入口。源码快照与 Pages 都不包含私有开发历史。当前 GitHub 授权没有 workflow scope，发布不推送新工作流，也不声称远端自动 CI 已运行。
