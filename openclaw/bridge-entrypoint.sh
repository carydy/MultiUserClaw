#!/bin/bash
set -e

# Create necessary directories
mkdir -p ~/.openclaw/workspace
mkdir -p ~/.openclaw/uploads
mkdir -p ~/.openclaw/sessions

# If NANOBOT_PROXY__URL is set, we're running in platform mode
if [ -n "$NANOBOT_PROXY__URL" ]; then
  echo "[entrypoint] Platform mode detected"
  echo "[entrypoint] Proxy URL: $NANOBOT_PROXY__URL"
  echo "[entrypoint] Model: $NANOBOT_AGENTS__DEFAULTS__MODEL"
fi

exec "$@"
