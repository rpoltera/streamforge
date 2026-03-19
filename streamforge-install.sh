#!/usr/bin/env bash
set -euo pipefail

APP="StreamForge"
HOSTNAME="streamforge"
PORT=8000
CORES=2
MEMORY=2048
SWAP=512
DISK=10

echo "=== ${APP} LXC Deploy ==="

# Must be run on Proxmox host
command -v pct >/dev/null || { echo "Run this on Proxmox host"; exit 1; }

# Auto-detect CTID + bridge
CTID=$(pvesh get /cluster/nextid)
BRIDGE=$(ip -o link show | awk -F': ' '{print $2}' | grep '^vmbr' | head -n1)

# Find storage that supports templates (vztmpl)
TEMPLATE_STORAGE=$(pvesm status | awk '$0 ~ /vztmpl/ {print $1; exit}')

# Fallback if detection fails
if [[ -z "$TEMPLATE_STORAGE" ]]; then
  TEMPLATE_STORAGE="local"
fi

# Rootfs storage (first active)
ROOTFS_STORAGE=$(pvesm status | awk '$3=="active" {print $1; exit}')

echo "CTID: $CTID"
echo "Bridge: $BRIDGE"
echo "Template storage: $TEMPLATE_STORAGE"
echo "Rootfs storage: $ROOTFS_STORAGE"

# Update templates
pveam update >/dev/null

# Force known-good template name (no dynamic failure)
TEMPLATE="debian-12-standard_12.2-1_amd64.tar.zst"

# Download if missing
if ! pveam list $TEMPLATE_STORAGE | grep -q $TEMPLATE; then
  echo "Downloading template..."
  pveam download $TEMPLATE_STORAGE $TEMPLATE
fi

echo "Creating LXC..."

pct create $CTID ${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE} \
  --hostname $HOSTNAME \
  --cores $CORES \
  --memory $MEMORY \
  --swap $SWAP \
  --net0 name=eth0,bridge=$BRIDGE,ip=dhcp \
  --rootfs ${ROOTFS_STORAGE}:${DISK} \
  --features nesting=1 \
  --unprivileged 0

pct start $CTID
sleep 8

echo "Installing StreamForge..."

pct exec $CTID -- bash -c "
set -e
apt update -y
apt install -y python3 python3-venv python3-pip curl

mkdir -p /opt/streamforge/backend
mkdir -p /opt/streamforge/frontend/dist

cat > /opt/streamforge/backend/main.py << 'EOF'
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

cd /opt/streamforge/backend
python3 -m venv .venv
source .venv/bin/activate
pip install fastapi uvicorn
deactivate

cat > /opt/streamforge/frontend/dist/index.html << 'EOF'
<!DOCTYPE html>
<html>
<body style='background:#111;color:white;font-family:sans-serif'>
<h1>StreamForge Running</h1>
<a href='/api/health'>Check API</a>
</body>
</html>
EOF

cat > /etc/systemd/system/streamforge.service << EOF
[Unit]
Description=StreamForge
After=network.target

[Service]
WorkingDirectory=/opt/streamforge/backend
ExecStart=/opt/streamforge/backend/.venv/bin/uvicorn main:app --host 0.0.0.0 --port $PORT
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
echo "StreamForge READY"
echo "http://$IP:$PORT"
echo "=============================="
