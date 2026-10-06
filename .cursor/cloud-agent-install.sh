#!/usr/bin/env bash
set -euo pipefail

cd /workspace

export PATH="/home/ubuntu/.local/share/solana/install/active_release/bin:/usr/local/cargo/bin:${PATH}"

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
  if ! command -v solana >/dev/null 2>&1; then
    sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
  fi
  sudo ln -sf /home/ubuntu/.local/share/solana/install/active_release/bin/solana /usr/local/bin/solana
  sudo ln -sf /home/ubuntu/.local/share/solana/install/active_release/bin/solana-test-validator /usr/local/bin/solana-test-validator
  sudo ln -sf /home/ubuntu/.local/share/solana/install/active_release/bin/solana-keygen /usr/local/bin/solana-keygen
  sudo ln -sf /home/ubuntu/.local/share/solana/install/active_release/bin/cargo-build-sbf /usr/local/bin/cargo-build-sbf
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
  anchor keys sync
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
