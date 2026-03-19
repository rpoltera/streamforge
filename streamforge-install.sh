#!/usr/bin/env bash
set -euo pipefail

APP="StreamForge"
HOSTNAME="streamforge"
PORT=8000
CORES=2
MEMORY=2048
SWAP=512
DISK=10

echo "=== ${APP} Debian 12 LXC Deploy ==="

command -v pct >/dev/null || { echo "Run on Proxmox host"; exit 1; }

CTID=$(pvesh get /cluster/nextid)

BRIDGE=$(ip -o link show | awk -F': ' '{print $2}' | grep '^vmbr' | head -n1)
[ -z "$BRIDGE" ] && { echo "No vmbr bridge found"; exit 1; }

# -------- HARD FILTER STORAGE (NO BACKUPS EVER) --------

VALID_STORES=$(pvesm status | awk 'NR>1 && $3=="active" {print $1}' | grep -v '^backups$')

# Find template storage that ACTUALLY WORKS
for S in $VALID_STORES; do
  if pveam available "$S" >/dev/null 2>&1; then
    TEMPLATE_STORAGE="$S"
    break
  fi
done

[ -z "${TEMPLATE_STORAGE:-}" ] && { echo "No valid template storage found"; exit 1; }

# Find rootfs storage (prefer lvm/zfs, avoid dir backups)
for S in $VALID_STORES; do
  if pvesm status -storage "$S" | grep -qE 'lvm|zfspool|lvmthin|dir'; then
    ROOTFS_STORAGE="$S"
    break
  fi
done

[ -z "${ROOTFS_STORAGE:-}" ] && { echo "No valid rootfs storage found"; exit 1; }

echo "CTID: $CTID"
echo "Bridge: $BRIDGE"
echo "Template storage: $TEMPLATE_STORAGE"
echo "Rootfs storage: $ROOTFS_STORAGE"

echo "Updating templates..."
pveam update

echo "Finding Debian 12 template..."

TEMPLATE=$(pveam available "$TEMPLATE_STORAGE" | awk '/debian-12-standard/ {print $2}' | tail -n1)

[ -z "$TEMPLATE" ] && { echo "FAILED: No template found"; exit 1; }

echo "Template: $TEMPLATE"

if ! pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE"; then
  echo "Downloading template..."
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
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
sleep 5

echo "Installing app..."

pct exec $CTID -- bash -c "
set -e
apt update -y
apt install -y python3 python3-venv python3-pip

mkdir -p /opt/streamforge/backend

cat > /opt/streamforge/backend/main.py << 'EOF'
from fastapi import FastAPI
app = FastAPI()

@app.get('/')
def root():
    return {'status': 'running'}
EOF

cd /opt/streamforge/backend
python3 -m venv .venv
source .venv/bin/activate
pip install fastapi uvicorn
deactivate

cat > /etc/systemd/system/streamforge.service << 'EOF'
[Unit]
Description=StreamForge
After=network.target

[Service]
ExecStart=/opt/streamforge/backend/.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
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
echo "=========================="
echo "LXC CREATED: $CTID"
echo "URL: http://$IP:8000"
