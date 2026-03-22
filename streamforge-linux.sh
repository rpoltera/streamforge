#!/usr/bin/env bash
# StreamForge Linux Installer
# Supports: Ubuntu 20+, Debian 11+, Fedora 36+, RHEL/CentOS 8+
# Usage: bash <(curl -fsSL https://raw.githubusercontent.com/rpoltera/streamforge/main/streamforge-linux.sh)

set -euo pipefail

REPO="https://raw.githubusercontent.com/rpoltera/streamforge/main"
INSTALL_DIR="/opt/streamforge"
DATA_DIR="/var/lib/streamforge"
SERVICE_USER="streamforge"

YW=$(echo "\033[33m"); GN=$(echo "\033[1;92m"); RD=$(echo "\033[01;31m"); CL=$(echo "\033[m")
msg_info()  { echo -e "  ⏳ ${YW}${1}${CL}"; }
msg_ok()    { echo -e "  ✔️  ${GN}${1}${CL}"; }
msg_error() { echo -e "  ✖️  ${RD}${1}${CL}"; exit 1; }

# ── Banner ────────────────────────────────────────────────────────────────────
clear
cat << "BANNER"
   _____ __                           ______
  / ___// /_________  ____ _____ ___ / ____/___  _________ ____
  \__ \/ __/ ___/ _ \/ __ `/ __ `__ \/ /_  / _ \/ ___/ __ `/ _ \
 ___/ / /_/ /  /  __/ /_/ / / / / / / __/ /  __/ /  / /_/ /  __/
/____/\__/_/   \___/\__,_/_/ /_/ /_/_/    \___/_/   \__, /\___/
                                                    /____/
BANNER
echo -e "${YW}  IPTV Playout Manager — Linux Installer${CL}\n"

# ── Check root ────────────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]] && msg_error "Run as root: sudo bash streamforge-linux.sh"

# ── Detect distro ─────────────────────────────────────────────────────────────
if [ -f /etc/os-release ]; then
    . /etc/os-release
    DISTRO=$ID
    DISTRO_LIKE=${ID_LIKE:-$ID}
else
    msg_error "Cannot detect Linux distribution"
fi

msg_info "Detected: $PRETTY_NAME"

# ── Update & install dependencies ─────────────────────────────────────────────
msg_info "Installing dependencies..."
export DEBIAN_FRONTEND=noninteractive

if [[ "$DISTRO" =~ ^(ubuntu|debian|linuxmint|pop)$ ]] || [[ "$DISTRO_LIKE" =~ debian ]]; then
    apt-get update -qq
    apt-get install -y -qq curl wget ffmpeg nginx
elif [[ "$DISTRO" =~ ^(fedora)$ ]]; then
    dnf install -y curl wget ffmpeg nginx --quiet
elif [[ "$DISTRO" =~ ^(rhel|centos|rocky|almalinux)$ ]] || [[ "$DISTRO_LIKE" =~ rhel ]]; then
    dnf install -y epel-release --quiet 2>/dev/null || yum install -y epel-release --quiet
    dnf install -y curl wget ffmpeg nginx --quiet
else
    msg_error "Unsupported distro: $DISTRO. Supported: Ubuntu, Debian, Fedora, RHEL/Rocky/Alma"
fi
msg_ok "Dependencies installed"

# ── Install Node.js 20 ────────────────────────────────────────────────────────
msg_info "Installing Node.js 20..."
if ! command -v node &>/dev/null || [[ "$(node --version)" != v20* ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - &>/dev/null 2>&1 || \
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - &>/dev/null 2>&1

    if [[ "$DISTRO" =~ ^(ubuntu|debian|linuxmint|pop)$ ]] || [[ "$DISTRO_LIKE" =~ debian ]]; then
        apt-get install -y -qq nodejs
    else
        dnf install -y nodejs --quiet || yum install -y nodejs --quiet
    fi
fi
msg_ok "Node.js $(node --version) installed"

# ── Create user & directories ─────────────────────────────────────────────────
msg_info "Setting up StreamForge..."
useradd -r -s /bin/false -d $INSTALL_DIR $SERVICE_USER 2>/dev/null || true
mkdir -p $INSTALL_DIR/server $INSTALL_DIR/public/css $INSTALL_DIR/public/js
mkdir -p $DATA_DIR/config $DATA_DIR/hls $DATA_DIR/uploads

# ── Download app files ────────────────────────────────────────────────────────
curl -fsSL "$REPO/server/index.js"     -o "$INSTALL_DIR/server/index.js"
curl -fsSL "$REPO/server/package.json" -o "$INSTALL_DIR/server/package.json"
curl -fsSL "$REPO/public/index.html"   -o "$INSTALL_DIR/public/index.html"
curl -fsSL "$REPO/public/css/main.css" -o "$INSTALL_DIR/public/css/main.css"
curl -fsSL "$REPO/public/js/app.js"    -o "$INSTALL_DIR/public/js/app.js"

cd $INSTALL_DIR/server && npm install --production --quiet
chown -R $SERVICE_USER:$SERVICE_USER $INSTALL_DIR $DATA_DIR
msg_ok "StreamForge installed"

# ── Nginx config ──────────────────────────────────────────────────────────────
msg_info "Configuring Nginx..."
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
    }
}
NGINX

# Handle both sites-available (Debian/Ubuntu) and conf.d (RHEL/Fedora)
if [ -d /etc/nginx/sites-enabled ]; then
    ln -sf /etc/nginx/sites-available/streamforge /etc/nginx/sites-enabled/
    rm -f /etc/nginx/sites-enabled/default
else
    cp /etc/nginx/sites-available/streamforge /etc/nginx/conf.d/streamforge.conf
fi

nginx -t && systemctl enable --now nginx && systemctl reload nginx
msg_ok "Nginx configured"

# ── Systemd service ───────────────────────────────────────────────────────────
msg_info "Creating service..."
cat > /etc/systemd/system/streamforge.service << SERVICE
[Unit]
Description=StreamForge IPTV Playout Manager
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR/server
ExecStart=/usr/bin/node $INSTALL_DIR/server/index.js
Restart=on-failure
RestartSec=10
Environment=SF_DATA=$DATA_DIR
Environment=SF_CONFIG=$DATA_DIR/config/config.json

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable --now streamforge
msg_ok "Service created and started"

# ── Update command ────────────────────────────────────────────────────────────
cat > /usr/local/bin/streamforge-update << 'UPDATE'
#!/bin/bash
REPO="https://raw.githubusercontent.com/rpoltera/streamforge/main"
INSTALL_DIR="/opt/streamforge"
systemctl stop streamforge
curl -fsSL "$REPO/server/index.js"     -o "$INSTALL_DIR/server/index.js"
curl -fsSL "$REPO/server/package.json" -o "$INSTALL_DIR/server/package.json"
curl -fsSL "$REPO/public/index.html"   -o "$INSTALL_DIR/public/index.html"
curl -fsSL "$REPO/public/css/main.css" -o "$INSTALL_DIR/public/css/main.css"
curl -fsSL "$REPO/public/js/app.js"    -o "$INSTALL_DIR/public/js/app.js"
cd $INSTALL_DIR/server && npm install --production --quiet
chown -R streamforge:streamforge $INSTALL_DIR
systemctl start streamforge
echo "StreamForge updated!"
UPDATE
chmod +x /usr/local/bin/streamforge-update

# ── Done ──────────────────────────────────────────────────────────────────────
IP=$(hostname -I | awk '{print $1}')
echo ""
msg_ok "StreamForge installed successfully!"
echo -e "\n  🚀 Access it at: ${GN}http://${IP}${CL}"
echo -e "  📁 Data folder:  ${GN}${DATA_DIR}${CL}"
echo -e "  🔄 To update:    ${GN}streamforge-update${CL}\n"
