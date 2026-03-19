#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="/opt/streamforge"
PORT="8000"

echo "=== StreamForge Install ==="

apt update -y
apt install -y curl git ffmpeg python3 python3-venv python3-pip ca-certificates

# NODE 20 (required)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

node -v

# CLEAN INSTALL
rm -rf $INSTALL_DIR
mkdir -p $INSTALL_DIR/backend
mkdir -p $INSTALL_DIR/frontend/dist

# ------------------------
# BACKEND
# ------------------------
cat > $INSTALL_DIR/backend/main.py <<'EOF'
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
EOF

cd $INSTALL_DIR/backend
python3 -m venv .venv
source .venv/bin/activate
pip install fastapi uvicorn
deactivate

# ------------------------
# FRONTEND (STATIC — NO VITE)
# ------------------------
cat > $INSTALL_DIR/frontend/dist/index.html <<'EOF'
<!DOCTYPE html>
<html>
<head>
  <title>StreamForge</title>
</head>
<body style="background:#0f1117;color:white;font-family:sans-serif">
  <h1>StreamForge Running</h1>
  <p><a href="/api/health">Check API</a></p>
</body>
</html>
EOF

# ------------------------
# SERVICE
# ------------------------
cat > /etc/systemd/system/streamforge.service <<EOF
[Unit]
Description=StreamForge
After=network.target

[Service]
WorkingDirectory=$INSTALL_DIR/backend
ExecStart=$INSTALL_DIR/backend/.venv/bin/uvicorn main:app --host 0.0.0.0 --port $PORT
Restart=always

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable streamforge
systemctl restart streamforge

IP=$(hostname -I | awk '{print $1}')

echo "DONE"
echo "http://$IP:$PORT"
