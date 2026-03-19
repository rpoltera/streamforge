#!/usr/bin/env bash
source <(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/misc/build.func)

APP="StreamForge"
var_tags="${var_tags:-iptv}"
var_cpu="${var_cpu:-2}"
var_ram="${var_ram:-2048}"
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

  msg_info "Cloning repo"
  rm -rf /opt/streamforge
  git clone https://github.com/rpoltera/streamforge.git /opt/streamforge
  msg_ok "Cloned repo"

  # -----------------------------
  # BACKEND (safe check)
  # -----------------------------
  if [ -d "/opt/streamforge/backend" ]; then
    msg_info "Setting up backend"
    cd /opt/streamforge/backend

    python3 -m venv .venv
    source .venv/bin/activate

    pip install --upgrade pip
    pip install fastapi uvicorn python-multipart

    deactivate
    msg_ok "Backend ready"
  else
    msg_warn "No backend folder found - skipping backend setup"
  fi

  # -----------------------------
  # FRONTEND (safe check)
  # -----------------------------
  if [ -d "/opt/streamforge/frontend" ]; then
    msg_info "Setting up frontend"
    cd /opt/streamforge/frontend

    npm install
    npm run build

    msg_ok "Frontend built"
  else
    msg_warn "No frontend folder found - skipping frontend build"
  fi

  # -----------------------------
  # SERVICE (only if backend exists)
  # -----------------------------
  if [ -d "/opt/streamforge/backend" ]; then
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

    systemctl daemon-reload
    systemctl enable streamforge
    systemctl restart streamforge

    msg_ok "Service started"
  fi

  msg_ok "Installation complete"
}

start
build_container
description

msg_ok "Completed successfully!"
echo -e "${INFO}Access it at: http://${IP}:8000"
