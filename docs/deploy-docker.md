# 部署到 Linux 服务器（Docker + SSH 隧道）

把机器人放到一台 7×24 开着的 Linux 服务器上；你自己的电脑只通过 SSH 隧道看控制台。
这套形态围绕三条原则设计：

1. **本体跑在容器里** —— 一个 `qq-agent` service，`restart: unless-stopped` 负责"进程没了自动拉起来"。
2. **配置只在服务器命令行改** —— 控制台开了只读模式（`QQ_AGENT_READONLY=1`）：能看，能按运营拨杆，但拿不到 API Key，也改不了配置。
3. **控制台端口只发布到宿主机 `127.0.0.1`** —— 外部一律走 SSH 隧道。这样既不需要令牌，也没有裸奔的密钥面板。

## 组成

| 组件 | 跑在哪 | 干什么 |
|---|---|---|
| `qq-agent` 容器 | 本项目，`docker compose up -d` | 机器人本体 + 控制台（HTTP :3210） |
| `napcat` 容器 | 官方镜像 `mlikiowa/napcat-docker` | 登录机器人 QQ 号，对外提供 OneBot v11 接口（HTTP :3000 + WS :3001，都不发布到宿主机） |
| 模型 API | 公网 / 自建网关 | OpenAI 兼容，Key 只存在服务器的 `config.json` 里 |
| 控制台 | 你的电脑浏览器 | 经 SSH 隧道访问，只读监控 |

## 0. 前提

- Linux 服务器（Debian/Ubuntu 都行），已装 Docker 与 **`docker compose` 插件**（v2，不是老的 `docker-compose`）：

  ```bash
  curl -fsSL https://get.docker.com | sh     # 官方一键脚本，自带 compose 插件
  sudo usermod -aG docker "$USER"            # 加进 docker 组，然后重新登录一次（否则每条命令都得 sudo）
  docker compose version                     # 能打印版本就够了
  ```

  脚本拉不动就用发行版自带的：Ubuntu 24.04 是 `sudo apt install docker.io docker-compose-v2`；
  Debian 建议按 Docker 官方文档加源装 `docker-compose-plugin`。

- 一个专门用来当机器人的 QQ 号（不建议用主号）
- 一份 OpenAI 兼容接口的 Base URL / Key / 模型名

## 1. 拉代码并启动

```bash
git clone https://github.com/K0nd1us/QQ-agent.git qq-agent   # 换成你自己的 fork 地址
cd qq-agent
docker compose up -d --build
docker compose logs -f qq-agent
```

服务器上没 Docker（或者不想在服务器上构建 —— `npm ci` 要访问 npm 源）也行：在能上网的机器上

```bash
docker build -t qq-agent:local .
docker save qq-agent:local -o qq-agent.tar      # 传到服务器后：
docker load -i qq-agent.tar
docker compose up -d --no-build                 # 镜像已在本地，别再加 --build
```

构建时 npm 源慢/不通就换源：`docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com -t qq-agent:local .`

基础镜像 `node:22-bookworm-slim` 拉不动（报 `net/http: request canceled while waiting for connection`）是另一码事 ——
那是连不上 Docker Hub，跟 npm 无关。两个办法，任选一个：

```bash
# ① 给 Docker 配国内加速源（全局生效，以后拉别的镜像也受益）
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{ "registry-mirrors": ["https://docker.m.daocloud.io", "https://docker.1ms.run", "https://docker.xuanyuan.me"] }
EOF
sudo systemctl restart docker
docker pull node:22-bookworm-slim          # 拉得下来就说明通了

# ② 不动守护进程，只把这次构建的基础镜像换成镜像站地址
echo 'NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim' >> .env
docker compose up -d --build
```

> `/etc/docker/daemon.json` 里如果已经有别的内容，要**合并**进去，别直接覆盖（覆盖掉 `data-root` 之类的配置会出事）。
> 这几个镜像站是社区维护的，隔段时间会失效，拉不动就换一个。

看到这一行就算起来了：

```
控制台已就绪：http://0.0.0.0:3210（只读模式：仅供监控）
```

`docker-compose.yml` 里已经带好容器所需的开关：

| 变量 | 值 | 为什么 |
|---|---|---|
| `QQ_AGENT_HOST` | `0.0.0.0` | 容器内不监听所有地址，端口映射就通不了 |
| `QQ_AGENT_ALLOW_OPEN_BIND` | `1` | 监听非本机地址时程序默认要求令牌；这里靠"端口只发布到 127.0.0.1"兜底 |
| `QQ_AGENT_STRICT_PORT` | `1` | 端口被占直接报错，不偷偷漂到 3211（否则你会对着一个不存在的端口发懵） |
| `QQ_AGENT_READONLY` | `1` | 控制台只读 |

## 2. 协议端（NapCat）—— 已经写在 compose 里了

NapCat 是**另一个要长期运行的程序**，不属本项目：它负责登录你的机器人 QQ 号、对外提供 OneBot v11 接口。
`docker-compose.yml` 里的 `napcat` service 用的是 **NapCat 官方镜像** `mlikiowa/napcat-docker:v4.18.28`
（由 NapCat 官方组织 NapNeko 维护）。**版本要固定**，别改成 `latest`：上游一发版 `latest` 就漂，
机器人会莫名其妙连不上，而且排查时你都说不清跑的是哪个版本。  

[NapCat 官方镜像](https://hub.docker.com/r/mlikiowa/napcat-docker?tag=v4.18.28)

先记牢两条硬性要求，下面全围绕它们：

> 1. **WebSocket 服务器和 HTTP 服务器都要开**（默认 `3001` / `3000`）。机器人**收**事件走 WS，
>    但**所有动作（含发消息）走 HTTP API** —— 只开 WS 的表现是"消息收得到、一条也发不出去"。
> 2. **登录态目录必须持久化**（`./napcat/QQ`），否则容器一重建就要重新扫码。

第 1 条已经由仓库里的 `napcat/config/onebot11.json` 预置好了：NapCat 首次启动会把它当默认配置载入。
登录之后实际生效的会变成 `onebot11_<QQ号>.json` —— 以后要改就在 **WebUI 的网络配置**里改，
或者改那份带 QQ 号的文件再 `docker compose restart napcat`。

> ⚠ **不要**给 napcat 加 `MODE` 环境变量。官方镜像的 entrypoint 每次启动都会拿镜像里的模板覆盖
> `onebot11.json`，而那些模板只开 WS、不开 HTTP，加完正好踩中上面第 1 条坑。

`napcat` service 的环境变量（都写在 `docker-compose.yml` 里，带注释）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `NAPCAT_UID` / `NAPCAT_GID` | `1000:1000` | 容器里进程的 uid/gid，决定 `./napcat/` 下文件的属主。服务器上 `id -u` / `id -g` 看一眼，对不上就写进 `.env` |
| `NAPCAT_ACCOUNT` | 空 | 机器人 QQ 号；填了启动时就直奔它的登录页 |
| `NAPCAT_WEBUI_TOKEN` | 空 | 不填就是随机密码（启动日志里打出来），填了就固定 |

### 2.1 把镜像弄到服务器上

国内服务器直连 Docker Hub 经常不通。两条路：

```bash
# 路 A：服务器能拉就直接拉
docker compose pull napcat

# 路 B：在能上网的机器上打包，再传过去 load（镜像约 600MB）
docker pull mlikiowa/napcat-docker:v4.18.28
docker save mlikiowa/napcat-docker:v4.18.28 -o napcat.tar
scp napcat.tar 你的用户名@服务器IP:/tmp/
# 服务器上：
docker load -i /tmp/napcat.tar
```

### 2.2 首次登录机器人 QQ（扫码）

`6099` 是 NapCat 的 WebUI。compose 里同样只发布到宿主机 `127.0.0.1`，所以先在**你自己的电脑**上开隧道：

```bash
ssh -N -L 6099:127.0.0.1:6099 你的用户名@服务器IP
```

然后在服务器上：

```bash
docker compose up -d napcat
docker compose logs -f napcat              # 找 WebUI 的 token（没设 NAPCAT_WEBUI_TOKEN 时是随机密码）
```

浏览器打开 `http://127.0.0.1:6099/webui`，用日志里的 token 登录，再扫码登录机器人 QQ。
登录态落在 `./napcat/QQ`，之后重启容器不用再扫 —— 这个目录别删。

### 2.3 让机器人连上它

两个服务在同一条 compose 网络里，按服务名互访。
**不要写 `127.0.0.1`**：容器里的 127.0.0.1 指的是容器自己。

```bash
docker compose up -d qq-agent
docker compose exec qq-agent node bin/qq-agent.mjs set-onebot \
  --ws ws://napcat:3001 --http http://napcat:3000
```

启动顺序随便：机器人连不上会指数退避重连（3s→30s 封顶），NapCat 后起来也能自动接上。

> **要不要给 OneBot 接口加 token？** 默认留空就是安全的：`3000`/`3001` 根本没发布到宿主机，
> 只有同一条 compose 网络里的容器能连。真有洁癖的话，把 `napcat/config/onebot11.json` 里两处
> `"token"` 填成同一个随机串（`docker compose restart napcat`），再
> `set-onebot … --token <同一个串>`。
>
> **想把 NapCat 装在宿主机上**（不用容器）：按它官方文档装好，机器人侧改用
> `--ws ws://host.docker.internal:3001 --http http://host.docker.internal:3000`，
> 顺手 `docker compose stop napcat` 把容器版停掉。
## 3. 填配置（命令行，服务器上执行）

控制台是只读的，配置一律用这个 CLI 改。**改完会自动给主进程发 `SIGHUP` 热重载，不用重启**。

```bash
# 看当前配置（密钥自动脱敏）
docker compose exec qq-agent node bin/qq-agent.mjs show

# 模型接口（给 --key 时会自动清空"目录提供商"，否则它的 Key 优先级更高，会导致新 Key 不生效）
docker compose exec qq-agent node bin/qq-agent.mjs set-api \
  --base-url https://api.deepseek.com/v1 --key sk-xxxx --model deepseek-chat

# 白名单（不设的话机器人不响应任何群）
docker compose exec qq-agent node bin/qq-agent.mjs set-allow group:123456,group:234567
docker compose exec qq-agent node bin/qq-agent.mjs set-allow --add group:999

# 话痨程度：0 = 只回 @，100 = 什么都想插一嘴
docker compose exec qq-agent node bin/qq-agent.mjs set-tier 40

# 图片识别 / 表情包：按需关掉（立刻生效，不用重建镜像）
docker compose exec qq-agent node bin/qq-agent.mjs set-vision off
docker compose exec qq-agent node bin/qq-agent.mjs set-sticker off

# 连通性自检（真的发一条 ping 出去）
docker compose exec qq-agent node bin/qq-agent.mjs test-api

# 手工改过 data/config.json 之后，让它重读
docker compose exec qq-agent node bin/qq-agent.mjs reload
```

条目写法：`group:群号` 或 `private:QQ号`；只写数字默认当群号。

改人设（`persona.roleText` / `persona.customRules` / `memberNotes`）这类没有 CLI 命令的字段，在宿主机上编辑 `data/config.json` 再跑一次 `reload` —— 步骤见 README 的「改提示词 / 人设后怎么生效」。**改前先备份**：JSON 写坏了程序会静默回落到默认配置。

```aiignore
话痨程度参考表
0------10------20----------------------90----100
│ 1档   │  2档  │      3档 概率线性      │ 4档 │
仅艾特   +关键词    prob=(pos-20)/70*100%   全响应
```

## 4. 从 Windows 看控制台

控制台端口只发布在服务器的 `127.0.0.1` 上，所以先在自己电脑上开一条隧道：

```bash
ssh -N -L 8321:127.0.0.1:3210 你的用户名@服务器IP
```

然后浏览器打开 `http://127.0.0.1:8321`。

- `-N` 表示"只转发端口，不开 shell"，所以**不会影响你另外开着的 SSH 登录**：那是一条普通会话，这是另一条专用通道，两者互不干扰。
- 客户端用 8321 是为了避开本机可能装着的桌面版（它也占 3210）。
- 想让它别掉线，可以加 `-o ServerAliveInterval=30 -o ServerAliveCountMax=3`。
- 隧道是加密的，且服务端只监听回环地址，所以**不需要额外配访问令牌** —— 拿到浏览器的人得先能 SSH 上服务器。
  如果你把端口发布改成了 `3210:3210`（暴露到公网），请务必同时设 `QQ_AGENT_TOKEN`，否则程序会拒绝启动。

## 5. 控制台在只读模式下能做什么

**能看**：状态栏、体检卡、会话（含实时思考与工具调用）、消息存档、记忆、用量与成本。

**能按的运营拨杆**（刻意放行）：

- 暂停 / 恢复、恢复并全部标为已读
- 某群"唤醒一次处理"、"全部标为已读"
- 记忆页的编辑、删除、单独整理（内容维护，不是配置）
- 消息里的图片查看

**封死的**：所有配置写入（模型、Key、白名单、响应档位、限频、人设、搜索服务、协议端地址/启停），以及 `/api/api-key`、`/api/search-key`、`/api/providers/key` 三个明文密钥接口 —— 全部返回 403，并提示改配置的命令行。

只读模式下设置页的按钮会一并禁用，顶部有常驻的「只读」横幅。

> 已知取舍：**群备注**（给群友起显示名）走的是 `/api/config`，所以只读下会提示"只读模式…"。
> 要改备注只能上服务器改 `config.json` 的 `memberNotes` 再 `reload`。

## 6. 日常运维

```bash
docker compose logs -f --tail 200 qq-agent   # 看日志（日志带 ISO 时间戳）
docker compose logs -f --tail 200 napcat     # NapCat 的日志（扫码、掉线、收发异常都在这）
docker compose ps                            # 两个容器都在跑才算正常
docker compose restart qq-agent              # 重启机器人（SIGTERM 优雅退出，最多等 8 秒）
docker compose restart napcat                # 重启协议端（SIGINT 退出；QQ 掉线先试这个）
docker compose down                          # 两个都停掉
docker compose up -d --build                 # 升级：拉新代码后重建机器人本体
```

容器日志已经配好轮转（`max-size: 10m` / `max-file: 3`），不用另外管；日志盘小的服务器把这两个值调小即可。

**数据都在具名卷 `qq-agent-data`（容器内 `/data`）**：`config.json`（含 API Key）、聊天存档、群友记忆、会话留档、遥测计数。
容器删了重建不会丢，但请定期备份：

```bash
docker run --rm -v qq-agent-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/qq-agent-$(date +%F).tar.gz -C /data .
```

恢复就是把 tar 解回同一个卷，然后 `docker compose restart qq-agent`。

**数据卷属主**：容器是以非 root（uid 1000）跑的，所以 `/data` 必须 uid 1000 可写。
镜像如果在 `chown` 之前就声明了 `VOLUME`，Docker 会丢弃 `VOLUME` 之后对该目录的改动，
新建的卷就落到 root 名下，启动时报 `EACCES: permission denied, mkdir '/data/sessions'`。
不用删数据，把属主改回来即可（卷名先在 `docker volume ls` 里确认，通常形如 `<项目名>_qq-agent-data`）：

```bash
docker compose down
docker run --rm --user root -v qq-agent_qq-agent-data:/data qq-agent:local chown -R 1000:1000 /data
docker compose up -d
```

> 全新部署不会再遇到这个问题：Dockerfile 里已经改成先 `mkdir`/`chown`、后声明 `VOLUME`。

**万一具名卷的属主怎么都改不动**（见过这种情况：宿主机上 `ls -ld` 已经是 `1000:1000`，容器里看还是 `root:root`，
怎么 chown 都不生效，多半和宿主机把 Docker 数据目录挪到非默认位置有关），别跟它纠缠，直接把数据换成项目目录下的 bind mount：

```bash
mkdir -p ./data && chown -R 1000:1000 ./data
sed -i 's|- qq-agent-data:/data|- ./data:/data|' docker-compose.yml
docker compose up -d
```

`./data` 是宿主机上一眼可见的普通目录，属主、备份、排查都直白。换了之后备份命令也简单了：

```bash
tar czf qq-agent-$(date +%F).tar.gz -C ./data .
```

**关掉匿名遥测**：本项目默认会把"调用次数 + token 用量"这类计数上报到作者官网做总览统计（不含 QQ 号/群号/聊天内容）。
不想参与就在 `docker-compose.yml` 的 `environment` 里加上：

```yaml
QQ_AGENT_NO_TELEMETRY: "1"
```

**关掉图片识别 / 表情包**：这两个开关既能省钱也能避险，改完走 `SIGHUP` 热重载，**不用重建镜像**。

| 命令 | 效果 |
|---|---|
| `set-vision off` | 下架 `get_message_images` 和 `get_sticker_image`；模型只看到 `[图片]` 占位符，提示词同步改成"你看不到图，不要编造" |
| `set-vision on` | 恢复看图（前提：当前模型真的支持图片输入） |
| `set-sticker off` | 下架 `send_sticker` / `list_stickers` / `get_sticker_image` / `sticker_note` / `collect_sticker`，提示词不再注入表情目录与表情策略段 —— 机器人再也发不出表情 |
| `set-sticker on --encourage 2` | 重新打开，并设"发表情的积极程度"（0 不鼓励 ~ 3 很积极） |
| `set-sticker --collect off` | 保留发表情，但禁止用 `collect_sticker` 收藏别人发的图 |

> 说明：开关是"下架工具 + 改写提示词"，**不会删除任何历史数据**；关掉时群里发的图在聊天记录里仍然显示为 `[图片]` 占位符。
> 为什么必须在工具层下架：只停用"提示词里的表情目录"并不够 —— 工具还挂在工具表里，模型照样能调用 `send_sticker` 真把表情发出去。

### 6.1 改提示词 / 人设后怎么生效

提示词是**每次会话现场拼**的（人设 + 存档摘要 + 本次新消息），所以改完不用重启容器，让它重读一次配置就行。

人设字段（`persona.roleText` 角色设定、`persona.customRules` 附加规则、`persona.botName`、`memberNotes` 群友备注）都在 `config.json` 里，没有 CLI 命令可改。容器里没有编辑器，直接改宿主机上的那份（如果数据在具名卷里，先 `docker compose cp qq-agent:/data/config.json ./config.json` 拷出来改，再拷回去）：

```bash
cd ~/qq-agent
cp data/config.json data/config.json.bak     # 先备份：JSON 写坏了程序会静默回落到默认配置
vi data/config.json                          # 或用你顺手的编辑器
docker compose exec qq-agent node bin/qq-agent.mjs reload
docker compose logs --tail 5 qq-agent        # 看到「收到 SIGHUP，配置已重新加载」就是生效了
```

- `reload` 只是让主进程重读 `config.json`，不重启容器、不重建镜像。
- **已经开始的会话仍用旧提示词**，下一条消息 / 下一轮才用新的；想立刻切换就在控制台点「唤醒一次」。
- 改**提示词模板本身**（`src/prompt.js` 里的段落文案，比如"当前时间"放在哪一段）属于改代码 —— 那要 `docker compose up -d --build`，`reload` 不管用。
- 用 `set-api` / `set-tier` / `set-vision` 这些 CLI 命令改配置时**不用**手动 `reload`，它们写完会自动发 SIGHUP。

### 6.2 服务器连不上 GitHub？本地打包上传

在开发机上打好包再 `scp` 上去，一样能更新：

```powershell
cd D:\Project\Html
tar -czf qq-agent.tar.gz --exclude=QQ-agent/node_modules --exclude=QQ-agent/.git --exclude=QQ-agent/data --exclude=QQ-agent/.env --exclude=QQ-agent/napcat/QQ --exclude=QQ-agent/napcat/logs --exclude=QQ-agent/*.tgz --exclude=QQ-agent/*.tar.gz QQ-agent
```

```bash
scp qq-agent.tar.gz 你的用户名@服务器IP:~/
cd ~/qq-agent && tar -xzf ~/qq-agent.tar.gz --strip-components=1
docker compose up -d --build
```

> `data/`（API Key、配置、聊天存档）和 `napcat/QQ`（QQ 登录态）**绝不能覆盖** —— 盖上去就是一次"重填配置 + 重新扫码"。上面两条命令已经把它们排除了，手动 `scp` 覆盖时也别忘了排除。

## 7. 排障

| 现象 | 先看这里 |
|---|---|
| 浏览器打不开控制台 | 隧道是不是断了（重开 `ssh -N -L …`）；服务器上 `curl -s localhost:3210/api/status` 通不通 |
| 状态栏一直"OneBot 未连接" | `docker compose ps` 看 napcat 在不在跑；`set-onebot` 地址填对了吗（容器里必须写 `napcat` 这个服务名或 `host.docker.internal`，**不能写 127.0.0.1**） |
| 容器起来就退出 | `docker compose logs qq-agent`：端口被占（`QQ_AGENT_STRICT_PORT=1` 会直接失败）或配置异常 |
| 日志报 `EACCES: permission denied, mkdir '/data/sessions'` | 数据目录属主不对（老镜像把 `VOLUME` 写在 `chown` 前面导致的）。改属主的命令见「6. 日常运维」；个别云主机上具名卷改不动，同一节里有换 bind mount 的办法 |
| 模型 401 | `set-api --key` 时是否清掉了旧"目录提供商"；用 `test-api` 自检 |
| 机器人不回复 | 白名单是不是空的；响应档位是不是 0（只回 @）；群消息里有没有 @ 到它 |
| 改了配置没生效 | CLI 会自动发 SIGHUP。手工改文件的话要自己跑一次 `reload`，日志里会打 `收到 SIGHUP，配置已重新加载` |
| 换 Key / 想彻底重置 | 停容器，删卷里的 `config.json`，重启后重新 `set-api` |
| 消息收得到、但一条也发不出去 | NapCat 的 **HTTP 服务器**没开（动作走 HTTP、事件走 WS），或 `set-onebot --http` 地址不对。先看 `./napcat/config/onebot11*.json` 里 `httpServers` 是不是 `enable: true` |
| 打不开 NapCat 的 WebUI | 隧道转发的应该是 `6099`（控制台是 `8321`）；token 在 `docker compose logs napcat` 里 |
| napcat 反复重启 / 写文件报权限错 | `./napcat/` 的属主和 `NAPCAT_UID`/`NAPCAT_GID` 对不上：`sudo chown -R $(id -u):$(id -g) napcat/`，或把这两个值写进 `.env` 再 `docker compose up -d napcat` |
| 容器一重建就要重新扫码 | ① 登录态目录没挂上 / 被删 / 属主不对，`./napcat/QQ` 是空的；② 上次退出是被 SIGKILL 打断的，会话没写干净 | ① 确认 `./napcat/QQ` 非空（几十 MB，里面有 `nt_qq_*` 之类目录）且属主 = `id -u`/`id -g`（它在 `.gitignore` 里，不会被 git 清掉）；② compose 里 napcat 已给 `stop_grace_period: 30s`，重启用 `docker compose restart napcat`，别用 `down && up` |
| 登录页提示 QQ 版本过低 / 登不上 | 镜像里的 QQ 或 NapCat 太旧：改 `image:` 成一个更新的版本 tag，再 `docker compose up -d napcat`（别用 `latest`，出事时说不清版本） |
| 服务器上 `docker build` 卡在 npm | 用 `--build-arg NPM_REGISTRY=https://registry.npmmirror.com`，或本地构建好再 `docker save` / `load` 过去 |

### 7.1 真机踩坑记录（按遇到顺序）

这套东西是在真机上踩着下面这些坑跑起来的，按遇到顺序记在这儿，省得下一个人重复一遍：

| 现象 | 原因 | 处置 |
|---|---|---|
| `docker compose up -d --build` 卡在 Step 1，报 `registry-1.docker.io ... request canceled` | 服务器连不上 Docker Hub，拉不到基础镜像 `node:22-bookworm-slim`（**跟 npm 无关**） | 给 Docker 配 `registry-mirrors`；或在 `.env` 里加 `NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim`（npm 源同理，可设 `NPM_REGISTRY`） |
| `docker compose up -d napcat` 报 `pull access denied` / `not found` | 镜像是手动传上去的，还没进本地镜像库 | 先 `docker load -i napcat.tar`；标签要和 compose 里的 `image:` 完全一致，别用 `latest` |
| 容器起来后，挂载目录里没有预置的 `onebot11.json` | 打包上传时把整个 `napcat/` 排除了（里面有几 MB～几百 MB 的登录态），预置配置被连带排掉；或者这份文件还没进 git | 把仓库里的 `napcat/config/onebot11.json` 传上去，再 `docker compose restart napcat` |
| 崩溃日志 `EACCES: permission denied, mkdir '/data/sessions'` | 老版 Dockerfile 把 `VOLUME ["/data"]` 写在 `chown` **之前** —— Docker 会丢弃 `VOLUME` 之后对该目录的改动，新建的卷属主是 root，而进程跑在 uid 1000 | 已修（先 `mkdir`/`chown`，后 `VOLUME`）。存量卷：`docker compose run --rm --no-deps --user 0 --entrypoint chown qq-agent -R 1000:1000 /data` |
| 宿主机上卷目录已经是 `1000:1000`，容器里看还是 `root:root`，怎么 chown 都不生效 | 个别云主机上的怪现象（Docker 数据目录被挪到了 `/opt/docker/docker` 这类非默认位置） | 别跟它纠缠，换成 bind mount：`mkdir -p ./data && chown -R 1000:1000 ./data`，compose 里把 `- qq-agent-data:/data` 改成 `- ./data:/data` |
| 用 `docker run -v 卷名:/data …` 改属主，看着成功了但没效果 | 卷名写错时 Docker 会**静默新建**一个空卷，chown 改到了那个新卷上 | 改属主一律用 `docker compose run …`，让 compose 自己解析卷名 |
| `--user node` 起的进程写不进 `/data` | `--user <用户名>` 不保证解析成 1000，两边的 passwd 不是同一份 | 调试时用数字（`--user 1000`）；正式运行靠镜像里的 `USER node` 就够了 |
| 群里收得到消息，机器人一条也发不出去 | NapCat 只开了 WebSocket —— 而**所有动作（含发消息）走的是 HTTP API** | `httpServers`（3000）和 `websocketServers`（3001）都要 `enable: true`；生成后实际生效的是 `onebot11_<QQ号>.json` |
| NapCat 日志每 2 分钟刷一次二维码，夹杂 `ErrType:1 ErrCode:3` | 还没扫码登录；刷码只是正常的重新生成节流，不是故障 | 隧道到 `6099` 打开 WebUI 扫码；token 在 `napcat/config/webui.json` 的 `token` 字段，napcat 的启动日志里也有 |
| `docker compose exec napcat cat /app/napcat/config/onebot11*.json` 报 `No such file` | `*` 被转义成了字面量 | 写完整文件名，登录后生效的那份带 QQ 号 |
| 构建时 `WARN buildx Docker CLI plugin not found` | 没装 buildx 插件 | 可以忽略（经典构建器一样支持多阶段构建）；想消掉就装 `docker-buildx-plugin` |
| 删掉项目目录重新解压后，`show` 里 Base URL / API Key / 白名单全空，群里也不回话 | `data/` 就挂在项目目录里（bind mount），删目录时配置和存档一起没了 | 重装前先备份 `data/`、`napcat/`、`.env`；已经丢了就重新 `set-api` / `set-allow` / `set-onebot`（见 6.2） |
| 重装后 NapCat 的 WebUI 登不上（token 不对） | `napcat/config/webui.json` 是重新生成的，token 换了，浏览器里还存着旧的 | 无痕窗口重开，或从配置里查：`grep -o '"token"[^,]*' napcat/config/webui.json`（`docker compose logs napcat` 里也有）。**不修 WebUI 也能登录**：日志里 `txz.qq.com/p?k=…` 那一行用手机 QQ 打开即可 |
| 重建镜像时又卡在连 Docker Hub | `.env` 也在项目目录里，跟着被删了 | 重建 `.env`：`NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim`、`NPM_REGISTRY=https://registry.npmmirror.com` |
| 机器人连不上协议端，`show` 里 OneBot WS 是 `ws://127.0.0.1:3001` | 配置被重置成默认值；容器里的 `127.0.0.1` 指的是**它自己** | `docker compose exec qq-agent node bin/qq-agent.mjs set-onebot --ws ws://napcat:3001 --http http://napcat:3000`（同一个 compose 里要用服务名） |
| `docker compose ps` 里 `qq-agent` 的 PORTS 列是空的 | 容器在 `Restarting` 循环（构建失败 / 启动报错），根本没进到监听状态 | 先看 `docker compose logs --tail 40 qq-agent`，别急着怀疑端口映射；正常时应显示 `127.0.0.1:3210->3210/tcp` |
| 重建之后 `exec` 进去敲命令还是旧的（`未知命令：set-sticker`） | `docker compose exec` 跑的是**镜像里**的文件，解压源码不等于更新镜像 | 改完源码一定 `docker compose up -d --build`；只改配置则不用，`SIGHUP` 热重载就够了 |
| 改了 `config.json` 里的人设，群里还是老口气 | 手工改文件不会自动重载；另外已经开始的那一轮用的还是旧提示词 | `docker compose exec qq-agent node bin/qq-agent.mjs reload`（见「改提示词 / 人设后怎么生效」） |
| NapCat 跑久了收不到新消息（连接还在，日志里只剩 `ServerTime` 对时，没有任何 `接收 <-` 行） | NTQQ 长连的已知毛病：会话假死，QQ 服务端不再推消息。qq-agent 这边看不出来（WS 还连着，状态仍是 connected），它只负责被动接收 | `docker compose restart napcat` 就能恢复；反复出现就定时重启，例如 cron：`0 5 * * * cd /root/qq-agent && docker compose restart napcat >> /var/log/napcat-restart.log 2>&1` |
| 重启 NapCat 后必须重新扫码 | 两种原因得分清：① 登录态压根没落盘（`./napcat/QQ` 是空的或属主不对）；② 会话已被服务端判废（目录里明明有几十 MB 数据，重启后日志里却直接出二维码） | ① 按「7. 排障」里那条修挂载与属主；② 只能重扫 —— 顺手把 `stop_grace_period` 留够（compose 里已给 30s），别让 SIGKILL 打断 QQ 收尾 |

四条事后经验：

1. **先确认"容器起没起来、挂载对不对、权限够不够"，再谈机器人逻辑** —— 上面的时间大半花在这三件事上，而不是在代码里。
2. **配置永远走 CLI**：`docker compose exec qq-agent node bin/qq-agent.mjs …`，改完自动 `SIGHUP` 热重载，不用重启容器。
3. **登录态和数据目录都是不可再生的**：`napcat/QQ`、`data/` 定期备份；`docker compose down -v`、`docker volume rm` 这类命令想清楚再敲。
4. **"重装"是要付代价的**：`data/`（配置 + 存档）、`napcat/`（登录态）、`.env`（镜像站配置）全在项目目录里，删目录 = 全丢；日常更新代码只需要 `docker compose up -d --build`。

## 8. 环境变量一览

| 变量 | 默认 | 说明 |
|---|---|---|
| `QQ_AGENT_DATA_DIR` | `<项目>/data` | 数据目录（容器里是 `/data`） |
| `QQ_AGENT_HOST` | `127.0.0.1` | 控制台监听地址；非回环地址且无令牌时会拒绝启动 |
| `QQ_AGENT_PORT` | 配置里的 `3210` | 控制台端口 |
| `QQ_AGENT_STRICT_PORT` | 关 | `1` = 端口被占直接报错，不自动往后找 |
| `QQ_AGENT_TOKEN` | 空 | 控制台访问令牌；只在需要暴露端口时用 |
| `QQ_AGENT_READONLY` | 关 | `1` = 控制台只读（服务器部署就靠它） |
| `QQ_AGENT_ALLOW_OPEN_BIND` | 关 | `1` = 放行"无令牌 + 非回环监听"（必须配合端口只发布到 127.0.0.1） |
| `QQ_AGENT_WS_HEARTBEAT` | 开 | `0` = 关掉 OneBot 连接的心跳探测 |
| `QQ_AGENT_NO_TELEMETRY` | 关 | `1` = 关闭匿名用量上报 |
| `TZ` | 容器默认 UTC | 日志与"今日用量"的时区，建议 `Asia/Shanghai` |

## 9. 和桌面版的差异

- 没有 Electron 壳：托盘、开机自启、窗口管理这些都不存在，取而代之的是 Docker 的 `restart` 策略。
- 服务器上不要再装 SnowLuma：Windows 桌面端的内置协议端启动逻辑不属于跨平台路径，服务器部署统一用 NapCat。
- "打开目录 / 打开 WebUI" 这类按钮在没有桌面环境的机器上会返回一句人话错误（而不是静默失败）。
- `bin/qq-agent.mjs reload` 靠扫 `/proc` 找主进程，所以只在 Linux 容器里有效；在 Windows 开发机上跑会提示手动重启。
