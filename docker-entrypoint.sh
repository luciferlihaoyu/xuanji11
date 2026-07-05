#!/bin/sh
set -e

echo "=== 璇玑智脑 启动中 ==="

# 同步数据库表结构（不删除已有表）
echo "[Entry] 同步数据库表结构..."

# 等待数据库就绪，最多重试 30 次（每次 2 秒）
attempt=0
max_attempts=30
while [ $attempt -lt $max_attempts ]; do
  if ./node_modules/.bin/drizzle-kit push --force; then
    echo "[Entry] 数据库同步成功"
    break
  fi
  attempt=$((attempt + 1))
  echo "[Entry] 数据库同步失败，第 $attempt/$max_attempts 次重试..."
  sleep 2
done

if [ $attempt -eq $max_attempts ]; then
  echo "[Entry] 数据库同步最终失败，服务可能无法正常工作"
fi

# 启动服务
echo "[Entry] 启动服务..."
exec node dist/boot.js
