#!/usr/bin/env bash
source <(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/misc/build.func)

# Author: Raymond
# License: MIT
# App: StreamForge

APP="StreamForge"
var_tags="${var_tags:-iptv;media}"
var_cpu="${var_cpu:-4}"
var_ram="${var_ram:-4096}"
var_disk="${var_disk:-10}"
var_os="${var_os:-debian}"
var_version="${var_version:-12}"
var_unprivileged="${var_unprivileged:-0}"

header_info "$APP"
variables
color
catch_errors

start
build_container
description

msg_info "Installing ${APP}"

lxc-attach -n $CTID -- bash <<'EOF'
set -e

echo "============================"
echo "StreamForge Installation"
echo "============================"

echo "[1/7] Updating system..."
apt update -y && apt upgrade -y

echo "[2/7] Installing dependencies..."
apt install -y curl git ffmpeg python3 python3-venv python3-pip nodejs npm

echo "[3/7] Cloning StreamForge repo..."
rm -rf /opt/streamforge
git clone https://github.com/rpoltera/streamforge.git /opt/streamforge

echo "[4/7] Setting up backend..."
cd /opt/streamforge/backend

python3 -m venv .venv
source .venv/bin/activate

pip install --upgrade pip
pip install fastapi uvicorn python-multipart

deactivate

echo "[5/7] Setting up frontend..."
cd /opt/streamforge/frontend

npm install
npm run build

echo "[6/7] Creating systemd service..."

cat <<SERVICE >/etc/systemd/system/streamforge.service
[Unit]
Description=StreamForge IPTV Scheduler
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/streamforge/backend
ExecStart=/opt/streamforge/backend/.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
Restart=always

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable streamforge
systemctl restart streamforge

echo "[7/7] Cleaning up..."
apt autoremove -y

echo "============================"
echo "StreamForge Installed"
echo "============================"
EOF

msg_ok "Completed successfully!"
echo -e "${INFO} Access your app:"
echo -e "${TAB}http://${IP}:8000"
