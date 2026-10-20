#!/usr/bin/env bash
# Runs only in the existing synthetic demo Codespace. Never prints its environment or secrets.
set -euo pipefail
cd /workspaces/teleemon-emedicine
export CODESPACES=true
export CODESPACE_NAME=teleemon-synthetic-client-demo-5vxj76x9pjrhvp6v
export NVM_DIR=/usr/local/share/nvm
if [ -f "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use 22.23.3 >/dev/null
fi
if ! curl --fail --silent --max-time 5 http://127.0.0.1:3400/healthz >/dev/null; then
  if ! pgrep -f '^node render/codespaces/start.mjs$' >/dev/null; then
    mkdir -p "$HOME/.teleemon-codespaces/logs"
    nohup node render/codespaces/start.mjs > "$HOME/.teleemon-codespaces/logs/recovery.log" 2>&1 < /dev/null &
  fi
fi
for attempt in $(seq 1 48); do
  if curl --fail --silent --max-time 5 http://127.0.0.1:3400/healthz >/dev/null &&
     curl --fail --silent --max-time 5 http://127.0.0.1:8103/healthcheck >/dev/null; then
    node render/codespaces/ensure-monitor.mjs
    echo 'Existing demo backend is healthy.'
    exit 0
  fi
  sleep 5
done
echo 'Demo backend did not become ready; inspect its private service logs.' >&2
exit 1
