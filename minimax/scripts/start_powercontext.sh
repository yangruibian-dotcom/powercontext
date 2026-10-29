#!/usr/bin/env bash
# 启动 PowerContext 服务（任务状态）
set -e
export POWERCONTEXT_HOME="${POWERCONTEXT_HOME:-$(pwd)/.powercontext}"
export POWERCONTEXT_SERVER_HTTP_HOST=127.0.0.1
export POWERCONTEXT_SERVER_HTTP_PORT="${POWERCONTEXT_SERVER_HTTP_PORT:-8000}"
export POWERCONTEXT_SERVER_MCP_ENABLED=false
mkdir -p "$POWERCONTEXT_HOME"
echo "PowerContext 数据目录: $POWERCONTEXT_HOME"
powercontext server run
