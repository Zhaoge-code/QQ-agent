# QQ Agent（桌面端 / Linux 服务器）

> **这个仓库是 [K0nd1us/QQ-agent](https://github.com/K0nd1us/QQ-agent) 的 fork**：桌面版的功能全部来自上游  
> 本 fork 用于解决自用电脑无法长时保持开机状态，导致QQ聊天机器人只能在有限时间内活跃在QQ群聊中的状态  
> 基于主流服务器的 Linux 操作系统进行跨平台二次开发。使用Docker 部署+只读控制台+命令行配置，保证 7×24 稳定性。  
> 具体修改清单见[相对上游的改动](#相对上游的改动)。

## 能实现什么

- **像真人一样混群**：被 @ 或被叫到时回话，平时看心情插嘴；会发文字、表情包、戳一戳，会引用、会 @ 人，知道什么时候该闭嘴
- **记住每个群友**：双向长期记忆——它记得谁是什么风格、爱什么梗、雷点是什么，下次聊天自然带上；记忆页随时可查看、手动编辑
- **看得懂图、上得了网**：视觉模型直接看消息里的图片；内置 6 家搜索服务（含免 Key 的 Bing 网页解析），还能自己加任意兼容搜索服务
- **花多少看多少**：每次调用的 token 和成本精确记录，按天 / 按会话 / 按模型三个维度统计，缓存命中率、峰谷分时计价、图片计费口径全标清楚
> 具体功能还请参考[原作者](https://github.com/K0nd1us/QQ-agent)

## 技术架构
- **协议** 使用OneBot v11 和第三方组件 NapCat 连接QQ
- **控制台** 可以实时查看机器人在QQ中的发言和 token 用量、缓存命中情况
- **命令脚本** 内置命令脚本，可以实现API设置、发言频率修改、图片表情包识别开关。[具体参考部署手册](docs/deploy-docker.md#3-填配置命令行服务器上执行)
> 具体架构还请参考[原作者](https://github.com/K0nd1us/QQ-agent)

```bash
npm install          # 装依赖
npm start            # 桌面端启动
npm run server       # headless 模式：浏览器打开 http://127.0.0.1:3210
npm test             # 全部测试（149 项）：功能自测 + 前端渲染 + 滚动加载 + 用量端到端
```

## 项目结构

```text
QQ-agent/
├── src/                 后端：Node.js，零框架
│   ├── app.js           组装各模块，对外暴露接口
│   ├── server.js        控制台 HTTP/SSE 服务；SIGHUP 热重载也在这里
│   ├── orchestrator.js  核心：攒消息 → 开一轮无状态会话 → 调工具 → 发消息
│   ├── prompt.js        系统提示词拼装（人设 / 规则 / 存档摘要 / 当前时间）
│   ├── onebot.js        OneBot v11 客户端：WS 收事件、HTTP 发动作，带断线重连
│   ├── llm.js           模型调用与 token / 成本统计
│   ├── tools.js         模型能调用的工具表（发消息 / 看图 / 搜索 / 记忆 …）
│   ├── store.js         每个会话的消息存档（未读标记）
│   ├── memory.js        群友长期记忆的读写与整理
│   ├── sessions.js      会话留档（控制台「会话」页看到的那些）
│   ├── config.js        配置读写（原子写盘 + 默认值深合并）
│   ├── safe-fetch.js    联网抓取（SSRF 防护）
│   └── …                providers / web-search / stickers / personas / telemetry 等
├── ui/                  控制台前端：原生 HTML/CSS/JS
├── bin/qq-agent.mjs     服务器形态的配置 CLI（show / set-* / reload）
├── electron/main.js     桌面壳：托盘常驻、开机自启、关窗不退出
├── test/                测试：功能自测 / 前端渲染 / 滚动加载 / 提示词 / 用量端到端
├── scripts/             维护脚本（发布前脱敏 sanitize-release.mjs 等）
├── docs/                文档：deploy-docker.md（部署与排障）、model-prices.md
├── napcat/config/       预置协议端配置：onebot11.json（WS 3001 + HTTP 3000）
├── data/                运行时数据，不进版本库：config.json（含 Key）/ messages / memory / sessions
├── Dockerfile           服务器镜像：多阶段、只装生产依赖、非 root 运行
├── docker-compose.yml   qq-agent + napcat 两个服务，端口只发布到 127.0.0.1
├── prices.json          内置模型价格表
└── 启动QQ机器人.bat     Windows 桌面版双击启动
```

桌面版和服务器版共用同一份 `src/`，区别只有外壳（Electron vs Docker）和协议端（SnowLuma vs NapCat）。

## 开始使用
首先需要 docker 容器和 docker compose 环境  
```bash
docker pull mlikiowa/napcat-docker:v4.18.28 # 拉取 NapCat 官方镜像

docker compose up -d napcat # 启动 NapCat 镜像

docker compose up -d --build # 启动聊天机器人和控制台

docker compose exec qq-agent node bin/qq-agent.mjs set-onebot \
  --ws ws://napcat:3001 --http http://napcat:3000 # 连接 NapCat 和机器人后端
  
docker compose exec qq-agent node bin/qq-agent.mjs set-api \
  --base-url http://模型网址 --key AIP_key --model 模型名称 # 配置模型网址、AIP key 和模型名称
  
docker compose exec qq-agent node bin/qq-agent.mjs set-allow group:群号 # 添加活跃群号

docker compose exec qq-agent node bin/qq-agent.mjs test-api # 测试连通性
```
然后你就可以在群里和你的AI好友聊天了  

> 如果想要监控 NapCat 和 QQ 机器人，需要建立本机和服务器的 ssh 通道之后才能在网页访问控制台  
> 具体部署信息请查看[部署文档](./docs/deploy-docker.md)  

### 部署到 Linux 服务器（Docker）
上方列举的命令就是完整流程，但还剩下下面三个事情需要完成：

1. **把 NapCat 镜像拉取到服务器**：能直连 Docker Hub 就 `docker pull`，不能就在本机 `docker save` 成 tar 传上去 `docker load`
2. **扫码登录机器人 QQ**：`docker compose logs -f napcat`，拿日志里的二维码链接用手机 QQ 扫；首次登录后 NapCat 会按 QQ 号生成实际生效的 `onebot11_<QQ号>.json`
3. **在自己电脑上看控制台**：端口只发布在 `127.0.0.1`，开条 SSH 隧道就行，公网不用开任何端口

```bash
ssh -N -L 8321:127.0.0.1:3210 你的用户名@服务器IP   # 然后浏览器打开 http://127.0.0.1:8321
```

这种形态下控制台是**只读监控台**（`QQ_AGENT_READONLY=1`）：状态、会话、存档、记忆、用量都能看，暂停 / 唤醒 / 标已读这些运营拨杆也能按；但**改配置和读明文 Key 的接口全部封死** —— 配置只能走服务器上的命令行，密钥不会流到"能打开浏览器"的地方。

修改提示词与人设、更新代码、本地打包上传、权限与端口排障、真机踩坑记录，都在 [`docs/deploy-docker.md`](docs/deploy-docker.md) 里。

### 分发前脱敏

分享自己的部署副本前执行：

```bash
node scripts/sanitize-release.mjs --dry-run   # 先看会清理什么
node scripts/sanitize-release.mjs             # 清空 Key / 白名单 / 存档 / 登录态
```

## 相对上游的改动

桌面版的功能全部来自上游；本 fork 只添加和修改了有关 Linux 操作系统部署的部分

**部署形态**

- 新增 `Dockerfile`（多阶段、只装生产依赖、非 root 运行）、`docker-compose.yml`、`.dockerignore`，以及完整部署文档 [`docs/deploy-docker.md`](docs/deploy-docker.md)
- 一份 compose 管两个服务：`qq-agent`（本体 + 控制台）和 `napcat`（协议端，NapCat 官方镜像 `mlikiowa/napcat-docker`，固定版本）
- 预置 `napcat/config/onebot11.json`：**同时开 WebSocket(3001) 和 HTTP(3000)** —— 收事件走 WS、动作走 HTTP，只开一个就会出现"收得到、发不出去"
- 所有端口只发布到宿主机 `127.0.0.1`，从自己电脑经 SSH 隧道访问，公网不用开任何端口
- 容器日志轮转、healthcheck、`restart: unless-stopped`；`.gitignore` / `.dockerignore` 把登录态和数据目录挡在版本库与镜像之外

**只读控制台（服务器形态）**

- `QQ_AGENT_READONLY=1`：状态、会话、存档、记忆、用量照常看；**所有配置写入，以及 `/api/api-key`、`/api/search-key`、`/api/providers/key` 三个明文密钥接口一律 403**
- 只放行运营拨杆：暂停 / 恢复、唤醒一次、标为已读、查看图片、维护记忆
- 前端同步：顶部常驻只读横幅、设置页与协议端页的输入控件全部禁用、写请求在客户端就被挡掉

**配置只走命令行**

- 新增 `bin/qq-agent.mjs`：`show` / `set-api` / `set-allow` / `set-deny` / `set-tier` / `set-vision` / `set-sticker` / `set-onebot` / `test-api` / `reload`
- 原子写盘，改完自动给主进程发 `SIGHUP` 热重载，不用重启容器

**图片与表情的硬开关**

- `set-vision on|off`：关掉看图（`get_message_images` / `get_sticker_image` 一起下架），模型只看到 `[图片]` 占位符，提示词同步改成"看不到图、不要编造"
- `set-sticker on|off [--encourage 0-3] [--collect on|off]`：关掉后 `send_sticker` / `list_stickers` / `get_sticker_image` / `sticker_note` / `collect_sticker` **整组下架**，提示词不再注入表情目录与表情策略段 —— 机器人彻底不能发表情
- 为什么必须在工具层下架：只停用"表情目录注入"并不够，工具还挂在工具表里，模型照样能调用 `send_sticker` 把表情真发出去
- 两个开关都走 `SIGHUP` 热重载，改完立刻生效；`--encourage` 只调"愿不愿意配表情"的引导强度（0 不鼓励 ~ 3 很积极），不是强制
- 关掉图片识别 ≠ 拒收图片：群里发的图照常进聊天记录（存档里就是 `[图片]` 占位符）、也照常触发回应，只是模型看不到内容、也不会去下载
- 当前生效状态：`docker compose exec qq-agent node bin/qq-agent.mjs show`，会多出「图片识别」「表情包」两行

**7×24 稳定性**

- OneBot 断线指数退避重连（3s→30s 封顶，带 ±30% 抖动），协议端后启动也能自动接上
- WebSocket 心跳探测（45s 一轮，连续两轮没回音就重连；`QQ_AGENT_WS_HEARTBEAT=0` 可关）
- `SIGTERM` / `SIGINT` 优雅退出（最多等 8 秒兜底），`SIGHUP` 热重载配置，未捕获异常记日志后退出、交给 restart 策略
- 日志带 ISO 时间戳，容器时区可配

**其他**

- 控制台监听地址与 `strictPort` 变成可配；监听非回环地址又没设令牌时**拒绝启动**，要显式 `QQ_AGENT_ALLOW_OPEN_BIND=1` 才放行
- 新增 `QQ_AGENT_NO_TELEMETRY=1` 关闭匿名用量上报
- 前端文案去 SnowLuma 化，协议端表述中性（SnowLuma / NapCat / 其它 OneBot v11 实现都能用）

## 致谢

- **[K0nd1us/QQ-agent](https://github.com/K0nd1us/QQ-agent)** —— 这个 fork 的上游。桌面版的一切（架构、提示词、控制台）都出自这里，由 **Kondius** 开发与维护
- **[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)** —— 上游的上游，"仿真群友"的思路是这一切的起点
- **[NapCat](https://github.com/NapNeko/NapCatQQ)** —— 服务器形态用的 QQ 协议端（OneBot v11），官方镜像见 [NapCat-Docker](https://github.com/NapNeko/NapCat-Docker)
- **SnowLuma** —— 桌面形态的 QQ 协议端（OneBot v11）提供者，独立第三方项目，受其自身 EULA 约束

本 fork（Linux/Docker 部署 + 只读控制台）由 **Zhaoge-code** 维护。

## 许可

本项目以 MIT 许可发布（见 [LICENSE](LICENSE)）。
前置依赖 SnowLuma 与 NapCat 都是独立项目，受各自许可约束，不受本项目许可覆盖。
