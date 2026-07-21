#!/bin/sh
set -eu

APP_DIR=${APP_DIR:-/opt/pokemon-splendor}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/pokemon-splendor}
KEEP_DAYS=${KEEP_DAYS:-7}

install -d -m 700 "$BACKUP_DIR"
archive="$BACKUP_DIR/rooms-$(date +%Y%m%d-%H%M%S).tgz"
tar -C "$APP_DIR" -czf "$archive" runtime/rooms
find "$BACKUP_DIR" -type f -name 'rooms-*.tgz' -mtime "+$KEEP_DAYS" -delete
