#!/usr/bin/env bash
set -euo pipefail

APP="StreamForge"
HOSTNAME="streamforge"
DEBIAN_TEMPLATE_PATTERN='debian-12-standard_.*_amd64\.tar\.zst'
CORES=4
MEMORY=4096
SWAP=512
DISK_SIZE=20
PORT=8000

# Optional overrides:
# CTID=123 ./streamforge-install.sh
# TEMPLATE_STORAGE=backups ROOTFS_STORAGE=backups ./streamforge-install.sh

CTID="${CTID:-$(pvesh get /cluster/nextid)}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-}"
ROOTFS_STORAGE="${ROOTFS_STORAGE:-}"
BRIDGE="${BRIDGE:-vmbr0}"

echo "=== ${APP} Debian 12 LXC Deploy ==="

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: Run this on the Proxmox host as root."
  exit 1
fi

command -v pct >/dev/null 2>&1 || { echo "ERROR: pct not found."; exit 1; }
command -v pveam >/dev/null 2>&1 || { echo "ERROR: pveam not found."; exit 1; }
command -v pvesh >/dev/null 2>&1 || { echo "ERROR: pvesh not found."; exit 1; }
command -v pvesm >/dev/null 2>&1 || { echo "ERROR: pvesm not found."; exit 1; }

if ! ip link show "${BRIDGE}" >/dev/null 2>&1; then
  echo "ERROR: Bridge ${BRIDGE} does not exist."
  exit 1
fi

if pct status "${CTID}" >/dev/null 2>&1; then
  echo "ERROR: CTID ${CTID} already exists."
  exit 1
fi

# Pick template storage if not provided: first active dir storage
if [[ -z "${TEMPLATE_STORAGE}" ]]; then
  TEMPLATE_STORAGE="$(pvesm status | awk 'NR>1 && $2=="dir" && $3=="active" {print $1; exit}')"
fi

if [[ -z "${TEMPLATE_STORAGE}" ]]; then
  echo "ERROR: Could not auto-detect template storage."
  echo "Set TEMPLATE_STORAGE manually, for example:"
  echo "  TEMPLATE_STORAGE=backups ./streamforge-install.sh"
  exit 1
fi

# Pick rootfs storage if not provided: first active storage that is not ISO-only
if [[ -z "${ROOTFS_STORAGE}" ]]; then
  ROOTFS_STORAGE="$(pvesm status | awk 'NR>1 && $3=="active" {print $1; exit}')"
fi

if [[ -z "${ROOTFS_STORAGE}" ]]; then
  echo "ERROR: Could not auto-detect rootfs storage."
  echo "Set ROOTFS_STORAGE manually, for example:"
  echo "  ROOTFS_STORAGE=backups ./streamforge-install.sh"
  exit 1
fi

echo "Using CTID:            ${CTID}"
echo "Using bridge:          ${BRIDGE}"
echo "Using template store:  ${TEMPLATE_STORAGE}"
echo "Using rootfs store:    ${ROOTFS_STORAGE}"

echo "Updating appliance templates..."
pveam update >/dev/null

TEMPLATE="$(pveam available "${TEMPLATE_STORAGE}" 2>/dev/null | awk -v pat="${DEBIAN_TEMPLATE_PATTERN}" '$2 ~ pat {print $2}' | tail -n1)"

if [[ -z "${TEMPLATE}" ]]; then
  echo "ERROR: No Debian 12 standard template found on storage '${TEMPLATE_STORAGE}'."
  echo "Try a different TEMPLATE_STORAGE."
  exit 1
fi

echo "Using template:        ${TEMPLATE}"

if ! pveam list "${TEMPLATE_STORAGE}" 2>/dev/null | awk '{print $2}' | grep -qx "${TEMPLATE}"; then
  echo "Downloading template..."
  pveam download "${TEMPLATE_STORAGE}" "${TEMPLATE}"
fi

echo
echo "About to create LXC with:"
echo "  CTID:       ${CTID}"
echo "  Hostname:   ${HOSTNAME}"
echo "  Template:   ${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}"
echo "  Rootfs:     ${ROOTFS_STORAGE}:${DISK_SIZE}"
echo "  CPU:        ${CORES}"
echo "  RAM:        ${MEMORY}"
echo "  Swap:       ${SWAP}"
echo "  Network:    ${BRIDGE} / DHCP"
echo
read -r -p "Type YES to continue: " CONFIRM
if [[ "${CONFIRM}" != "YES" ]]; then
  echo "Aborted."
  exit 0
fi

pct create "${CTID}" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
  --hostname "${HOSTNAME}" \
  --cores "${CORES}" \
  --memory "${MEMORY}" \
  --swap "${SWAP}" \
  --net0 "name=eth0,bridge=${BRIDGE},ip=dhcp" \
  --rootfs "${ROOTFS_STORAGE}:${DISK_SIZE}" \
  --unprivileged 0 \
  --features nesting=1

pct start "${CTID}"

echo "Waiting for container to boot..."
sleep 10

pct exec "${CTID}" -- bash -c "
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt update -y
apt install -y curl git ffmpeg python3 python3-venv python3-pip ca-certificates

curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

INSTALL_DIR=/opt/streamforge
rm -rf \$INSTALL_DIR
mkdir -p \$INSTALL_DIR/backend
mkdir -p \$INSTALL_DIR/frontend/dist

cat > \$INSTALL_DIR/backend/main.py << 'PYEOF'
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
PYEOF

cd \$INSTALL_DIR/backend
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install fastapi uvicorn
deactivate

cat > \$INSTALL_DIR/frontend/dist/index.html << 'HTMLEOF'
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
HTMLEOF

cat > /etc/systemd/system/streamforge.service << 'SVCEOF'
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
"

IP="$(pct exec "${CTID}" -- hostname -I | awk '{print $1}')"

echo
echo "=============================="
echo "Container ID: ${CTID}"
echo "URL: http://${IP}:${PORT}"
echo "Health: http://${IP}:${PORT}/api/health"
echo "=============================="
