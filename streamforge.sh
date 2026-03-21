#!/usr/bin/env bash
# StreamForge - IPTV Playout Manager
# Proxmox LXC Installer
# https://github.com/rpoltera/streamforge

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
YW=$(echo "\033[33m"); GN=$(echo "\033[1;92m"); RD=$(echo "\033[01;31m")
BL=$(echo "\033[36m"); BGN=$(echo "\033[4;92m"); CL=$(echo "\033[m")
BOLD=$(echo "\033[1m"); TAB="  "
CM="${TAB}✔️ "; CROSS="${TAB}✖️ "; INFO="${TAB}💡 "

msg_info()  { echo -e "${TAB}⏳ ${YW}${1}${CL}"; }
msg_ok()    { echo -e "${CM}${GN}${1}${CL}"; }
msg_error() { echo -e "${CROSS}${RD}${1}${CL}"; exit 1; }

# ── Check running on Proxmox host ─────────────────────────────────────────────
if ! command -v pct &>/dev/null; then
  msg_error "This script must be run on a Proxmox VE host."
fi

# ── Defaults ──────────────────────────────────────────────────────────────────
CTID=$(pvesh get /cluster/nextid)
HOSTNAME="streamforge"
DISK="8"
RAM="2048"
CPU="2"
OS_TEMPLATE=""
STORAGE=""
BRIDGE="vmbr0"
NET="dhcp"
UNPRIVILEGED="1"
INSTALL_URL="https://raw.githubusercontent.com/rpoltera/streamforge/main/streamforge-install.sh"

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
echo -e "${BL}  IPTV Playout Manager — Proxmox LXC Installer${CL}\n"

# ── Find storage ──────────────────────────────────────────────────────────────
STORAGE=$(pvesm status -content rootdir | awk 'NR>1 {print $1}' | head -1)
[[ -z "$STORAGE" ]] && msg_error "No storage found for containers."

# Find template storage
TMPL_STORAGE=$(pvesm status -content vztmpl | awk 'NR>1 {print $1}' | head -1)
[[ -z "$TMPL_STORAGE" ]] && msg_error "No template storage found."

# ── Find/download Debian 12 template ─────────────────────────────────────────
msg_info "Looking for Debian 12 template"
OS_TEMPLATE=$(pveam list "$TMPL_STORAGE" 2>/dev/null | grep "debian-12-standard" | sort -r | head -1 | awk '{print $1}')
if [[ -z "$OS_TEMPLATE" ]]; then
  msg_info "Downloading Debian 12 template"
  pveam update &>/dev/null
  TMPL_NAME=$(pveam available --section system | grep "debian-12-standard" | sort -r | head -1 | awk '{print $1}')
  [[ -z "$TMPL_NAME" ]] && msg_error "Debian 12 template not available."
  pveam download "$TMPL_STORAGE" "$TMPL_NAME" &>/dev/null
  OS_TEMPLATE="${TMPL_STORAGE}:vztmpl/${TMPL_NAME}"
fi
msg_ok "Template: $OS_TEMPLATE"

# ── Root password ─────────────────────────────────────────────────────────────
while true; do
  read -r -s -p "  Set root password for container: " ROOT_PASS < /dev/tty; echo
  read -r -s -p "  Confirm password: " ROOT_PASS2 < /dev/tty; echo
  [[ "$ROOT_PASS" == "$ROOT_PASS2" ]] && break
  echo -e "${RD}  Passwords do not match, try again.${CL}"
done

# ── Show settings & confirm ───────────────────────────────────────────────────
echo -e "\n${BOLD}  Container Settings${CL}"
echo -e "${INFO}Container ID:   ${BGN}${CTID}${CL}"
echo -e "${INFO}Hostname:       ${BGN}${HOSTNAME}${CL}"
echo -e "${INFO}Disk Size:      ${BGN}${DISK} GB${CL}"
echo -e "${INFO}CPU Cores:      ${BGN}${CPU}${CL}"
echo -e "${INFO}RAM Size:       ${BGN}${RAM} MiB${CL}"
echo -e "${INFO}Storage:        ${BGN}${STORAGE}${CL}"
echo -e "${INFO}Bridge:         ${BGN}${BRIDGE}${CL}"
echo -e "${INFO}Network:        ${BGN}${NET}${CL}"
echo -e "${INFO}Type:           ${BGN}Unprivileged${CL}\n"

read -r -p "  Create StreamForge LXC with these settings? [Y/n]: " confirm < /dev/tty
[[ "${confirm,,}" == "n" ]] && echo "Aborted." && exit 0

# ── Create LXC ────────────────────────────────────────────────────────────────
echo ""
msg_info "Creating LXC container ${CTID}"
pct create "$CTID" "$OS_TEMPLATE" \
  --hostname "$HOSTNAME" \
  --cores "$CPU" \
  --memory "$RAM" \
  --rootfs "${STORAGE}:${DISK}" \
  --net0 "name=eth0,bridge=${BRIDGE},ip=${NET}" \
  --unprivileged "$UNPRIVILEGED" \
  --features nesting=1 \
  --onboot 1 \
  --start 0 \
  --password "$ROOT_PASS" &>/dev/null
msg_ok "Created LXC container ${CTID}"

# ── Start container ───────────────────────────────────────────────────────────
msg_info "Starting container"
pct start "$CTID"
sleep 5

# Wait for network
for i in {1..20}; do
  if pct exec "$CTID" -- ping -c1 -W2 8.8.8.8 &>/dev/null; then break; fi
  sleep 3
done
msg_ok "Container running"

# ── Run install script inside LXC ─────────────────────────────────────────────
msg_info "Installing StreamForge (this takes a few minutes)"
pct exec "$CTID" -- bash -c "apt-get update -qq && apt-get install -y -qq curl && curl -fsSL ${INSTALL_URL} | bash"
msg_ok "StreamForge installed"

# ── Get IP ────────────────────────────────────────────────────────────────────
IP=$(pct exec "$CTID" -- hostname -I | awk '{print $1}')

echo -e "\n${CM}${GN}Completed Successfully!${CL}\n"
echo -e "${TAB}🚀 StreamForge is ready!"
echo -e "${INFO}Access it at: ${BGN}http://${IP}${CL}\n"
