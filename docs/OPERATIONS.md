# 运维手册

## 日常检查

```bash
docker compose ps
docker compose logs --tail=100 app web
docker stats --no-stream
du -sh runtime/rooms
```

应用日志由 Docker `local` 驱动轮转。房间在 7 天无更新后自动删除。

## 备份

房间存储采用临时文件写入后原子重命名，同一时刻复制目录不会读到半写入 JSON。部署包含每日 systemd timer；手工执行同一备份脚本：

```bash
/opt/pokemon-splendor/deploy/backup.sh
systemctl list-timers pokemon-splendor-backup.timer
```

恢复前停止 `app` 容器，解压备份，再启动并检查 `/readyz`。

## 故障处理

- 无法建房：检查 `app` 日志、数据目录权限和磁盘空间。
- 页面正常但无法联机：确认 Caddy 对 `/api/*`、`/room/*` 的反代及安全组 443。
- 证书失败：确认域名 A/AAAA 记录、80/443 入站连通，检查 Caddy 日志。
- 对局断线：浏览器会指数退避重连；不要删除 `localStorage` 中对应房间 token。
- 紧急停服：`docker compose down`。不要加 `-v`，否则会同时移除 Caddy 证书数据卷。
