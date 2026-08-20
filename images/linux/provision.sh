#!/bin/bash
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  dbus-x11 \
  openssh-server \
  python3-venv \
  xfce4 \
  xfce4-terminal \
  xvfb
apt-get clean
rm -rf /var/lib/apt/lists/*

python3 -m venv /opt/computer-server/venv
/opt/computer-server/venv/bin/pip install --no-cache-dir \
  --extra-index-url https://wheels.cua.ai/simple \
  cua-computer-server==0.3.41

cat >/etc/systemd/system/cua-display.service <<'UNIT'
[Unit]
Description=CUA virtual display
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :1 -screen 0 1920x1080x24 -ac -nolisten tcp
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

cat >/etc/systemd/system/cua-desktop.service <<'UNIT'
[Unit]
Description=CUA XFCE desktop
After=cua-display.service
Requires=cua-display.service

[Service]
Type=simple
Environment=DISPLAY=:1
Environment=HOME=/root
ExecStart=/usr/bin/dbus-run-session -- /usr/bin/startxfce4
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

cat >/etc/systemd/system/computer-server.service <<'UNIT'
[Unit]
Description=CUA computer-server HTTP/WS/MCP API
After=network-online.target cua-desktop.service
Wants=network-online.target
Requires=cua-desktop.service

[Service]
Type=simple
Environment=DISPLAY=:1
Environment=HOME=/root
Environment=PYTHONUNBUFFERED=1
ExecStart=/opt/computer-server/venv/bin/python -m computer_server --host 0.0.0.0 --port 8000
Restart=always
RestartSec=3
StandardOutput=journal+console
StandardError=journal+console

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now cua-display.service cua-desktop.service computer-server.service ssh.service
systemctl set-default multi-user.target
touch /etc/cloud/cloud-init.disabled
rm -f /etc/machine-id
: >/etc/machine-id
touch /var/lib/cua-image-ready
