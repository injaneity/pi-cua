set -eu
SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi
if ! id cua >/dev/null 2>&1; then $SUDO useradd --create-home --shell /bin/bash cua; fi
if ! command -v curl >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  $SUDO apt-get update -qq
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y curl git ca-certificates tar
fi
if ! command -v npm >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi
if ! pi --version 2>/dev/null | grep -q '__PI_VERSION__'; then
  npm_root=$(npm root -g)
  $SUDO rm -rf "$npm_root/@earendil-works/pi-coding-agent" "$npm_root/@earendil-works"/.pi-coding-agent-*
  $SUDO npm install -g --ignore-scripts @earendil-works/pi-coding-agent@__PI_VERSION__
fi
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
if ! command -v tailscale >/dev/null 2>&1; then curl -fsSL https://tailscale.com/install.sh | sh; fi
if command -v systemctl >/dev/null 2>&1; then
  $SUDO systemctl enable --now tailscaled
else
  $SUDO service tailscaled start
fi
$SUDO rm -f /home/cua/.pi/agent/auth.json /home/cua/.pi/agent/models.json /home/cua/.pi/agent/APPEND_SYSTEM.md
$SUDO rm -rf /home/cua/.pi/agent/extensions /home/cua/.pi/agent/prompt-templates /home/cua/.pi/agent/skills
$SUDO mkdir -p /home/cua/.pi/agent/extensions /home/cua/projects
$SUDO tar -xzf /tmp/cua-pi-agent.tgz -C /home/cua
$SUDO chown -R cua:cua /home/cua/.pi /home/cua/projects
TS_AUTH_KEY="$(cat /tmp/cua-tailscale-auth-key)"
$SUDO tailscale up --reset \
  --auth-key="${TS_AUTH_KEY}" \
  --advertise-tags=tag:cua-sandbox \
  --hostname="__HOSTNAME__" \
  --ssh
unset TS_AUTH_KEY
$SUDO install -d -o cua -g cua /home/cua/.cua-pi
printf '%s\n' '__BOOTSTRAP_VERSION__' | $SUDO tee /home/cua/.cua-pi/bootstrap-version >/dev/null
$SUDO chown cua:cua /home/cua/.cua-pi/bootstrap-version
$SUDO rm -f /tmp/cua-tailscale-auth-key /tmp/cua-pi-agent.tgz
tailscale ip -4 | head -n 1
