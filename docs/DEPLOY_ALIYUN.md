# 部署到阿里云

## 前置条件

- 一个解析到服务器公网 IP 的域名或子域名。
- 阿里云安全组放行 TCP 80、TCP 443 和 UDP 443。
- Docker Engine 与 Docker Compose v2。
- 服务器的 80/443 端口没有被其他进程占用。

## 首次部署

```bash
git clone https://github.com/yaindrop/pokemon-splendor.git /opt/pokemon-splendor
cd /opt/pokemon-splendor
git switch feat/aliyun-multiplayer
cp .env.example .env
```

编辑 `.env`：

```dotenv
SITE_ADDRESS=game.example.com
PUBLIC_ORIGIN=https://game.example.com
```

启动：

```bash
install -d -o 1000 -g 1000 -m 700 runtime/rooms
docker compose up -d --build
docker compose ps
curl -fsS https://game.example.com/healthz
```

安装每日备份定时器：

```bash
install -m 644 deploy/pokemon-splendor-backup.service /etc/systemd/system/
install -m 644 deploy/pokemon-splendor-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pokemon-splendor-backup.timer
```

Node.js 端口不映射到宿主机；所有 HTTP 和 WebSocket 流量都由 Caddy 进入。房间快照位于 `runtime/rooms`，权限应保持为仅部署用户可读写。

## 更新与回滚

更新前先备份房间：

```bash
tar -C /opt/pokemon-splendor -czf /opt/pokemon-splendor-rooms-$(date +%Y%m%d-%H%M%S).tgz runtime/rooms
git fetch origin
git switch feat/aliyun-multiplayer
git pull --ff-only
docker compose up -d --build
```

回滚时切回上一个已验证提交，再重新构建。房间快照带版本字段；不兼容的结构变更必须先提供迁移逻辑。

## 验收

1. `docker compose ps` 中两个容器均为 healthy。
2. `/healthz` 返回 `{"ok":true}`。
3. 两个无痕窗口可以创建房间、加入并开始游戏。
4. 刷新后恢复原座位；重启 `app` 容器后对局仍在。
5. 浏览器开发者工具中 WebSocket 使用 `wss://`，对手看不到预留牌身份和牌堆顺序。
