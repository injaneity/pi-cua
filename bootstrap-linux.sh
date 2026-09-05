set -eu
SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi
if ! id cua >/dev/null 2>&1; then $SUDO useradd --create-home --shell /bin/bash cua; fi
if ! command -v curl >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1 || ! command -v xz >/dev/null 2>&1; then
  $SUDO apt-get update -qq
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y curl git ca-certificates tar xz-utils
fi
if ! node --version 2>/dev/null | grep -qx 'v22.20.0'; then
  node_archive=/tmp/node-v22.20.0-linux-x64.tar.xz
  node_root=/usr/local/lib/node-v22.20.0-linux-x64
  curl -fsSL https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz -o "$node_archive"
  printf '%s  %s\n' '00bbd05e306ea68b6e13e17360d0e2f680b493ef95f2fea1c4296ff7437530bc' "$node_archive" | sha256sum -c -
  $SUDO rm -rf "$node_root"
  $SUDO tar -xJf "$node_archive" -C /usr/local/lib
  for executable in node npm npx corepack; do $SUDO ln -sf "$node_root/bin/$executable" "/usr/local/bin/$executable"; done
  rm -f "$node_archive"
fi
pi_package=/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/package.json
if [ ! -f "$pi_package" ] || ! grep -q '"version": "__PI_VERSION__"' "$pi_package"; then
  $SUDO rm -rf /usr/local/lib/node_modules/@earendil-works/pi-coding-agent /usr/local/lib/node_modules/@earendil-works/.pi-coding-agent-*
  $SUDO npm install -g --prefix /usr/local --ignore-scripts @earendil-works/pi-coding-agent@__PI_VERSION__
fi
server_package=/usr/local/lib/node_modules/@earendil-works/pi-server/package.json
if [ ! -f "$server_package" ] || ! grep -q '"version": "__PI_VERSION__"' "$server_package"; then
  $SUDO npm install -g --prefix /usr/local --ignore-scripts @earendil-works/pi-server@__PI_VERSION__
fi
node --input-type=module -e 'await import("/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js")'
if ! /home/cua/.cargo/bin/cargo --version 2>/dev/null | grep -q 'cargo 1.88.0'; then
  curl -fsSL https://static.rust-lang.org/rustup/archive/1.28.2/x86_64-unknown-linux-gnu/rustup-init -o /tmp/rustup-init
  printf '%s  %s\n' '20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c' /tmp/rustup-init | sha256sum -c -
  chmod 755 /tmp/rustup-init
  $SUDO chown cua:cua /tmp/rustup-init
  if [ "$(id -u)" -eq 0 ]; then
    runuser -u cua -- env HOME=/home/cua RUSTUP_INIT_SKIP_PATH_CHECK=yes /tmp/rustup-init -y --profile minimal --default-toolchain 1.88.0
  else
    sudo -u cua env HOME=/home/cua RUSTUP_INIT_SKIP_PATH_CHECK=yes /tmp/rustup-init -y --profile minimal --default-toolchain 1.88.0
  fi
  rm -f /tmp/rustup-init
fi
if ! tailscale version 2>/dev/null | head -n 1 | grep -qx '1.102.3'; then
  tailscale_deb=/tmp/tailscale_1.102.3_amd64.deb
  curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/pool/tailscale_1.102.3_amd64.deb -o "$tailscale_deb"
  printf '%s  %s\n' '88e1b0319da94a52ea409a1a5935e4e7215065a25cd99bc509b6dcbb73737fae' "$tailscale_deb" | sha256sum -c -
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y "$tailscale_deb"
  rm -f "$tailscale_deb"
fi
$SUDO systemctl enable --now tailscaled
$SUDO rm -f /home/cua/.pi/agent/auth.json /home/cua/.pi/agent/models.json /home/cua/.pi/agent/APPEND_SYSTEM.md
$SUDO mkdir -p /home/cua/.pi/agent /home/cua/projects
$SUDO chown -R cua:cua /home/cua/.pi /home/cua/projects
TS_AUTH_KEY="$(cat /tmp/cua-tailscale-auth-key)"
$SUDO tailscale up --reset --force-reauth \
  --auth-key="${TS_AUTH_KEY}" \
  --advertise-tags=tag:cua-sandbox \
  --hostname="__HOSTNAME__" \
  --ssh
unset TS_AUTH_KEY
$SUDO install -d -o cua -g cua /home/cua/.cua-pi
printf '%s\n' '__BOOTSTRAP_VERSION__' | $SUDO tee /home/cua/.cua-pi/bootstrap-version >/dev/null
$SUDO chown cua:cua /home/cua/.cua-pi/bootstrap-version
$SUDO rm -f /tmp/cua-tailscale-auth-key
tailscale ip -4 | head -n 1
