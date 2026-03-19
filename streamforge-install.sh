#!/usr/bin/env bash
set -euo pipefail

APP="StreamForge"
REPO_URL="https://github.com/rpoltera/streamforge.git"
INSTALL_DIR="/opt/streamforge"
SERVICE_NAME="streamforge"
PORT="8000"

echo "============================"
echo "  ${APP} Full Installer"
echo "============================"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root"
  exit 1
fi

echo "[1/9] Updating system"
apt update -y
DEBIAN_FRONTEND=noninteractive apt upgrade -y

echo "[2/9] Installing base dependencies"
apt install -y curl git ffmpeg python3 python3-venv python3-pip ca-certificates

echo "[3/9] Installing Node.js 20 (REQUIRED)"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

echo "[4/9] Verifying Node"
node -v
npm -v

echo "[5/9] Cloning repo"
rm -rf "${INSTALL_DIR}"
git clone "${REPO_URL}" "${INSTALL_DIR}"

# -------------------------
# BACKEND
# -------------------------
echo "[6/9] Backend setup"

mkdir -p "${INSTALL_DIR}/backend"

if [[ ! -f "${INSTALL_DIR}/backend/main.py" ]]; then
cat > "${INSTALL_DIR}/backend/main.py" <<'EOF'
from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path

app = FastAPI(title="StreamForge")

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIST = BASE_DIR.parent / "frontend" / "dist"

@app.get("/api/health")
def health():
    return {"status": "ok"}

if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")

    @app.get("/{full_path:path}")
    def serve_frontend(full_path: str):
        index_file = FRONTEND_DIST / "index.html"
        if index_file.exists():
            return FileResponse(index_file)
        return JSONResponse({"error": "frontend missing"}, status_code=500)
else:
    @app.get("/{full_path:path}")
    def no_frontend(full_path: str):
        return {"error": "frontend not built"}
EOF
fi

cd "${INSTALL_DIR}/backend"
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install fastapi uvicorn python-multipart
deactivate

# -------------------------
# FRONTEND
# -------------------------
echo "[7/9] Frontend setup"

cd "${INSTALL_DIR}"

if [[ ! -d "frontend" ]]; then
  npx create-vite@latest frontend --template react --yes
fi

cd frontend

mkdir -p src

if [[ ! -f src/main.jsx ]]; then
cat > src/main.jsx <<'EOF'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
EOF
fi

if [[ ! -f src/App.jsx ]]; then
cat > src/App.jsx <<'EOF'
export default function App() {
  return (
    <div style={{background:'#0f1117',color:'#fff',minHeight:'100vh',padding:'20px'}}>
      <h1>StreamForge</h1>
      <p>Running</p>
      <a href="/api/health">Health Check</a>
    </div>
  )
}
EOF
fi

if [[ ! -f src/index.css ]]; then
echo "body { margin:0; background:#0f1117; }" > src/index.css
fi

npm install
npm run build

# -------------------------
# SERVICE
# -------------------------
echo "[8/9] Creating service"

cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=StreamForge
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}/backend
ExecStart=${INSTALL_DIR}/backend/.venv/bin/uvicorn main:app --host 0.0.0.0 --port ${PORT}
Restart=always

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}
systemctl restart ${SERVICE_NAME}

IP=$(hostname -I | awk '{print $1}')

echo "[9/9] DONE"
echo "Access: http://${IP}:${PORT}"
echo "Health: http://${IP}:${PORT}/api/health"
