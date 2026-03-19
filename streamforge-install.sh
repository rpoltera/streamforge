#!/usr/bin/env bash
set -euo pipefail

APP="StreamForge"
REPO_URL="https://github.com/rpoltera/streamforge.git"
INSTALL_DIR="/opt/streamforge"
SERVICE_NAME="streamforge"
PORT="8000"

GREEN='\033[1;32m'
YELLOW='\033[1;33m'
RED='\033[1;31m'
BLUE='\033[1;34m'
NC='\033[0m'

msg() { echo -e "${BLUE}==>${NC} $1"; }
ok()  { echo -e "${GREEN}✔${NC}  $1"; }
warn(){ echo -e "${YELLOW}⚠${NC}  $1"; }
err() { echo -e "${RED}✖${NC}  $1"; }

echo "============================"
echo "  ${APP} Full Installer"
echo "============================"

if [[ $EUID -ne 0 ]]; then
  err "Run this script as root."
  exit 1
fi

msg "[1/8] Updating system"
apt update -y
DEBIAN_FRONTEND=noninteractive apt upgrade -y
ok "System updated"

msg "[2/8] Installing dependencies"
DEBIAN_FRONTEND=noninteractive apt install -y \
  curl git ffmpeg python3 python3-venv python3-pip nodejs npm ca-certificates
ok "Dependencies installed"

msg "[3/8] Cloning repo"
rm -rf "${INSTALL_DIR}"
git clone "${REPO_URL}" "${INSTALL_DIR}"
ok "Repo cloned to ${INSTALL_DIR}"

msg "[4/8] Ensuring backend exists"
mkdir -p "${INSTALL_DIR}/backend"

if [[ ! -f "${INSTALL_DIR}/backend/main.py" ]]; then
  warn "No backend/main.py found, creating minimal backend"
  cat > "${INSTALL_DIR}/backend/main.py" <<'PYEOF'
from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path

app = FastAPI(title="StreamForge")

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIST = BASE_DIR.parent / "frontend" / "dist"

@app.get("/api/health")
def health():
    return {"status": "ok", "app": "StreamForge"}

@app.get("/api/info")
def info():
    return {
        "message": "StreamForge backend is running",
        "frontend_dist_exists": FRONTEND_DIST.exists()
    }

if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")

    @app.get("/{full_path:path}")
    def serve_frontend(full_path: str):
        index_file = FRONTEND_DIST / "index.html"
        if index_file.exists():
            return FileResponse(index_file)
        return JSONResponse({"error": "Frontend not built"}, status_code=500)
else:
    @app.get("/{full_path:path}")
    def no_frontend(full_path: str):
        return JSONResponse(
            {"error": "Frontend not built", "hint": "Check frontend build logs"},
            status_code=500
        )
PYEOF
  ok "Minimal backend created"
else
  ok "Backend found"
fi

msg "[5/8] Setting up Python backend"
cd "${INSTALL_DIR}/backend"
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
if [[ -f requirements.txt ]]; then
  pip install -r requirements.txt
else
  pip install fastapi uvicorn python-multipart
fi
deactivate
ok "Backend environment ready"

msg "[6/8] Ensuring frontend exists"
if [[ ! -d "${INSTALL_DIR}/frontend" ]]; then
  warn "No frontend directory found, creating Vite React frontend"
  cd "${INSTALL_DIR}"
  npm create vite@latest frontend -- --template react
fi

cd "${INSTALL_DIR}/frontend"

if [[ ! -f package.json ]]; then
  err "frontend/package.json is missing"
  exit 1
fi

# Make sure React app has an entry point if repo is incomplete
mkdir -p src

if [[ ! -f src/main.jsx ]]; then
  warn "No src/main.jsx found, creating it"
  cat > src/main.jsx <<'JSEOF'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
JSEOF
fi

if [[ ! -f src/App.jsx ]]; then
  warn "No src/App.jsx found, creating minimal app"
  cat > src/App.jsx <<'JSEOF'
export default function App() {
  return (
    <div style={{
      background: '#0f1117',
      color: '#e2e8f0',
      minHeight: '100vh',
      fontFamily: 'system-ui, sans-serif',
      padding: '32px'
    }}>
      <h1>StreamForge</h1>
      <p>Frontend is running.</p>
      <p>Backend health: <a href="/api/health" style={{color:'#60a5fa'}}>/api/health</a></p>
    </div>
  )
}
JSEOF
fi

if [[ ! -f src/index.css ]]; then
  warn "No src/index.css found, creating minimal CSS"
  cat > src/index.css <<'CSSEOF'
html, body, #root {
  margin: 0;
  padding: 0;
  min-height: 100%;
}
body {
  background: #0f1117;
}
CSSEOF
fi

msg "[7/8] Installing and building frontend"
npm install
npm run build
ok "Frontend built"

msg "[8/8] Creating systemd service"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=${APP}
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}/backend
ExecStart=${INSTALL_DIR}/backend/.venv/bin/uvicorn main:app --host 0.0.0.0 --port ${PORT}
Restart=always
RestartSec=3
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"
ok "Service started"

IP_ADDR="$(hostname -I | awk '{print $1}')"

echo
echo "============================"
echo "  ${APP} Installed"
echo "============================"
echo "URL: http://${IP_ADDR}:${PORT}"
echo "Health: http://${IP_ADDR}:${PORT}/api/health"
echo
systemctl --no-pager --full status "${SERVICE_NAME}" || true
