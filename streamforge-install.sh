#!/usr/bin/env bash
source <(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/misc/build.func)

# Copyright (c) 2026
# License: MIT

APP="StreamForge"
var_tags="${var_tags:-iptv;media}"
var_cpu="${var_cpu:-2}"
var_ram="${var_ram:-2048}"
var_disk="${var_disk:-10}"
var_os="${var_os:-debian}"
var_version="${var_version:-12}"
var_unprivileged="${var_unprivileged:-1}"

header_info "$APP"
variables
color
catch_errors

install_streamforge() {
  lxc-attach -n "$CTID" -- bash <<'EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "=== Installing StreamForge inside LXC ==="

apt update -y
apt install -y curl git python3 python3-venv python3-pip

mkdir -p /opt/streamforge/backend
mkdir -p /opt/streamforge/frontend/dist

cat > /opt/streamforge/backend/main.py <<'PYEOF'
from fastapi import FastAPI
from fastapi.responses import FileResponse
from pathlib import Path

app = FastAPI()
FRONTEND = Path("/opt/streamforge/frontend/dist")

@app.get("/api/health")
def health():
    return {"status": "ok"}

@app.get("/{path:path}")
def serve(path: str):
    index = FRONTEND / "index.html"
    if index.exists():
        return FileResponse(index)
    return {"error": "frontend missing"}
PYEOF

cd /opt/streamforge/backend
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install fastapi uvicorn
deactivate

cat > /opt/streamforge/frontend/dist/index.html <<'HTMLEOF'
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>StreamForge</title>
</head>
<body style="background:#111;color:#fff;font-family:sans-serif;padding:24px;">
  <h1>StreamForge Running</h1>
  <p><a href="/api/health" style="color:#7dd3fc;">Check API</a></p>
</body>
</html>
HTMLEOF

cat > /etc/systemd/system/streamforge.service <<'SVCEOF'
[Unit]
Description=StreamForge
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/streamforge/backend
ExecStart=/opt/streamforge/backend/.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable streamforge
systemctl restart streamforge

echo "=== StreamForge install complete ==="
EOF
}

start
build_container
install_streamforge

IP="$(pct exec "$CTID" -- hostname -I | awk '{print $1}')"

msg_ok "Completed successfully!"
echo -e "${INFO}${YW}Container ID:${CL} ${BGN}${CTID}${CL}"
echo -e "${INFO}${YW}Access URL:${CL} ${BGN}http://${IP}:8000${CL}"
