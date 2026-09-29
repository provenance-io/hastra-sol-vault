#!/bin/bash
# common.sh - Shared configuration, helpers, and utility functions.
# Sourced by setup-tokens.sh and deploy.sh. Do not run directly.

prompt_with_default_no_history() {
  local varname="$1"
  local prompt="$2"
  local default="${!varname}"
  read -p "$prompt [$default]: " input
  if [ -n "$input" ]; then
    eval "$varname=\"$input\""
  fi
}

update_history_var() {
  local varname="$1"
  local value="${!varname}"
  sed -i.bak "/^$varname=/d" "$HISTORY_FILE"
  echo "$varname=\"$value\"" >> "$HISTORY_FILE"
}

prompt_with_default() {
  local varname="$1"
  local prompt="$2"
  local default="${!varname}"
  read -p "$prompt [$default]: " input
  if [ -n "$input" ]; then
    eval "$varname=\"$input\""
  else
    eval "$varname=\"$default\""
  fi
  update_history_var "$varname"
}

# ---------------------------------------------------------------------------
# Network selection and history file
# ---------------------------------------------------------------------------
prompt_with_default_no_history SOLANA_NETWORK "Select Solana network (localnet, devnet, mainnet-beta, testnet)"

HISTORY_FILE="${SOLANA_NETWORK}_vault.history"

if [ -f "$HISTORY_FILE" ]; then
  source "$HISTORY_FILE"
fi

if [ ! -f "$HISTORY_FILE" ]; then
  touch "$HISTORY_FILE"
fi

# ---------------------------------------------------------------------------
# Load keypair and RPC URL from Solana CLI config
# ---------------------------------------------------------------------------
CONFIG_FILE="$HOME/.config/solana/cli/config.yml"
if [ -f "$CONFIG_FILE" ]; then
  SOLANA_KEYPAIR=$(grep 'keypair_path:' "$CONFIG_FILE" | awk '{print $2}')
  if [ -z "$KEYPAIR" ]; then
    KEYPAIR="$SOLANA_KEYPAIR"
    update_history_var "KEYPAIR"
  fi
  JSON_RPC_URL=$(grep 'json_rpc_url:' "$CONFIG_FILE" | awk '{print $2}')
  if [ -z "$SOLANA_URL" ]; then
    SOLANA_URL="$JSON_RPC_URL"
    update_history_var "SOLANA_URL"
  fi
fi

echo "Solana Keypair from config: $KEYPAIR"
echo "Solana RPC URL from config: $SOLANA_URL"

prompt_with_default KEYPAIR "Enter path to Solana wallet keypair"
prompt_with_default SOLANA_URL "Enter Solana RPC URL"

if [ -z "$MINT_PROG_VAULT_MINT" ]; then
  prompt_with_default MINT_PROG_VAULT_MINT "Enter Mint Program's vaulted token mint (i.e. USDC)"
fi

if [ -z "$MINT_PROG_VAULT_TOKEN_ACCOUNT" ]; then
  prompt_with_default MINT_PROG_VAULT_TOKEN_ACCOUNT "Enter Mint Program's vaulted token ATA (i.e. account that will hold USDC deposits)"
fi

export ANCHOR_PROVIDER_URL="$SOLANA_URL"
export ANCHOR_WALLET="$KEYPAIR"

# ---------------------------------------------------------------------------
# PDA / ATA helpers
# ---------------------------------------------------------------------------
get_pda() {
  local program_id="$1"
  local seed="$2"
  local pda=$(yarn run --silent ts-node scripts/derive_address.ts --type pda --program_id "$program_id" --seed "$seed")
  echo "$pda"
}

get_mint_program_config_pda() {
  local program_id="$1"
  local pda=$(yarn run --silent ts-node scripts/vault-mint/derive_vault_token_account_config.ts --program_id "$program_id")
  echo "$pda"
}

get_stake_program_config_pda() {
  local program_id="$1"
  local pda=$(yarn run --silent ts-node scripts/vault-stake/derive_stake_vault_token_account_config.ts --program_id "$program_id")
  echo "$pda"
}

get_stake_auto_program_config_pda() {
  local program_id="$1"
  local pda=$(yarn run --silent ts-node scripts/vault-stake/derive_stake_vault_token_account_config.ts --program_id "$program_id")
  echo "$pda"
}

show_stake_price_config() {
  local program_id="$1"
  if [ -n "$program_id" ]; then
    yarn run --silent ts-node scripts/vault-stake/show_stake_price_config.ts --program_id "$program_id"
  else
    yarn run --silent ts-node scripts/vault-stake/show_stake_price_config.ts
  fi
}

show_stake_auto_price_config() {
  local program_id="$1"
  show_stake_price_config "$program_id"
}

get_ata() {
  local mint="$1"
  local owner="$2"
  local ata=$(yarn run --silent ts-node scripts/derive_address.ts --type ata --mint "$mint" --public_key "$owner")
  echo "$ata"
}

get_stake_reward_config_pda() {
  local program_id="$1"
  # The derive script prints multiple labeled lines; extract the last field from the
  # "StakeRewardConfig PDA:" line so `show_accounts_and_pdas` can print a single value.
  yarn run --silent ts-node scripts/vault-stake/derive_stake_reward_config.ts --program_id "$program_id" \
    | awk '/StakeRewardConfig PDA:/ { print $NF }'
}

get_program_id_from_anchor_deploy() {
  local program_slug="$1"
  local keypair_path="../target/deploy/${program_slug}-keypair.json"
  if [ -f "$keypair_path" ]; then
    solana address -k "$keypair_path" 2>/dev/null
  fi
}

get_program_id_from_anchor_toml() {
  local program_slug="$1"
  local anchor_toml_path="../Anchor.toml"
  local cluster="$SOLANA_NETWORK"
  local program_key="${program_slug//_/-}"

  if [ ! -f "$anchor_toml_path" ] || [ -z "$cluster" ]; then
    return 0
  fi

  awk -v section="[programs.${cluster}]" -v key="$program_key" '
    /^\[.*\]$/ {
      in_section = ($0 == section)
      next
    }
    in_section && $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      if (match($0, /"[^"]+"/)) {
        value = substr($0, RSTART + 1, RLENGTH - 2)
        if (length(value) > 0) {
          print value
          exit
        }
      }
    }
  ' "$anchor_toml_path"
}

get_program_id_from_lib_rs() {
  local program_lib_rs="$1"
  if [ -f "$program_lib_rs" ]; then
    grep -oE 'declare_id!\("([A-Za-z0-9]+)"\);' "$program_lib_rs" | grep -oE '"([A-Za-z0-9]+)"' | tr -d '"'
  fi
}

resolve_program_id() {
  local program_slug="$1"
  local program_lib_rs="$2"
  local program_id
  program_id=$(get_program_id_from_anchor_toml "$program_slug")
  if [ -n "$program_id" ]; then
    echo "$program_id"
    return 0
  fi
  program_id=$(get_program_id_from_anchor_deploy "$program_slug")
  if [ -n "$program_id" ]; then
    echo "$program_id"
    return 0
  fi
  get_program_id_from_lib_rs "$program_lib_rs"
}

# ---------------------------------------------------------------------------
# Cross-platform sha256
# ---------------------------------------------------------------------------
sha256_file() {
  local file="$1"
  if command -v sha256sum &> /dev/null; then
    sha256sum "$file" | awk '{print $1}'
  else
    shasum -a 256 "$file" | awk '{print $1}'
  fi
}

# ---------------------------------------------------------------------------
# Show all relevant accounts and PDAs
# ---------------------------------------------------------------------------
show_accounts_and_pdas() {
  VAULT_MINT_PROGRAM_ID=$(resolve_program_id "vault_mint" "../programs/vault-mint/src/lib.rs")
  VAULT_STAKE_PROGRAM_ID=$(resolve_program_id "vault_stake" "../programs/vault-stake/src/lib.rs")
  VAULT_STAKE_AUTO_PROGRAM_ID=$(resolve_program_id "vault_stake_auto" "../programs/vault-stake-auto/src/lib.rs")

  echo ""
  echo "Mint Program:"
  echo "Program ID:                               $VAULT_MINT_PROGRAM_ID"
  echo "Vault Token (accepted token, i.e. USDC):  $MINT_PROG_VAULT_MINT"
  echo "Mint Token (token minted, wYLDS):         $MINT_PROG_MINT_TOKEN"
  echo "Vault Token Account:                      $MINT_PROG_VAULT_TOKEN_ACCOUNT"
  echo "Config PDA:                               $(get_pda "$VAULT_MINT_PROGRAM_ID" "config")"
  echo "Vault Token Account Config PDA:           $(get_mint_program_config_pda "$VAULT_MINT_PROGRAM_ID")"
  echo "Mint Authority PDA:                       $(get_pda "$VAULT_MINT_PROGRAM_ID" "mint_authority")"
  echo "Freeze Authority PDA:                     $(get_pda "$VAULT_MINT_PROGRAM_ID" "freeze_authority")"
  echo "Freeze Administrators:                    $FREEZE_ADMINISTRATORS"
  echo "Rewards Administrators:                   $REWARDS_ADMINISTRATORS"
  echo "Redeem Vault Token Account:               $MINT_PROG_REDEEM_VAULT_TOKEN_ACCOUNT"
  echo "Redeem Vault Authority PDA:               $(get_pda "$VAULT_MINT_PROGRAM_ID" "redeem_vault_authority")"
  echo "Legacy allowed external mint program:     $VAULT_STAKE_PROGRAM_ID"

  echo ""
  echo "Stake Program (PRIME pool):"
  echo "Program ID:                               $VAULT_STAKE_PROGRAM_ID"
  echo "Vault Token (accepted token, i.e. wYLDS): $MINT_PROG_MINT_TOKEN"
  echo "Mint Token (token minted, PRIME):         $STAKE_PROG_MINT_TOKEN"
  echo "Vault Token Account:                      $STAKE_PROG_VAULT_TOKEN_ACCOUNT"
  echo "Vault Authority:                          $(get_pda "$VAULT_STAKE_PROGRAM_ID" "vault_authority")"
  echo "Config PDA:                               $(get_pda "$VAULT_STAKE_PROGRAM_ID" "stake_config")"
  echo "Stake Vault Token Account Config PDA:     $(get_stake_program_config_pda "$VAULT_STAKE_PROGRAM_ID")"
  echo "Stake Reward Config PDA:                  $(get_stake_reward_config_pda "$VAULT_STAKE_PROGRAM_ID")"
  echo "Mint Authority PDA:                       $(get_pda "$VAULT_STAKE_PROGRAM_ID" "mint_authority")"
  echo "Freeze Authority PDA:                     $(get_pda "$VAULT_STAKE_PROGRAM_ID" "freeze_authority")"
  echo "Freeze Administrators:                    $FREEZE_ADMINISTRATORS"
  echo "Rewards Administrators:                   $REWARDS_ADMINISTRATORS"

  echo ""
  echo "Stake Program (AUTO pool):"
  echo "Program ID:                               $VAULT_STAKE_AUTO_PROGRAM_ID"
  echo "Vault Token (accepted token, i.e. wYLDS): $MINT_PROG_MINT_TOKEN"
  echo "Mint Token (token minted, AUTO):          $STAKE_AUTO_PROG_MINT_TOKEN"
  echo "Vault Token Account:                      $STAKE_AUTO_PROG_VAULT_TOKEN_ACCOUNT"
  echo "Vault Authority:                          $(get_pda "$VAULT_STAKE_AUTO_PROGRAM_ID" "vault_authority")"
  echo "Config PDA:                               $(get_pda "$VAULT_STAKE_AUTO_PROGRAM_ID" "stake_config")"
  echo "Stake Vault Token Account Config PDA:     $(get_stake_auto_program_config_pda "$VAULT_STAKE_AUTO_PROGRAM_ID")"
  echo "Stake Reward Config PDA:                  $(get_stake_reward_config_pda "$VAULT_STAKE_AUTO_PROGRAM_ID")"
  echo "Mint Authority PDA:                       $(get_pda "$VAULT_STAKE_AUTO_PROGRAM_ID" "mint_authority")"
  echo "Freeze Authority PDA:                     $(get_pda "$VAULT_STAKE_AUTO_PROGRAM_ID" "freeze_authority")"
  echo "Freeze Administrators:                    $FREEZE_ADMINISTRATORS"
  echo "Rewards Administrators:                   $REWARDS_ADMINISTRATORS"

  echo ""
  echo "Stake Price Config (PRIME pool):"
  show_stake_price_config "$VAULT_STAKE_PROGRAM_ID"

  echo ""
  echo "Stake Price Config (AUTO pool):"
  show_stake_auto_price_config "$VAULT_STAKE_AUTO_PROGRAM_ID"
}
