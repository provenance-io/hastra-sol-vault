#!/usr/bin/env bash
# Helpers for localnet builds: keep declare_id! / Anchor.toml aligned with
# target/deploy keypairs while hiding ephemeral IDs from git status/commits.

LOCALNET_PROGRAM_ID_FILES=(
  programs/vault-mint/src/lib.rs
  programs/vault-stake/src/lib.rs
  Anchor.toml
)

localnet_program_ids_in_git_repo() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1
}

localnet_program_ids_skip_worktree() {
  if ! localnet_program_ids_in_git_repo; then
    return 0
  fi
  for f in "${LOCALNET_PROGRAM_ID_FILES[@]}"; do
    git update-index --skip-worktree "$f"
  done
}

localnet_program_ids_no_skip_worktree() {
  if ! localnet_program_ids_in_git_repo; then
    return 0
  fi
  for f in "${LOCALNET_PROGRAM_ID_FILES[@]}"; do
    git update-index --no-skip-worktree "$f" 2>/dev/null || true
  done
}

localnet_program_ids_sync() {
  anchor keys sync
}
