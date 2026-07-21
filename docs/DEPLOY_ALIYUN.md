# 部署到阿里云

部署由两个容器组成：Caddy 对外提供页面并代理 WebSocket，Node.js 保存服务端权威房间状态。Node.js 端口不会映射到宿主机。

## 前置条件

- 阿里云 ECS 已安装 Docker Engine 与 Docker Compose v2。
- 使用公网 IP 时放行 TCP 80；使用域名 HTTPS 时再放行 TCP 443 与 UDP 443。
- 对外端口未被其他服务占用。

## 首次部署

```bash
git clone https://github.com/yaindrop/pokemon-splendor.git /opt/pokemon-splendor
cd /opt/pokemon-splendor
git switch feat/aliyun-multiplayer
cp .env.example .env
```

### 仅使用公网 IP

将 `<SERVER_IP>` 替换为 ECS 公网 IP：

```dotenv
SITE_ADDRESS=:80
PUBLIC_ORIGIN=http://<SERVER_IP>
```

此模式访问 `http://<SERVER_IP>`，不自动申请证书。`PUBLIC_ORIGIN` 必须与浏览器地址栏的来源完全一致，不要带末尾斜杠。

### 使用域名与 HTTPS

先把域名 A/AAAA 记录解析到服务器，再配置：

```dotenv
SITE_ADDRESS=game.example.com
PUBLIC_ORIGIN=https://game.example.com
```

Caddy 会自动申请和续期证书。

### 启动与验证

```bash
install -d -o 1000 -g 1000 -m 700 runtime/rooms
docker compose up -d --build
docker compose ps
curl -fsS "${PUBLIC_ORIGIN}/healthz"
```

安装每日房间快照备份：

```bash
install -m 644 deploy/pokemon-splendor-backup.service /etc/systemd/system/
install -m 644 deploy/pokemon-splendor-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pokemon-splendor-backup.timer
```

房间快照位于 `runtime/rooms`，应只允许部署用户读写。

## 更新与回滚

```bash
/opt/pokemon-splendor/deploy/backup.sh
cd /opt/pokemon-splendor
git fetch origin
git switch feat/aliyun-multiplayer
git pull --ff-only
docker compose up -d --build
```

回滚时切回上一个已验证提交并重新构建。不要删除 `runtime/rooms`；房间快照结构发生不兼容变更时必须先提供迁移逻辑。

## 验收清单

1. `docker compose ps` 中 `app` 与 `web` 均为 `healthy`。
2. `${PUBLIC_ORIGIN}/healthz` 返回 `{"ok":true}`。
3. 两个浏览器标签页或无痕窗口能分别加入同一房间并开始游戏。
4. 刷新后恢复原座位；重启 `app` 容器后对局仍在。
5. 域名模式使用 `wss://`，IP 模式使用 `ws://`。
6. 对手看不到你的预留牌身份或牌堆顺序。
