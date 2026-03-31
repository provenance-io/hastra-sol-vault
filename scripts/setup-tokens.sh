#!/bin/bash
# setup-tokens.sh - Part 1: Create tokens, token accounts, and Metaplex metadata.
# Run this before deploy.sh when setting up a new deployment environment.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

source ./common.sh

# ---------------------------------------------------------------------------
# Token and account creation
# ---------------------------------------------------------------------------

create_mint_prog_mint_token() {
  echo "Creating Mint Program mint token..."
  MINT_PROG_MINT_TOKEN=$(spl-token create-token --decimals 6 --enable-freeze \
    --url "$SOLANA_URL" \
    --config "$CONFIG_FILE" | grep -oE 'Address:  ([A-Za-z0-9]+)' | awk '{print $NF}')
  echo "Mint Program mint token: $MINT_PROG_MINT_TOKEN"
  update_history_var "MINT_PROG_MINT_TOKEN"
}

create_stake_prog_mint_token() {
  echo "Creating Stake Program mint token (PRIME)..."
  STAKE_PROG_MINT_TOKEN=$(spl-token create-token --decimals 6 --enable-freeze \
    --url "$SOLANA_URL" \
    --config "$CONFIG_FILE" | grep -oE 'Address:  ([A-Za-z0-9]+)' | awk '{print $NF}')
  echo "Stake Program mint token: $STAKE_PROG_MINT_TOKEN"
  update_history_var "STAKE_PROG_MINT_TOKEN"
}

create_mint_prog_redeem_vault_token_account() {
  echo "Creating Mint Program redeem vault ATA..."
  MINT_PROG_REDEEM_VAULT_TOKEN_ACCOUNT=$(spl-token create-account "$MINT_PROG_VAULT_MINT" \
    --owner "$KEYPAIR" \
    --url "$SOLANA_URL" | grep -oE 'Creating account.* ([A-Za-z0-9]+)' | awk '{print $NF}')
  echo "Mint Program redeem vault ATA: $MINT_PROG_REDEEM_VAULT_TOKEN_ACCOUNT"
  update_history_var "MINT_PROG_REDEEM_VAULT_TOKEN_ACCOUNT"
}

create_stake_prog_vault_token_account() {
  echo "Creating Stake Program vault token ATA..."
  STAKE_PROG_VAULT_TOKEN_ACCOUNT=$(spl-token create-account "$MINT_PROG_MINT_TOKEN" \
    --owner "$KEYPAIR" \
    --url "$SOLANA_URL" | grep -oE 'Creating account.* ([A-Za-z0-9]+)' | awk '{print $NF}')
  echo "Stake Program vault token ATA: $STAKE_PROG_VAULT_TOKEN_ACCOUNT"
  update_history_var "STAKE_PROG_VAULT_TOKEN_ACCOUNT"
}

create_stake_auto_prog_mint_token() {
  echo "Creating Stake Program mint token (AUTO)..."
  STAKE_AUTO_PROG_MINT_TOKEN=$(spl-token create-token --decimals 6 --enable-freeze \
    --url "$SOLANA_URL" \
    --config "$CONFIG_FILE" | grep -oE 'Address:  ([A-Za-z0-9]+)' | awk '{print $NF}')
  echo "Stake Program mint token (AUTO): $STAKE_AUTO_PROG_MINT_TOKEN"
  update_history_var "STAKE_AUTO_PROG_MINT_TOKEN"
}

create_stake_auto_prog_vault_token_account() {
  # The AUTO pool stakes the same wYLDS token as the PRIME pool.
  # A separate vault token account is required because each program controls
  # its own vault — the vault authority PDA is program-specific.
  echo "Creating Stake Program vault token ATA (AUTO - holds deposited wYLDS for Stake Program (AUTO) pool)..."
  STAKE_AUTO_PROG_VAULT_TOKEN_ACCOUNT=$(spl-token create-account "$MINT_PROG_MINT_TOKEN" \
    --owner "$KEYPAIR" \
    --url "$SOLANA_URL" | grep -oE 'Creating account.* ([A-Za-z0-9]+)' | awk '{print $NF}')
  echo "Stake Program vault token ATA (AUTO): $STAKE_AUTO_PROG_VAULT_TOKEN_ACCOUNT"
  update_history_var "STAKE_AUTO_PROG_VAULT_TOKEN_ACCOUNT"
}

setup_metaplex() {
  if [ -z "$MINT_METAPLEX_NAME" ]; then
    prompt_with_default MINT_METAPLEX_NAME "Enter Mint Token Metaplex Token Name"
  fi
  if [ -z "$MINT_METAPLEX_SYMBOL" ]; then
    prompt_with_default MINT_METAPLEX_SYMBOL "Enter Mint Token Metaplex Token Symbol"
  fi
  if [ -z "$MINT_METAPLEX_META_URL" ]; then
    prompt_with_default MINT_METAPLEX_META_URL "Enter Mint Token Metaplex Token Metadata URL (must be a valid JSON URL)"
  fi

  yarn run ts-node scripts/register_meta.ts \
    --mint "$MINT_PROG_MINT_TOKEN" \
    --keypair "$KEYPAIR" \
    --name "$MINT_METAPLEX_NAME" \
    --symbol "$MINT_METAPLEX_SYMBOL" \
    --token_meta_url "$MINT_METAPLEX_META_URL"

  if [ -z "$STAKE_METAPLEX_NAME" ]; then
    prompt_with_default STAKE_METAPLEX_NAME "Enter Stake Token (PRIME) Metaplex Token Name"
  fi
  if [ -z "$STAKE_METAPLEX_SYMBOL" ]; then
    prompt_with_default STAKE_METAPLEX_SYMBOL "Enter Stake Token (PRIME) Metaplex Token Symbol"
  fi
  if [ -z "$STAKE_METAPLEX_META_URL" ]; then
    prompt_with_default STAKE_METAPLEX_META_URL "Enter Stake Token (PRIME) Metaplex Token Metadata URL (must be a valid JSON URL)"
  fi

  yarn run ts-node scripts/register_meta.ts \
    --mint "$STAKE_PROG_MINT_TOKEN" \
    --keypair "$KEYPAIR" \
    --name "$STAKE_METAPLEX_NAME" \
    --symbol "$STAKE_METAPLEX_SYMBOL" \
    --token_meta_url "$STAKE_METAPLEX_META_URL"
}

setup_auto_metaplex() {
  if [ -z "$STAKE_AUTO_PROG_MINT_TOKEN" ]; then
    prompt_with_default STAKE_AUTO_PROG_MINT_TOKEN "Enter Stake Program mint token (AUTO) address"
  fi
  if [ -z "$STAKE_AUTO_METAPLEX_NAME" ]; then
    prompt_with_default STAKE_AUTO_METAPLEX_NAME "Enter Stake Program Token (AUTO) Metaplex Token Name"
  fi
  if [ -z "$STAKE_AUTO_METAPLEX_SYMBOL" ]; then
    prompt_with_default STAKE_AUTO_METAPLEX_SYMBOL "Enter Stake Program Token (AUTO) Metaplex Token Symbol"
  fi
  if [ -z "$STAKE_AUTO_METAPLEX_META_URL" ]; then
    prompt_with_default STAKE_AUTO_METAPLEX_META_URL "Enter Stake Program Token (AUTO) Metaplex Token Metadata URL (must be a valid JSON URL)"
  fi

  yarn run ts-node scripts/register_meta.ts \
    --mint "$STAKE_AUTO_PROG_MINT_TOKEN" \
    --keypair "$KEYPAIR" \
    --name "$STAKE_AUTO_METAPLEX_NAME" \
    --symbol "$STAKE_AUTO_METAPLEX_SYMBOL" \
    --token_meta_url "$STAKE_AUTO_METAPLEX_META_URL"
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
  echo "Vault Stake Program ID (PRIME):       $VAULT_STAKE_PROGRAM_ID"
  echo "Vault Stake Program ID (AUTO):  $VAULT_STAKE_AUTO_PROGRAM_ID"
  echo "Mint Token (wYLDS):           $MINT_PROG_MINT_TOKEN"
  echo "Vault Token (USDC):           $MINT_PROG_VAULT_MINT"
  echo "Staking Token (PRIME):        $STAKE_PROG_MINT_TOKEN"
  echo "Staking Token (AUTO):         $STAKE_AUTO_PROG_MINT_TOKEN"
  echo ""

  echo "Select an action:"
  select opt in \
    "Create Mint Token (wYLDS)" \
    "Create Stake Token (PRIME)" \
    "Create Stake Token (AUTO)" \
    "Create Mint Program Redeem Vault Token Account" \
    "Create Stake Program Vault Token Account (PRIME - uses wYLDS)" \
    "Create Stake Program Vault Token Account (AUTO — uses wYLDS)" \
    "Setup Metaplex Metadata (wYLDS + PRIME)" \
    "Setup Metaplex Metadata (wYLDS + AUTO)" \
    "Show Accounts & PDAs" \
    "Exit"
  do
    case $REPLY in
      1) create_mint_prog_mint_token; break ;;
      2) create_stake_prog_mint_token; break ;;
      3) create_stake_auto_prog_mint_token; break ;;
      4) create_mint_prog_redeem_vault_token_account; break ;;
      5) create_stake_prog_vault_token_account; break ;;
      6) create_stake_auto_prog_vault_token_account; break ;;
      7) setup_metaplex; break ;;
      8) setup_auto_metaplex; break ;;
      9) show_accounts_and_pdas; break ;;
      10) exit 0 ;;
      *) echo "Invalid option"; break ;;
    esac
  done
done
