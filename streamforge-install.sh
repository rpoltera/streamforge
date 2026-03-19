#!/usr/bin/env bash
source <(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/misc/build.func)

# Author: Raymond / ChatGPT
# License: MIT
# App: StreamForge (Custom IPTV Scheduler)

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

function install_streamforge() {

  msg_info "Updating system"
  apt update -y && apt upgrade -y
  msg_ok "Updated system"

  msg_info "Installing dependencies"
  apt install -y curl git ffmpeg python3 python3-venv python3-pip nodejs npm
  msg_ok "Installed dependencies"

  msg_info "Cloning StreamForge repo"
  git clone https://github.com/rpoltera/streamforge.git /opt/streamforge
  msg_ok "Cloned repo"

  # =========================
  # Backend setup
  # =========================
  msg_info "Setting up backend"
  cd /opt/streamforge/backend

  python3 -m venv .venv
  source .venv/bin/activate

  pip install --upgrade pip
  pip install fastapi uvicorn python-multipart

  deactivate
  msg_ok "Backend ready"

  # =========================
  # Frontend setup
  # =========================
  msg_info "Setting up frontend"
  cd /opt/streamforge/frontend

  npm install
  npm run build
  msg_ok "Frontend built"

  # =========================
  # Create systemd service
  # =========================
  msg_info "Creating service"

cat <<EOF >/etc/systemd/system/streamforge.service
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
EOF

  systemctl daemon-reexec
  systemctl daemon-reload
  systemctl enable streamforge
  systemctl start streamforge

  msg_ok "Service created and started"

  # =========================
  # Done
  # =========================
  msg_ok "StreamForge Installed Successfully"
}

start
build_container
description

msg_info "Installing ${APP}"
lxc-attach -n $CTID -- bash -c "$(declare -f install_streamforge); install_streamforge"

msg_ok "Completed successfully!"
echo -e "${INFO} Access your app:"
echo -e "${TAB}http://${IP}:8000"
