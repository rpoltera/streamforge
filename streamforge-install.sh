#!/usr/bin/env bash
# StreamForge Install Script - runs inside LXC
# https://github.com/rpoltera/streamforge
set -euo pipefail

REPO="https://raw.githubusercontent.com/rpoltera/streamforge/main"
INSTALL_DIR="/opt/streamforge"
SERVICE_USER="streamforge"

YW=$(echo "\033[33m"); GN=$(echo "\033[1;92m"); RD=$(echo "\033[01;31m"); CL=$(echo "\033[m")
msg_info()  { echo -e "  ⏳ ${YW}${1}${CL}"; }
msg_ok()    { echo -e "  ✔️  ${GN}${1}${CL}"; }
msg_error() { echo -e "  ✖️  ${RD}${1}${CL}"; exit 1; }

# ── Update mode ───────────────────────────────────────────────────────────────
if [[ "${1:-}" == "update" ]]; then
  [[ ! -d $INSTALL_DIR ]] && msg_error "No StreamForge found" && exit 1
  systemctl stop streamforge 2>/dev/null || true
  pkill -9 -f ffmpeg 2>/dev/null || true
  msg_info "Updating yt-dlp"
  curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp 2>/dev/null || true
  chmod +x /usr/local/bin/yt-dlp 2>/dev/null || true
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
  systemctl is-active --quiet streamforge && msg_ok "StreamForge running" || msg_error "Failed to start"
  exit 0
fi

# ── Fresh install ─────────────────────────────────────────────────────────────
msg_info "Setting up container"
export DEBIAN_FRONTEND=noninteractive
echo 'LC_ALL=C' >> /etc/environment
locale-gen C.UTF-8 2>/dev/null || true
msg_ok "Set up Container OS"

msg_info "Checking network"
ping -c1 -W3 8.8.8.8 &>/dev/null && msg_ok "Network Connected" || msg_error "No network"

msg_info "Updating OS"
apt-get update -qq
apt-get upgrade -y -qq
msg_ok "Updated Container OS"

msg_info "Installing Dependencies"
apt-get install -y -qq curl wget ffmpeg nginx python3
msg_ok "Installed Dependencies"

msg_info "Installing yt-dlp"
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod +x /usr/local/bin/yt-dlp
msg_ok "Installed yt-dlp $(yt-dlp --version)"

msg_info "Installing Node.js 20"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - &>/dev/null
apt-get install -y -qq nodejs
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

cd $INSTALL_DIR/server && npm install --production --quiet
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
nginx -t && systemctl reload nginx
msg_ok "Configured Nginx"

msg_info "Creating Service"
cat > /etc/systemd/system/streamforge.service << 'SERVICE'
[Unit]
Description=StreamForge IPTV Playout Manager
After=network.target

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
systemctl enable --now streamforge
msg_ok "Created Service"

printf '#!/bin/bash\nbash <(curl -fsSL https://raw.githubusercontent.com/rpoltera/streamforge/main/streamforge-install.sh) update\n' > /usr/local/bin/streamforge-update
chmod +x /usr/local/bin/streamforge-update

IP=$(hostname -I | awk '{print $1}')
echo ""
echo -e "  ${GN}StreamForge installed successfully!${CL}"
echo -e "  Access it at: http://${IP}"
