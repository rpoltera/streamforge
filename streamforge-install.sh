#!/usr/bin/env bash
set -euo pipefail

CTID=$(pvesh get /cluster/nextid)
HOSTNAME="streamforge"
STORAGE="local-lvm"
TEMPLATE="debian-12-standard_12.2-1_amd64.tar.zst"
DISK="10"
CORES="2"
RAM="2048"
PORT="8000"

echo "=== StreamForge LXC Deploy ==="
echo "Using CTID: $CTID"

# Ensure template exists
pveam update
pveam download local $TEMPLATE || true

# Create LXC
pct create $CTID local:vztmpl/$TEMPLATE \
  --hostname $HOSTNAME \
  --cores $CORES \
  --memory $RAM \
  --rootfs $STORAGE:${DISK} \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --features nesting=1 \
  --unprivileged 0

# Start container
pct start $CTID

echo "Waiting for container to boot..."
sleep 10

# Install inside container
pct exec $CTID -- bash -c "
set -e

echo '=== Installing inside LXC ==='

apt update -y
apt install -y curl git ffmpeg python3 python3-venv python3-pip ca-certificates

curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

INSTALL_DIR=/opt/streamforge

rm -rf \$INSTALL_DIR
mkdir -p \$INSTALL_DIR/backend
mkdir -p \$INSTALL_DIR/frontend/dist

cat > \$INSTALL_DIR/backend/main.py << 'EOF'
from fastapi import FastAPI
from fastapi.responses import FileResponse
from pathlib import Path

app = FastAPI()
FRONTEND = Path('/opt/streamforge/frontend/dist')

@app.get('/api/health')
def health():
    return {'status': 'ok'}

@app.get('/{path:path}')
def serve(path: str):
    index = FRONTEND / 'index.html'
    if index.exists():
        return FileResponse(index)
    return {'error': 'frontend missing'}
EOF

cd \$INSTALL_DIR/backend
python3 -m venv .venv
source .venv/bin/activate
pip install fastapi uvicorn
deactivate

cat > \$INSTALL_DIR/frontend/dist/index.html << 'EOF'
<!DOCTYPE html>
<html>
<body style=\"background:#111;color:white;font-family:sans-serif\">
<h1>StreamForge Running</h1>
<a href=\"/api/health\">Check API</a>
</body>
</html>
EOF

cat > /etc/systemd/system/streamforge.service << EOF
[Unit]
Description=StreamForge
After=network.target

[Service]
WorkingDirectory=\$INSTALL_DIR/backend
ExecStart=\$INSTALL_DIR/backend/.venv/bin/uvicorn main:app --host 0.0.0.0 --port $PORT
Restart=always

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable streamforge
systemctl restart streamforge
"

IP=$(pct exec $CTID -- hostname -I | awk '{print $1}')

echo ""
echo "=============================="
echo "Container ID: $CTID"
echo "Access URL: http://$IP:$PORT"
echo "=============================="
