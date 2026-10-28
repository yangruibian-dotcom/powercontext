#!/usr/bin/env bash
# 启动 seekdb 容器（记忆酒馆的"账本"）
set -e
docker rm -f seekdb >/dev/null 2>&1 || true
docker run -d --name seekdb -p 2881:2881 -p 2886:2886 oceanbase/seekdb:latest
echo "waiting for seekdb ..."
for i in $(seq 1 40); do
  if docker exec seekdb obclient -h127.0.0.1 -P2881 -uroot@sys -e "select 1" >/dev/null 2>&1; then
    echo "ready after $((i*3))s"
    exit 0
  fi
  sleep 3
done
echo "seekdb did not become ready, check: docker logs seekdb"
exit 1
