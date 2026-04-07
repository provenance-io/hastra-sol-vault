#!/bin/bash
# deploy.sh - Part 2: Build programs, write upgrade buffers for Squads multisig,
# initialize programs, and set token authorities.
#
# Programs are NOT deployed directly. Instead, a buffer is written on-chain and
# the buffer address is provided for use in a Squads program upgrade proposal.
# This ensures every deployment goes through the M-of-N multisig approval process.
#
# Typical flow for a new environment:
#   1. Run setup-tokens.sh to create tokens and accounts.
#   2. Run this script → Build Programs → Write Buffers → copy buffer addresses to Squads.
#   3. After Squads executes the upgrade, run Initialize (Mint then Stake PRIME, then Stake AUTO).
#   4. Set Mint and Freeze Authorities (mint, PRIME stake, AUTO stake).
#
# Typical flow for an upgrade:
#   1. Run this script → Build Programs → Write Buffers.
#   2. Create a program upgrade proposal in Squads using the buffer addresses.
#   3. Collect M-of-N approvals and execute via Squads.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

source ./common.sh

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

copy_mint_prog_idl_types() {
  local default_type_dest="../../hastra-fi-nexus-flow/src/types/vault-mint.ts"
  local default_idl_dest="../../hastra-fi-nexus-flow/src/types/idl/vault-mint.ts"
  echo ""
  read -p "Enter destination for vault_mint.ts TYPE [$default_type_dest]: " dest_type
  read -p "Enter destination for vault_mint.ts IDL  [$default_idl_dest]: " dest_idl
  echo ""
  dest_type="${dest_type:-$default_type_dest}"
  dest_idl="${dest_idl:-$default_idl_dest}"
  cp ../target/types/vault_mint.ts "$dest_type"
  echo "Copied to $dest_type"
  cp ../target/idl/vault_mint.json "$dest_idl"
  sed -i '' '1s/^/export const VaultMint = /' "$dest_idl"
  echo "Copied to $dest_idl"
}

copy_stake_prog_idl_types() {
  local default_type_dest="../../hastra-fi-nexus-flow/src/types/vault-stake.ts"
  local default_idl_dest="../../hastra-fi-nexus-flow/src/types/idl/vault-stake.ts"
  echo ""
  read -p "Enter destination for vault_stake.ts TYPE [$default_type_dest]: " dest_type
  read -p "Enter destination for vault_stake.ts IDL  [$default_idl_dest]: " dest_idl
  echo ""
  dest_type="${dest_type:-$default_type_dest}"
  dest_idl="${dest_idl:-$default_idl_dest}"
  cp ../target/types/vault_stake.ts "$dest_type"
  echo "Copied to $dest_type"
  cp ../target/idl/vault_stake.json "$dest_idl"
  sed -i '' '1s/^/export const VaultStake = /' "$dest_idl"
  echo "Copied to $dest_idl"
}

copy_stake_auto_prog_idl_types() {
  local default_type_dest="../../hastra-fi-nexus-flow/src/types/vault-stake-auto.ts"
  local default_idl_dest="../../hastra-fi-nexus-flow/src/types/idl/vault-stake-auto.ts"
  echo ""
  read -p "Enter destination for vault_stake_auto.ts TYPE [$default_type_dest]: " dest_type
  read -p "Enter destination for vault_stake_auto.ts IDL  [$default_idl_dest]: " dest_idl
  echo ""
  dest_type="${dest_type:-$default_type_dest}"
  dest_idl="${dest_idl:-$default_idl_dest}"
  cp ../target/types/vault_stake_auto.ts "$dest_type"
  echo "Copied to $dest_type"
  cp ../target/idl/vault_stake_auto.json "$dest_idl"
  sed -i '' '1s/^/export const VaultStakeAuto = /' "$dest_idl"
  echo "Copied to $dest_idl"
}

build_programs() {
  anchor build
  copy_mint_prog_idl_types
  copy_stake_prog_idl_types
  copy_stake_auto_prog_idl_types
}

# ---------------------------------------------------------------------------
# Write program buffers (for Squads upgrade proposals)
# ---------------------------------------------------------------------------

_write_buffer() {
  local so_file="$1"
  local label="$2"
  local buffer_var="$3"

  echo ""
  echo "Writing $label to buffer..."
  echo "Program file: $so_file"

  local hash
  hash=$(sha256_file "$so_file")
  echo "SHA-256: $hash"

  local buffer_output
  buffer_output=$(solana program write-buffer "$so_file" \
    --url "$SOLANA_URL" \
    --keypair "$KEYPAIR" 2>&1)

  local buffer_address
  buffer_address=$(echo "$buffer_output" | grep -oE 'Buffer: ([A-Za-z0-9]+)' | awk '{print $NF}')

  if [ -z "$buffer_address" ]; then
    echo "ERROR: Failed to write buffer."
    echo "$buffer_output"
    return 1
  fi

  eval "$buffer_var=\"$buffer_address\""
  update_history_var "$buffer_var"

  echo ""
  echo "============================================================"
  echo "  $label Buffer Written"
  echo "============================================================"
  echo "  Buffer Address : $buffer_address"
  echo "  SHA-256        : $hash"
  echo "============================================================"
  echo ""
  echo "Next steps:"
  echo "  1. Verify the SHA-256 above matches the GitHub release artifact."
  echo "  2. Go to devnet.squads.so (or squads.so for mainnet)."
  echo "  3. Create a Program Upgrade proposal using:"
  echo "       Buffer Address : $buffer_address"
  echo "       Program ID     : (shown in header above)"
  echo "       Buffer Refund  : your wallet address"
  echo "  4. Collect M-of-N approvals and execute."
  echo ""

  if [ -n "$SQUADS_VAULT_ADDRESS" ]; then
    echo "  Optionally transfer buffer authority to Squads vault now:"
    echo "  solana program set-buffer-authority $buffer_address \\"
    echo "    --new-buffer-authority $SQUADS_VAULT_ADDRESS \\"
    echo "    --url $SOLANA_URL"
    echo ""
    read -p "Transfer buffer authority to Squads vault now? [y/N]: " transfer
    if [[ "$transfer" =~ ^[Yy]$ ]]; then
      solana program set-buffer-authority "$buffer_address" \
        --new-buffer-authority "$SQUADS_VAULT_ADDRESS" \
        --url "$SOLANA_URL" \
        --keypair "$KEYPAIR"
      echo "Buffer authority transferred to $SQUADS_VAULT_ADDRESS"
    fi
  else
    echo "  Tip: Set SQUADS_VAULT_ADDRESS in your history file to enable"
    echo "  automatic buffer authority transfer to your Squads vault."
  fi
}

write_mint_program_buffer() {
  _write_buffer "../target/deploy/vault_mint.so" "Vault Mint Program" "MINT_PROGRAM_BUFFER_ADDRESS"
}

write_stake_program_buffer() {
  _write_buffer "../target/deploy/vault_stake.so" "Vault Stake Program" "STAKE_PROGRAM_BUFFER_ADDRESS"
}

write_stake_auto_program_buffer() {
  _write_buffer "../target/deploy/vault_stake_auto.so" "Vault Stake Auto Program" "STAKE_AUTO_PROGRAM_BUFFER_ADDRESS"
}

write_all_buffers() {
  write_mint_program_buffer
  write_stake_program_buffer
  write_stake_auto_program_buffer
}

# ---------------------------------------------------------------------------
# Program initialization (run after Squads executes the first deploy)
# ---------------------------------------------------------------------------

initialize_mint_program() {
  if [ -z "$FREEZE_ADMINISTRATORS" ]; then
    prompt_with_default FREEZE_ADMINISTRATORS "Enter comma-separated list of Freeze Administrator addresses"
  fi
  if [ -z "$REWARDS_ADMINISTRATORS" ]; then
    prompt_with_default REWARDS_ADMINISTRATORS "Enter comma-separated list of Rewards Administrator addresses"
  fi
  if [ -z "$MINT_PROG_REDEEM_VAULT_TOKEN_ACCOUNT" ]; then
    prompt_with_default MINT_PROG_REDEEM_VAULT_TOKEN_ACCOUNT "Enter Redeem Vault Token Account address"
  fi
  if [ -z "$VAULT_STAKE_PROGRAM_ID" ]; then
    prompt_with_default VAULT_STAKE_PROGRAM_ID "Enter Stake Program ID allowed to call mint"
  fi

  INITIALIZE=$(
    yarn run ts-node scripts/vault-mint/initialize.ts \
    --vault "$MINT_PROG_VAULT_MINT" \
    --vault_token_account "$MINT_PROG_VAULT_TOKEN_ACCOUNT" \
    --redeem_vault_token_account "$MINT_PROG_REDEEM_VAULT_TOKEN_ACCOUNT" \
    --mint "$MINT_PROG_MINT_TOKEN" \
    --freeze_administrators "$FREEZE_ADMINISTRATORS" \
    --rewards_administrators "$REWARDS_ADMINISTRATORS" \
    --allow_mint_program_caller_id "$VAULT_STAKE_PROGRAM_ID")

  echo "$INITIALIZE"
}

initialize_stake_program() {
  if [ -z "$FREEZE_ADMINISTRATORS" ]; then
    prompt_with_default FREEZE_ADMINISTRATORS "Enter comma-separated list of Freeze Administrator addresses"
  fi
  if [ -z "$REWARDS_ADMINISTRATORS" ]; then
    prompt_with_default REWARDS_ADMINISTRATORS "Enter comma-separated list of Rewards Administrator addresses"
  fi
  if [ -z "$STAKE_PROG_MINT_TOKEN" ]; then
    prompt_with_default STAKE_PROG_MINT_TOKEN "Enter Stake Program mint token (staking token minted, PRIME)"
  fi

  INITIALIZE=$(
    yarn run ts-node scripts/vault-stake/initialize.ts \
    --vault "$MINT_PROG_MINT_TOKEN" \
    --vault_token_account "$STAKE_PROG_VAULT_TOKEN_ACCOUNT" \
    --mint "$STAKE_PROG_MINT_TOKEN" \
    --freeze_administrators "$FREEZE_ADMINISTRATORS" \
    --rewards_administrators "$REWARDS_ADMINISTRATORS")

  echo "$INITIALIZE"
}

initialize_stake_auto_program() {
  if [ -z "$FREEZE_ADMINISTRATORS" ]; then
    prompt_with_default FREEZE_ADMINISTRATORS "Enter comma-separated list of Freeze Administrator addresses"
  fi
  if [ -z "$REWARDS_ADMINISTRATORS" ]; then
    prompt_with_default REWARDS_ADMINISTRATORS "Enter comma-separated list of Rewards Administrator addresses"
  fi
  if [ -z "$STAKE_AUTO_PROG_MINT_TOKEN" ]; then
    prompt_with_default STAKE_AUTO_PROG_MINT_TOKEN "Enter Stake Program (AUTO) mint token (staking share mint)"
  fi
  if [ -z "$STAKE_AUTO_PROG_VAULT_TOKEN_ACCOUNT" ]; then
    prompt_with_default STAKE_AUTO_PROG_VAULT_TOKEN_ACCOUNT "Enter Stake Program (AUTO) vault token account (wYLDS pool vault)"
  fi

  INITIALIZE=$(
    yarn run ts-node scripts/vault-stake-auto/initialize.ts \
    --vault "$MINT_PROG_MINT_TOKEN" \
    --vault_token_account "$STAKE_AUTO_PROG_VAULT_TOKEN_ACCOUNT" \
    --mint "$STAKE_AUTO_PROG_MINT_TOKEN" \
    --freeze_administrators "$FREEZE_ADMINISTRATORS" \
    --rewards_administrators "$REWARDS_ADMINISTRATORS")

  echo "$INITIALIZE"
}

# ---------------------------------------------------------------------------
# Set token authorities to program PDAs
# ---------------------------------------------------------------------------

set_mint_prog_mint_and_freeze_authority() {
  MINT_PROG_MINT_AUTHORITY_PDA=$(get_pda "$VAULT_MINT_PROGRAM_ID" "mint_authority")
  MINT_PROG_FREEZE_AUTHORITY_PDA=$(get_pda "$VAULT_MINT_PROGRAM_ID" "freeze_authority")

  echo "Setting Mint Program mint authority to $MINT_PROG_MINT_AUTHORITY_PDA"
  spl-token authorize "$MINT_PROG_MINT_TOKEN" mint "$MINT_PROG_MINT_AUTHORITY_PDA" \
    --url "$SOLANA_URL" \
    --authority "$KEYPAIR"

  echo "Setting Mint Program freeze authority to $MINT_PROG_FREEZE_AUTHORITY_PDA"
  spl-token authorize "$MINT_PROG_MINT_TOKEN" freeze "$MINT_PROG_FREEZE_AUTHORITY_PDA" \
    --url "$SOLANA_URL" \
    --authority "$KEYPAIR"
}

set_stake_prog_mint_and_freeze_authority() {
  STAKE_PROG_MINT_AUTHORITY_PDA=$(get_pda "$VAULT_STAKE_PROGRAM_ID" "mint_authority")
  STAKE_PROG_FREEZE_AUTHORITY_PDA=$(get_pda "$VAULT_STAKE_PROGRAM_ID" "freeze_authority")

  echo "Setting Stake Program mint authority to $STAKE_PROG_MINT_AUTHORITY_PDA"
  spl-token authorize "$STAKE_PROG_MINT_TOKEN" mint "$STAKE_PROG_MINT_AUTHORITY_PDA" \
    --url "$SOLANA_URL" \
    --authority "$KEYPAIR"

  echo "Setting Stake Program freeze authority to $STAKE_PROG_FREEZE_AUTHORITY_PDA"
  spl-token authorize "$STAKE_PROG_MINT_TOKEN" freeze "$STAKE_PROG_FREEZE_AUTHORITY_PDA" \
    --url "$SOLANA_URL" \
    --authority "$KEYPAIR"
}

set_stake_auto_prog_mint_and_freeze_authority() {
  STAKE_AUTO_PROG_MINT_AUTHORITY_PDA=$(get_pda "$VAULT_STAKE_AUTO_PROGRAM_ID" "mint_authority")
  STAKE_AUTO_PROG_FREEZE_AUTHORITY_PDA=$(get_pda "$VAULT_STAKE_AUTO_PROGRAM_ID" "freeze_authority")

  echo "Setting Stake Program (AUTO) mint authority to $STAKE_AUTO_PROG_MINT_AUTHORITY_PDA"
  spl-token authorize "$STAKE_AUTO_PROG_MINT_TOKEN" mint "$STAKE_AUTO_PROG_MINT_AUTHORITY_PDA" \
    --url "$SOLANA_URL" \
    --authority "$KEYPAIR"

  echo "Setting Stake Program (AUTO) freeze authority to $STAKE_AUTO_PROG_FREEZE_AUTHORITY_PDA"
  spl-token authorize "$STAKE_AUTO_PROG_MINT_TOKEN" freeze "$STAKE_AUTO_PROG_FREEZE_AUTHORITY_PDA" \
    --url "$SOLANA_URL" \
    --authority "$KEYPAIR"
}

configure_squads_vault() {
  prompt_with_default SQUADS_VAULT_ADDRESS "Enter Squads vault address (used as upgrade authority)"
}

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
while true; do
  MY_KEY=$(solana-keygen pubkey "$KEYPAIR")
  VAULT_MINT_PROGRAM_ID=$(grep -oE 'declare_id!\("([A-Za-z0-9]+)"\);' ../programs/vault-mint/src/lib.rs | grep -oE '"([A-Za-z0-9]+)"' | tr -d '"')
  VAULT_STAKE_PROGRAM_ID=$(grep -oE 'declare_id!\("([A-Za-z0-9]+)"\);' ../programs/vault-stake/src/lib.rs | grep -oE '"([A-Za-z0-9]+)"' | tr -d '"')
  VAULT_STAKE_AUTO_PROGRAM_ID=$(grep -oE 'declare_id!\("([A-Za-z0-9]+)"\);' ../programs/vault-stake-auto/src/lib.rs | grep -oE '"([A-Za-z0-9]+)"' | tr -d '"')

  SOL_BALANCE=$(solana balance --url "$SOLANA_URL" --keypair "$KEYPAIR" 2>/dev/null || echo "0 SOL")
  solana config get
  echo ""
  echo "Public Key:                   $MY_KEY ($SOL_BALANCE)"
  echo "Vault Mint Program ID:        $VAULT_MINT_PROGRAM_ID"
  echo "Vault Stake Program ID (PRIME): $VAULT_STAKE_PROGRAM_ID"
  echo "Vault Stake Program ID (AUTO):  $VAULT_STAKE_AUTO_PROGRAM_ID"
  echo "Mint Token (wYLDS):           $MINT_PROG_MINT_TOKEN"
  echo "Vault Token (USDC):           $MINT_PROG_VAULT_MINT"
  echo "Staking Token (PRIME):        $STAKE_PROG_MINT_TOKEN"
  echo "Staking Token (AUTO):         ${STAKE_AUTO_PROG_MINT_TOKEN:-<not set>}"
  echo "Squads Vault:                 ${SQUADS_VAULT_ADDRESS:-<not set>}"
  echo "Mint Buffer:                  ${MINT_PROGRAM_BUFFER_ADDRESS:-<none>}"
  echo "Stake Buffer (PRIME):         ${STAKE_PROGRAM_BUFFER_ADDRESS:-<none>}"
  echo "Stake Buffer (AUTO):          ${STAKE_AUTO_PROGRAM_BUFFER_ADDRESS:-<none>}"
  echo ""

  echo "Select an action:"
  select opt in \
    "Build Programs" \
    "Write Vault Mint Buffer (for Squads upgrade)" \
    "Write Vault Stake Buffer (for Squads upgrade)" \
    "Write Vault Stake Auto Buffer (for Squads upgrade)" \
    "Write All Buffers" \
    "Initialize Mint Program" \
    "Initialize Stake Program (PRIME)" \
    "Initialize Stake Program (AUTO)" \
    "Set Mint Program Mint and Freeze Authorities" \
    "Set Stake Program (PRIME) Mint and Freeze Authorities" \
    "Set Stake Program (AUTO) Mint and Freeze Authorities" \
    "Configure Squads Vault Address" \
    "Show Accounts & PDAs" \
    "Exit"
  do
    case $REPLY in
      1)  build_programs; break ;;
      2)  write_mint_program_buffer; break ;;
      3)  write_stake_program_buffer; break ;;
      4)  write_stake_auto_program_buffer; break ;;
      5)  write_all_buffers; break ;;
      6)  initialize_mint_program; break ;;
      7)  initialize_stake_program; break ;;
      8)  initialize_stake_auto_program; break ;;
      9)  set_mint_prog_mint_and_freeze_authority; break ;;
      10) set_stake_prog_mint_and_freeze_authority; break ;;
      11) set_stake_auto_prog_mint_and_freeze_authority; break ;;
      12) configure_squads_vault; break ;;
      13) show_accounts_and_pdas; break ;;
      14) exit 0 ;;
      *) echo "Invalid option"; break ;;
    esac
  done
done
