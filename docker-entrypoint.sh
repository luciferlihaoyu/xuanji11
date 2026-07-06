#!/bin/sh
set -e

echo "=== 璇玑智脑 启动中 ==="

# 修复 backup_jobs 缺失的列（幂等）
echo "[Entry] 修复 backup_jobs 表结构..."
node scripts/migrate-backup-jobs.mjs || echo "[Entry] backup_jobs 修复脚本失败，继续启动..."

# 启动服务
echo "[Entry] 启动服务..."
exec node dist/boot.js
