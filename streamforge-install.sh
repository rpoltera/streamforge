#!/usr/bin/env bash
set -euo pipefail

APP="StreamForge"
HOSTNAME="streamforge"
DISK_GB="10"
CORES="2"
RAM_MB="2048"
PORT="8000"

echo "=== ${APP} Proxmox LXC Deploy ==="

# -----------------------------
# Sanity checks
# -----------------------------
if [[ $EUID -ne 0 ]]; then
  echo "Run as root on the Proxmox host."
  exit 1
fi

command -v pct >/dev/null 2>&1 || { echo "pct not found. Run this on a Proxmox host."; exit 1; }
command -v pvesh >/dev/null 2>&1 || { echo "pvesh not found. Run this on a Proxmox host."; exit 1; }
command -v pveam >/dev/null 2>&1 || { echo "pveam not found. Run this on a Proxmox host."; exit 1; }
command -v pvesm >/dev/null 2>&1 || { echo "pvesm not found. Run this on a Proxmox host."; exit 1; }

# -----------------------------
# Auto-detect a free CTID
# -----------------------------
CTID="$(pvesh get /cluster/nextid)"
echo "Using CTID: ${CTID}"

# -----------------------------
# Auto-detect bridge
# -----------------------------
BRIDGE="$(ip -o link show | awk -F': ' '{print $2}' | grep -E '^vmbr' | head -n1 || true)"
if [[ -z "${BRIDGE}" ]]; then
  echo "No vmbr bridge found."
  exit 1
fi
echo "Using bridge: ${BRIDGE}"

# -----------------------------
# Auto-detect template storage
# Needs 'vztmpl' content enabled
# -----------------------------
TEMPLATE_STORAGE="$(pvesm status -content vztmpl 2>/dev/null | awk 'NR>1 {print $1; exit}')"
if [[ -z "${TEMPLATE_STORAGE}" ]]; then
  echo "No storage with 'vztmpl' content found."
  exit 1
fi
echo "Using template storage: ${TEMPLATE_STORAGE}"

# -----------------------------
# Auto-detect container storage
# Prefer rootdir-capable storage
# -----------------------------
CONTAINER_STORAGE="$(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 {print $1; exit}')"
if [[ -z "${CONTAINER_STORAGE}" ]]; then
  # fallback to common names if content filter is weird on this host
  for s in local-lvm local media backups local-zfs; do
    if pvesm status 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$s"; then
      CONTAINER_STORAGE="$s"
      break
    fi
  done
fi
if [[ -z "${CONTAINER_STORAGE}" ]]; then
  echo "No storage for container rootfs found."
  exit 1
fi
echo "Using container storage: ${CONTAINER_STORAGE}"

# -----------------------------
# Refresh templates and pick latest Debian 12 standard template
# -----------------------------
echo "Updating appliance templates..."
pveam update >/dev/null

TEMPLATE="$(pveam available "${TEMPLATE_STORAGE}" 2>/dev/null | awk '/debian-12-standard_.*_amd64\.tar\.zst/ {print $2}' | tail -n1)"
if [[ -z "${TEMPLATE}" ]]; then
  echo "No Debian 12 standard template found on ${TEMPLATE_STORAGE}."
  exit 1
fi
echo "Using template: ${TEMPLATE}"

# -----------------------------
# Download template if missing
# -----------------------------
if ! pveam list "${TEMPLATE_STORAGE}" 2>/dev/null | awk '{print $2}' | grep -qx "${TEMPLATE}"; then
  echo "Downloading template..."
  pveam download "${TEMPLATE_STORAGE}" "${TEMPLATE}"
fi

# -----------------------------
# Create LXC
# -----------------------------
echo "Creating LXC..."
pct create "${CTID}" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
  --hostname "${HOSTNAME}" \
  --cores "${CORES}" \
  --memory "${RAM_MB}" \
  --rootfs "${CONTAINER_STORAGE}:${DISK_GB}" \
  --net0 "name=eth0,bridge=${BRIDGE},ip=dhcp" \
  --features nesting=1 \
  --unprivileged 0

# -----------------------------
# Start LXC
# -----------------------------
echo "Starting LXC..."
pct start "${CTID}"

echo "Waiting for container boot..."
sleep 10

# -----------------------------
# Install StreamForge inside LXC
# -----------------------------
pct exec "${CTID}" -- bash -c "
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

echo '=== Installing inside LXC ==='

apt update -y
apt install -y curl git ffmpeg python3 python3-venv python3-pip ca-certificates

# Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

INSTALL_DIR=/opt/streamforge
PORT=${PORT}

rm -rf \$INSTALL_DIR
mkdir -p \$INSTALL_DIR/backend
mkdir -p \$INSTALL_DIR/frontend/dist

# Minimal working backend
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
pip install --upgrade pip
pip install fastapi uvicorn
deactivate

# Minimal working frontend
cat > \$INSTALL_DIR/frontend/dist/index.html << 'EOF'
<!DOCTYPE html>
<html>
<head>
  <meta charset=\"utf-8\" />
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
  <title>StreamForge</title>
</head>
<body style=\"background:#111;color:#fff;font-family:sans-serif;padding:24px;\">
  <h1>StreamForge Running</h1>
  <p><a href=\"/api/health\" style=\"color:#7dd3fc;\">Check API</a></p>
</body>
</html>
EOF

# systemd service
cat > /etc/systemd/system/streamforge.service << EOF
[Unit]
Description=StreamForge
After=network.target

[Service]
Type=simple
WorkingDirectory=\$INSTALL_DIR/backend
ExecStart=\$INSTALL_DIR/backend/.venv/bin/uvicorn main:app --host 0.0.0.0 --port \$PORT
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable streamforge
systemctl restart streamforge
"

# -----------------------------
# Get IP and print result
# -----------------------------
IP="$(pct exec "${CTID}" -- hostname -I | awk '{print $1}')"

echo
echo "=============================="
echo "Container ID: ${CTID}"
echo "Container Storage: ${CONTAINER_STORAGE}"
echo "Template Storage: ${TEMPLATE_STORAGE}"
echo "URL: http://${IP}:${PORT}"
echo "=============================="
