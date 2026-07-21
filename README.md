# 璀璨宝石 · 宝可梦（Pokémon Splendor）

一款服务端权威、支持 2–4 人联机与本地对战的《璀璨宝石：宝可梦》网页版。玩家领取精灵球、捕捉及进化宝可梦，率先达到目标分数即有机会成为冠军训练家。

支持本地热座、四档电脑对手、房间码联机、断线重连、全员同意悔棋、可选超时 AI 接管、超级进化、Pokémart、新手教程、PWA 与本地续局。

## 本地开发

要求：

- Node.js 24.18.0 或更高的 24.x LTS
- pnpm 11.15.1（仓库锁定此版本）
- uv 0.11.30（仅训练工具需要）

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

打开 <http://localhost:5173>。WebSocket 服务默认监听 `http://localhost:3000`，Vite 开发服务器会代理 `/api`、`/room`、`/healthz` 与 `/readyz`。

常用命令：

```bash
pnpm check          # 格式、Lint、类型、测试、Python 检查与生产构建
pnpm typecheck      # TypeScript 项目引用增量检查
pnpm test           # Vitest
pnpm test:coverage  # 测试及覆盖率门禁
pnpm build          # 构建全部 workspace
pnpm python:sync    # 用 uv 同步训练工具环境
```

## 在线联机

主页先选择「联机房间」或「单机房间」。创建联机房间后分享房间码或邀请链接，房主等待玩家入座后开始游戏。

- 服务端校验所有动作，并仅向玩家下发其有权查看的状态。
- 房间身份保存在当前浏览器标签页的 `sessionStorage`；刷新可恢复座位，同时两个标签页可作为两名独立玩家加入。
- 超时 AI 接管默认关闭，可由房主在创建/开始房间时启用并设置时间。
- 房间快照原子写入磁盘，重启应用容器后仍可恢复。

## 项目结构

```text
apps/
  web/              Vite 8 浏览器应用与静态资源
  server/           Node.js 权威房间服务器
packages/
  game-core/        纯 TypeScript 游戏规则、AI 与房间领域逻辑
  game-data/        卡牌数据及启动时结构校验
  protocol/         客户端/服务端消息类型与运行时边界校验
tools/
  training/         uv 管理的 Python 研究与训练工具
deploy/             Caddy、备份脚本与 systemd timer
```

前端继续使用原生 DOM 与 CSS；共享逻辑通过 workspace package 复用，不依赖浏览器全局变量。生产 TypeScript 开启 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 等严格选项，网络和持久化数据在不可信边界执行运行时校验。

## 玩法概要

- 五种普通精灵球与万能的大师球。
- 每回合可领取精灵球、捕捉宝可梦或预留卡牌。
- 已捕捉宝可梦提供永久折扣；满足条件时可在回合结束进化。
- 默认精灵球上限为 10；基础模式达到 18 分后在轮末结算。
- 可选扩展包括超级进化与 Pokémart。

## 部署

项目提供两个最小生产镜像：Node.js 应用与 Caddy 静态站点/反向代理。可以只使用阿里云公网 IP，也可以配置域名并由 Caddy 自动启用 HTTPS。

```bash
cp .env.example .env
# 按 docs/DEPLOY_ALIYUN.md 填写公网 IP 或域名
docker compose up -d --build
```

详见 [阿里云部署指南](docs/DEPLOY_ALIYUN.md) 与 [运维手册](docs/OPERATIONS.md)。

## 致谢与版权

桌游《Splendor / 璀璨宝石》由 Marc André 设计。卡牌美术与数值源自 TTS 社区模组「璀璨宝石：宝可梦」。宝可梦相关名称与形象版权归 Nintendo、Game Freak 与 The Pokémon Company 所有；本项目为非商业同人学习用途。
