#!/usr/bin/env bash
set -euo pipefail

cd /workspace

export PATH="/home/ubuntu/.local/share/solana/install/active_release/bin:/usr/local/cargo/bin:${PATH}"

# Same source as CI: solana-foundation/github-actions extract-versions (solana-program in Cargo.lock).
solana_cli_version_from_lock() {
  grep -A 2 'name = "solana-program"' Cargo.lock | grep 'version' | head -n 1 | cut -d'"' -f2
}

install_apt_deps() {
  if ! dpkg -s libudev-dev >/dev/null 2>&1; then
    sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
      build-essential pkg-config libudev-dev llvm libclang-dev \
      protobuf-compiler libssl-dev curl git xz-utils
  fi
}

install_rust() {
  if ! rustc --version 2>/dev/null | grep -q '1.90.0'; then
    rustup toolchain install 1.90.0 --no-self-update
    rustup default 1.90.0
  fi
}

install_solana_cli() {
  local required_version current major minor patch install_url
  required_version="$(solana_cli_version_from_lock)"
  if [[ -z "${required_version}" ]]; then
    echo "cloud-agent-install: could not read solana-program version from Cargo.lock" >&2
    exit 1
  fi

  current=""
  if command -v solana >/dev/null 2>&1; then
    current="$(solana --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  fi

  if [[ "${current}" != "${required_version}" ]]; then
    major="$(echo "${required_version}" | cut -d. -f1)"
    minor="$(echo "${required_version}" | cut -d. -f2)"
    patch="$(echo "${required_version}" | cut -d. -f3)"
    if [[ "${major}" -eq 1 && "${minor}" -eq 18 && "${patch}" -le 23 ]]; then
      install_url="https://release.solana.com/v${required_version}/install"
    else
      install_url="https://release.anza.xyz/v${required_version}/install"
    fi
    echo "cloud-agent-install: installing Solana CLI v${required_version} from ${install_url}"
    sh -c "$(curl -sSfL "${install_url}")"
  fi

  sudo ln -sf /home/ubuntu/.local/share/solana/install/active_release/bin/solana /usr/local/bin/solana
  sudo ln -sf /home/ubuntu/.local/share/solana/install/active_release/bin/solana-test-validator /usr/local/bin/solana-test-validator
  sudo ln -sf /home/ubuntu/.local/share/solana/install/active_release/bin/solana-keygen /usr/local/bin/solana-keygen
  sudo ln -sf /home/ubuntu/.local/share/solana/install/active_release/bin/cargo-build-sbf /usr/local/bin/cargo-build-sbf

  current="$(solana --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  if [[ "${current}" != "${required_version}" ]]; then
    echo "cloud-agent-install: expected Solana CLI ${required_version}, got ${current:-none}" >&2
    exit 1
  fi
}

install_anchor() {
  if ! command -v avm >/dev/null 2>&1; then
    cargo install --git https://github.com/coral-xyz/anchor --tag v0.31.1 avm --locked --force
    sudo ln -sf /usr/local/cargo/bin/avm /usr/local/bin/avm
  fi
  avm install 0.31.1
  avm use 0.31.1
  sudo ln -sf /home/ubuntu/.avm/bin/anchor-0.31.1 /usr/local/bin/anchor
}

build_programs() {
  yarn install --frozen-lockfile
  mkdir -p target/deploy
  cargo build-sbf --force-tools-install --manifest-path programs/vault-mint/Cargo.toml
  anchor build -- --features testing
  (cd programs/vault-stake && cargo build-sbf --features testing)
}

install_apt_deps
install_rust
install_solana_cli
install_anchor
build_programs

echo "cloud-agent-install: OK"
