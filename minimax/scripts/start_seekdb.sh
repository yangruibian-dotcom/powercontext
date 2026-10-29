#!/usr/bin/env bash
# 启动 seekdb（工程资料库）
set -e
docker rm -f seekdb >/dev/null 2>&1 || true
docker run -d --name seekdb -p 2881:2881 oceanbase/seekdb:latest
for i in $(seq 1 60); do
  if docker exec seekdb bash -c 'echo ok' >/dev/null 2>&1; then
    sleep 2; echo "seekdb 已启动（端口 2881）"; exit 0
  fi
  sleep 2
done
echo "seekdb 启动超时，检查 docker logs seekdb"; exit 1
