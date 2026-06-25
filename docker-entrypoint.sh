#!/bin/sh
set -e

echo "=== 鐠囩帒鏅鸿剳 鍚姩涓?==="

# 鍚屾鏁版嵁搴撹〃缁撴瀯锛堜笉鍒犻櫎宸叉湁琛級
echo "[Entry] 鍚屾鏁版嵁搴撹〃缁撴瀯..."
npx drizzle-kit push --force 2>/dev/null || echo "[Entry] 鏁版嵁搴撳悓姝ヨ烦杩囷紙鍙兘DB鏈氨缁級"

# 鍚姩鏈嶅姟
echo "[Entry] 鍚姩鏈嶅姟..."
exec node dist/boot.js
