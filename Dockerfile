# QQ Agent —— 容器化运行（headless 控制台 · 只读监控）
#
#   docker compose up -d          # 推荐，见 docker-compose.yml
#   docker build -t qq-agent .
#   docker run -d --name qq-agent -p 127.0.0.1:3210:3210 -v qq-agent-data:/data qq-agent
#
# 服务器上不需要 Electron 桌面壳，所以只装生产依赖：镜像小很多，构建也快。

# 基础镜像可以整段替换（国内直连 Docker Hub 常超时）：把下面这行改成镜像站地址，
# 或构建时 --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim，
# 也可以写进 .env：NODE_IMAGE=...
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# 服务器上访问官方 npm 源慢/不通时，构建时换源：
#   docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com -t qq-agent:local .
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm ci --omit=dev --no-audit --no-fund --registry=$NPM_REGISTRY

FROM ${NODE_IMAGE}

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    QQ_AGENT_DATA_DIR=/data \
    QQ_AGENT_HOST=0.0.0.0 \
    QQ_AGENT_PORT=3210 \
    QQ_AGENT_STRICT_PORT=1 \
    QQ_AGENT_READONLY=1 \
    QQ_AGENT_ALLOW_OPEN_BIND=1

# 上面两个"看起来危险"的开关，前提是**端口只发布到宿主机 127.0.0.1**：
#   QQ_AGENT_HOST=0.0.0.0      容器内不监听所有地址，端口映射就出不来。
#                              它会触发"非本机监听必须有令牌"那条保护，
#                              所以配 QQ_AGENT_ALLOW_OPEN_BIND=1 显式放行。
#   QQ_AGENT_READONLY=1        控制台只做监控：明文密钥接口全封死，配置只能走 bin/qq-agent.mjs。
# 发布端口时务必写 -p 127.0.0.1:3210:3210；写成 -p 3210:3210 才是真的暴露到公网。

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 非 root 运行（node 镜像自带 uid 1000 的 node 用户）
# ⚠ 这个 mkdir/chown 必须排在 VOLUME 之前：Docker 会丢弃 VOLUME 声明之后对该目录的改动，
#   顺序反了新建出来的卷就是 root 属主，以 node 身份运行的进程连 /data/sessions 都建不出来。
RUN mkdir -p /data && chown -R node:node /data /app

# 数据目录挂卷：config.json、聊天存档、群友记忆、会话留档全在这里，容器重建不能丢
VOLUME ["/data"]
EXPOSE 3210

USER node

CMD ["node", "src/server.js"]
