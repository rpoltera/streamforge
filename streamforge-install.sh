unzip streamforge-proxmox.zip
cd streamforge-proxmox

# Replace placeholders with your real username + repo name
bash setup-repo.sh yourname streamforge

# Push to GitHub
git init
git add .
git commit -m "Initial StreamForge release"
git branch -M main
git remote add origin https://github.com/yourname/streamforge.git
git push -u origin main
