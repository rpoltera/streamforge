#!/usr/bin/env bash
source <(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/misc/install.func)
# Copyright (c) 2021-2026 community-scripts ORG
# Author: rpoltera
# License: MIT
# Source: https://github.com/rpoltera/streamforge

APPLICATION="StreamForge"

REPO="https://raw.githubusercontent.com/rpoltera/streamforge/main"
INSTALL_DIR="/opt/streamforge"
SERVICE_USER="streamforge"

# ── Update mode ───────────────────────────────────────────────────────────────
if [[ "${1:-}" == "update" ]]; then
  [[ ! -d $INSTALL_DIR ]] && echo "No StreamForge found" && exit 1
  systemctl stop streamforge 2>/dev/null || true
  pkill -9 -f ffmpeg 2>/dev/null || true
  msg_info "Downloading latest files"
  curl -fsSL "$REPO/server/index.js"     -o "$INSTALL_DIR/server/index.js"
  curl -fsSL "$REPO/server/package.json" -o "$INSTALL_DIR/server/package.json"
  curl -fsSL "$REPO/public/index.html"   -o "$INSTALL_DIR/public/index.html"
  curl -fsSL "$REPO/public/css/main.css" -o "$INSTALL_DIR/public/css/main.css"
  curl -fsSL "$REPO/public/js/app.js"    -o "$INSTALL_DIR/public/js/app.js"
  chown -R $SERVICE_USER:$SERVICE_USER $INSTALL_DIR
  su -s /bin/bash $SERVICE_USER -c "cd $INSTALL_DIR/server && npm install --production --quiet"
  msg_ok "Files updated"
  msg_info "Starting StreamForge"
  systemctl start streamforge
  sleep 2
  systemctl is-active --quiet streamforge && msg_ok "StreamForge running" || echo "Failed to start"
  exit 0
fi

# ── Fresh install ─────────────────────────────────────────────────────────────
setting_up_container
network_check
update_os

msg_info "Installing Dependencies"
$STD apt-get install -y curl wget ffmpeg nginx
msg_ok "Installed Dependencies"

msg_info "Installing Node.js 20"
$STD bash <(curl -fsSL https://deb.nodesource.com/setup_20.x)
$STD apt-get install -y nodejs
msg_ok "Installed Node.js $(node --version)"

msg_info "Setting Up StreamForge"
useradd -r -s /bin/false -d $INSTALL_DIR $SERVICE_USER 2>/dev/null || true
mkdir -p $INSTALL_DIR/server $INSTALL_DIR/public/css $INSTALL_DIR/public/js
mkdir -p /var/lib/streamforge/config /var/lib/streamforge/hls /var/lib/streamforge/uploads

curl -fsSL "$REPO/server/index.js"     -o "$INSTALL_DIR/server/index.js"
curl -fsSL "$REPO/server/package.json" -o "$INSTALL_DIR/server/package.json"
curl -fsSL "$REPO/public/index.html"   -o "$INSTALL_DIR/public/index.html"
curl -fsSL "$REPO/public/css/main.css" -o "$INSTALL_DIR/public/css/main.css"
curl -fsSL "$REPO/public/js/app.js"    -o "$INSTALL_DIR/public/js/app.js"

cd $INSTALL_DIR/server && $STD npm install --production
chown -R $SERVICE_USER:$SERVICE_USER $INSTALL_DIR /var/lib/streamforge
chmod -R 755 $INSTALL_DIR /var/lib/streamforge
msg_ok "StreamForge Set Up"

msg_info "Configuring Nginx"
cat > /etc/nginx/sites-available/streamforge << 'NGINX'
server {
    listen 80;
    server_name _;
    client_max_body_size 200M;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 300s;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/streamforge /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
$STD nginx -t && systemctl reload nginx
msg_ok "Configured Nginx"

msg_info "Creating Service"
cat > /etc/systemd/system/streamforge.service << 'SERVICE'
[Unit]
Description=StreamForge IPTV Playout Manager
After=network.target
Documentation=https://github.com/rpoltera/streamforge

[Service]
Type=simple
User=streamforge
WorkingDirectory=/opt/streamforge/server
ExecStart=/usr/bin/node /opt/streamforge/server/index.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=streamforge
Environment=SF_DATA=/var/lib/streamforge
Environment=SF_CONFIG=/var/lib/streamforge/config/config.json
Environment=SF_LOG=/var/lib/streamforge

[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
$STD systemctl enable --now streamforge
msg_ok "Created Service"

printf '#!/bin/bash\nbash <(curl -fsSL https://raw.githubusercontent.com/rpoltera/streamforge/main/install/streamforge-install.sh) update\n' > /usr/local/bin/streamforge-update
chmod +x /usr/local/bin/streamforge-update

motd_ssh
customize
