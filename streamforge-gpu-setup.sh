#!/usr/bin/env bash
# StreamForge GPU Setup — run on Proxmox host after install
# Usage: bash streamforge-gpu-setup.sh [CTID]
# https://github.com/rpoltera/streamforge

YW=$(echo "\033[33m"); GN=$(echo "\033[1;92m"); RD=$(echo "\033[01;31m"); CL=$(echo "\033[m")
msg_info()  { echo -e "  ⏳ ${YW}${1}${CL}"; }
msg_ok()    { echo -e "  ✔️  ${GN}${1}${CL}"; }
msg_error() { echo -e "  ✖️  ${RD}${1}${CL}"; exit 1; }

# ── Find StreamForge container ────────────────────────────────────────────────
if [[ -n "${1:-}" ]]; then
  CTID="$1"
else
  CTID=$(pct list | awk '/streamforge/ {print $1}' | head -1)
  [[ -z "$CTID" ]] && read -r -p "  Enter StreamForge container ID: " CTID < /dev/tty
fi

[[ -z "$CTID" ]] && msg_error "No container ID provided."
pct status "$CTID" &>/dev/null || msg_error "Container $CTID not found."

echo ""
echo -e "  Configuring GPU passthrough for container ${GN}${CTID}${CL}"
echo ""

LXC_CONF="/etc/pve/lxc/${CTID}.conf"

# ── Check for NVIDIA GPU ──────────────────────────────────────────────────────
if ! command -v nvidia-smi &>/dev/null; then
  msg_error "No NVIDIA GPU detected on this host."
fi

GPU=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)
msg_ok "Found GPU: ${GPU}"

# ── Remove any existing GPU config to avoid duplicates ───────────────────────
sed -i '/nvidia\|cgroup2.*195\|cgroup2.*234\|cgroup2.*239/d' "$LXC_CONF"

# ── Add cgroup permissions ────────────────────────────────────────────────────
msg_info "Adding device permissions"
cat >> "$LXC_CONF" << 'CONF'
lxc.cgroup2.devices.allow: c 195:* rwm
lxc.cgroup2.devices.allow: c 234:* rwm
lxc.cgroup2.devices.allow: c 239:* rwm
CONF
msg_ok "Device permissions added"

# ── Bind-mount NVIDIA devices ─────────────────────────────────────────────────
msg_info "Mounting NVIDIA devices"
for DEV in /dev/nvidia0 /dev/nvidia1 /dev/nvidia2 /dev/nvidia3 \
           /dev/nvidiactl /dev/nvidia-uvm /dev/nvidia-uvm-tools /dev/nvidia-modeset; do
  if [[ -e "$DEV" ]]; then
    # Remove if already present
    sed -i "\|${DEV} |d" "$LXC_CONF"
    echo "lxc.mount.entry: $DEV ${DEV#/} none bind,optional,create=file 0 0" >> "$LXC_CONF"
  fi
done
msg_ok "NVIDIA devices mounted"

# ── Bind-mount NVIDIA encode/decode libs ─────────────────────────────────────
msg_info "Mounting NVIDIA libraries"
for LIB in /usr/lib/x86_64-linux-gnu/libcuda.so* \
           /usr/lib/x86_64-linux-gnu/libnvcuvid.so* \
           /usr/lib/x86_64-linux-gnu/libnvidia-encode.so* \
           /usr/lib/x86_64-linux-gnu/libnvidia-decode.so* \
           /usr/lib/x86_64-linux-gnu/libnvidia-ml.so*; do
  if [[ -e "$LIB" ]]; then
    sed -i "\|${LIB} |d" "$LXC_CONF"
    echo "lxc.mount.entry: $LIB ${LIB#/} none bind,optional,create=file 0 0" >> "$LXC_CONF"
  fi
done
[[ -f /usr/bin/nvidia-smi ]] && {
  sed -i '\|nvidia-smi|d' "$LXC_CONF"
  echo "lxc.mount.entry: /usr/bin/nvidia-smi usr/bin/nvidia-smi none bind,optional,create=file 0 0" >> "$LXC_CONF"
}
msg_ok "NVIDIA libraries mounted"

# ── Restart container to apply ────────────────────────────────────────────────
echo ""
read -r -p "  Restart container $CTID now to apply changes? [Y/n]: " yn < /dev/tty
if [[ "${yn,,}" != "n" ]]; then
  msg_info "Restarting container"
  pct stop "$CTID" && sleep 2 && pct start "$CTID"
  sleep 3
  msg_ok "Container restarted"

  # Verify inside container
  if pct exec "$CTID" -- nvidia-smi &>/dev/null; then
    msg_ok "GPU confirmed working inside container!"
    pct exec "$CTID" -- nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null
  else
    echo -e "  ⚠️  nvidia-smi not accessible inside container — check driver version matches host."
  fi
fi

echo ""
echo -e "  ${GN}Done!${CL} In StreamForge Settings → Hardware Acceleration, select NVENC."
echo ""
