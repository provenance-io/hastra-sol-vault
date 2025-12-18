#!/bin/bash

prompt_with_default_no_history() {
  local varname="$1"
  local prompt="$2"
  local default="${!varname}"
  read -p "$prompt [$default]: " input
  if [ -n "$input" ]; then
    eval "$varname=\"$input\""
  fi
}

prompt_with_default_no_history SOLANA_NETWORK "Select Solana network (localnet, devnet, mainnet-beta, testnet)"

HISTORY_FILE="${SOLANA_NETWORK}_vault.history"

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

# Load previous selections if history file exists
if [ -f "$HISTORY_FILE" ]; then
  source "$HISTORY_FILE"
fi

# Ensure history file exists
if [ ! -f "$HISTORY_FILE" ]; then
  touch "$HISTORY_FILE"
fi

# get the keypair and rpc url from solana config
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

get_ata() {
  local mint="$1"
  local owner="$2"
  local ata=$(yarn run --silent ts-node scripts/derive_address.ts --type ata --mint "$mint" --public_key "$owner")
  echo "$ata"
}

create_mint_prog_mint_token() {
  echo "Creating Mint Program mint token..."
  echo $SOLANA_URL
  MINT_PROG_MINT_TOKEN=$(spl-token create-token --decimals 6 --enable-freeze \
    --url "$SOLANA_URL" \
    --config "$CONFIG_FILE" | grep -oE 'Address:  ([A-Za-z0-9]+)' | awk '{print $NF}')
  echo "Mint Program mint token: $MINT_PROG_MINT_TOKEN"
  sed -i.bak "/^MINT_PROG_MINT_TOKEN=/d" "$HISTORY_FILE"
  echo "MINT_PROG_MINT_TOKEN=\"$MINT_PROG_MINT_TOKEN\"" >> "$HISTORY_FILE"
}

create_stake_prog_mint_token() {
  echo "Creating Stake Program mint token..."
  STAKE_PROG_MINT_TOKEN=$(spl-token create-token --decimals 6 --enable-freeze \
    --url "$SOLANA_URL" \
    --config "$CONFIG_FILE" | grep -oE 'Address:  ([A-Za-z0-9]+)' | awk '{print $NF}')
  echo "Stake Program mint token: $STAKE_PROG_MINT_TOKEN"
  sed -i.bak "/^STAKE_PROG_MINT_TOKEN=/d" "$HISTORY_FILE"
  echo "STAKE_PROG_MINT_TOKEN=\"$STAKE_PROG_MINT_TOKEN\"" >> "$HISTORY_FILE"
}

create_mint_prog_redeem_vault_token_account() {
  echo "Creating Mint Program mint redeem vault ATA..."
  MINT_PROG_REDEEM_VAULT_TOKEN_ACCOUNT=$(spl-token create-account "$MINT_PROG_VAULT_MINT" \
    --owner "$KEYPAIR" \
    --url "$SOLANA_URL" | grep -oE 'Creating account.* ([A-Za-z0-9]+)' | awk '{print $NF}')
  echo "Mint Program mint redeem vault ATA: $MINT_PROG_REDEEM_VAULT_TOKEN_ACCOUNT"
  sed -i.bak "/^MINT_PROG_REDEEM_VAULT_TOKEN_ACCOUNT=/d" "$HISTORY_FILE"
  echo "MINT_PROG_REDEEM_VAULT_TOKEN_ACCOUNT=\"$MINT_PROG_REDEEM_VAULT_TOKEN_ACCOUNT\"" >> "$HISTORY_FILE"
}

create_stake_prog_vault_token_account() {
    echo "Creating Stake Program vault token ATA..."
    STAKE_PROG_VAULT_TOKEN_ACCOUNT=$(spl-token create-account "$MINT_PROG_MINT_TOKEN" \
      --owner "$KEYPAIR" \
      --url "$SOLANA_URL" | grep -oE 'Creating account.* ([A-Za-z0-9]+)' | awk '{print $NF}')
    echo "Stake Program vault token ATA: $STAKE_PROG_VAULT_TOKEN_ACCOUNT"
    sed -i.bak "/^STAKE_PROG_VAULT_TOKEN_ACCOUNT=/d" "$HISTORY_FILE"
    echo "STAKE_PROG_VAULT_TOKEN_ACCOUNT=\"$STAKE_PROG_VAULT_TOKEN_ACCOUNT\"" >> "$HISTORY_FILE"
}

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
  # add TS const to top of IDL file
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
  # add TS const to top of IDL file
  sed -i '' '1s/^/export const VaultStake = /' "$dest_idl"
  echo "Copied to $dest_idl"
}

build_program() {
  anchor build
  copy_mint_prog_idl_types
  copy_stake_prog_idl_types
}

deploy_mint_program() {
  echo "Deploying Mint Program..."
  echo "Getting Program IDs..."
  VAULT_MINT_PROGRAM_ID=$(solana-keygen pubkey ../target/deploy/vault_mint-keypair.json)
  update_history_var "VAULT_MINT_PROGRAM_ID"
  # Update lib.rs declare_id:
  PROGRAM_FILE="../programs/vault-mint/src/lib.rs"
  sed -i '' "s/declare_id!(\"[A-Za-z0-9]*\");/declare_id!(\"$VAULT_MINT_PROGRAM_ID\");/" $PROGRAM_FILE
  echo "Updated ${PROGRAM_FILE} with new Program ID ${VAULT_MINT_PROGRAM_ID}"
  echo "Saving Deploy Keypair to local config ${HOME}/.config/solana"
  cp ../target/deploy/vault_mint-keypair.json $HOME/.config/solana/vault_mint_${VAULT_MINT_PROGRAM_ID}-keypair.json

  solana program deploy ../target/deploy/vault_mint.so \
    --url "$SOLANA_URL" \
    --keypair "$KEYPAIR" \
    --config "$CONFIG_FILE"
  echo "Mint program deployed with ID: $VAULT_MINT_PROGRAM_ID"
}

deploy_staking_program() {
  echo "Deploying Staking Program..."

  solana program deploy ../target/deploy/vault_stake.so \
    --url "$SOLANA_URL" \
    --keypair "$KEYPAIR" \
    --config "$CONFIG_FILE"
  echo "Stake program deployed with ID: $VAULT_STAKE_PROGRAM_ID"
}

build_and_deploy() {
  build_program
  deploy_mint_program
  deploy_staking_program
}

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
    prompt_with_default $VAULT_STAKE_PROGRAM_ID "Enter Stake Program ID allowed to call mint"
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

  if [ -z "$UNBONDING_PERIOD" ]; then
    prompt_with_default UNBONDING_PERIOD "Enter Unbonding Period (in seconds)"
  fi

  if [ -z "$STAKE_PROG_MINT_TOKEN" ]; then
    prompt_with_default STAKE_PROG_MINT_TOKEN "Enter Stake Program mint token (staking token minted, PRIME)"
  fi

  INITIALIZE=$(
    yarn run ts-node scripts/vault-stake/initialize.ts \
    --vault "$MINT_PROG_MINT_TOKEN" \
    --vault_token_account "$STAKE_PROG_VAULT_TOKEN_ACCOUNT" \
    --mint "$STAKE_PROG_MINT_TOKEN" \
    --unbonding_period "$UNBONDING_PERIOD" \
    --freeze_administrators "$FREEZE_ADMINISTRATORS" \
    --rewards_administrators "$REWARDS_ADMINISTRATORS")

  echo "$INITIALIZE"
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
    prompt_with_default STAKE_METAPLEX_NAME "Enter Stake Token Metaplex Token Name"
  fi
  if [ -z "$STAKE_METAPLEX_SYMBOL" ]; then
    prompt_with_default STAKE_METAPLEX_SYMBOL "Enter Stake Token Metaplex Token Symbol"
  fi
  if [ -z "$STAKE_METAPLEX_META_URL" ]; then
    prompt_with_default STAKE_METAPLEX_META_URL "Enter Stake Token Metaplex Token Metadata URL (must be a valid JSON URL)"
  fi

  yarn run ts-node scripts/register_meta.ts \
    --mint "$STAKE_PROG_MINT_TOKEN" \
    --keypair "$KEYPAIR" \
    --name "$STAKE_METAPLEX_NAME" \
    --symbol "$STAKE_METAPLEX_SYMBOL" \
    --token_meta_url "$STAKE_METAPLEX_META_URL"

}

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

  echo "Setting Freeze Authority to $STAKE_PROG_FREEZE_AUTHORITY_PDA"
  spl-token authorize "$STAKE_PROG_MINT_TOKEN" freeze "$STAKE_PROG_FREEZE_AUTHORITY_PDA" \
    --url "$SOLANA_URL" \
    --authority "$KEYPAIR"
}


show_accounts_and_pdas() {
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
  echo "Allow Mint Program Caller ID:             $VAULT_STAKE_PROGRAM_ID"

  echo ""
  echo "Stake Program:"
  echo "Program ID:                               $VAULT_STAKE_PROGRAM_ID"
  echo "Vault Token (accepted token, i.e. wYLDS): $MINT_PROG_MINT_TOKEN"
  echo "Mint Token (token minted, PRIME):         $STAKE_PROG_MINT_TOKEN"
  echo "Vault Token Account:                      $STAKE_PROG_VAULT_TOKEN_ACCOUNT"
  echo "Vault Authority:                          $(get_pda "$VAULT_STAKE_PROGRAM_ID" "vault_authority")"
  echo "Config PDA:                               $(get_pda "$VAULT_STAKE_PROGRAM_ID" "stake_config")"
  echo "Stake Vault Token Account Config PDA:     $(get_stake_program_config_pda "$VAULT_STAKE_PROGRAM_ID")"
  echo "Mint Authority PDA:                       $(get_pda "$VAULT_STAKE_PROGRAM_ID" "mint_authority")"
  echo "Freeze Authority PDA:                     $(get_pda "$VAULT_STAKE_PROGRAM_ID" "freeze_authority")"
  echo "Freeze Administrators:                    $FREEZE_ADMINISTRATORS"
  echo "Rewards Administrators:                   $REWARDS_ADMINISTRATORS"
  echo "Unbonding Period (in seconds):            $UNBONDING_PERIOD"
}

while true; do
  MY_KEY=$(solana-keygen pubkey "$KEYPAIR")
  VAULT_MINT_PROGRAM_ID=$(grep -oE 'declare_id!\("([A-Za-z0-9]+)"\);' ../programs/vault-mint/src/lib.rs | grep -oE '\"([A-Za-z0-9]+)\"' | tr -d '"')
  VAULT_STAKE_PROGRAM_ID=$(grep -oE 'declare_id!\("([A-Za-z0-9]+)"\);' ../programs/vault-stake/src/lib.rs | grep -oE '\"([A-Za-z0-9]+)\"' | tr -d '"')

  echo ""

  SOL_BALANCE=$(solana balance --url "$SOLANA_URL" --keypair "$KEYPAIR" 2>/dev/null || echo "0 SOL")
  solana config get
  echo ""
  echo "Public Key:             $MY_KEY ($SOL_BALANCE)"
  echo "Vault Mint Program ID:  $VAULT_MINT_PROGRAM_ID"
  echo "Vault Stake Program ID: $VAULT_STAKE_PROGRAM_ID"
  echo "Mint Token:             $MINT_PROG_MINT_TOKEN"
  echo "Vault Token:            $MINT_PROG_VAULT_MINT"
  echo "Staking Token:          $STAKE_PROG_MINT_TOKEN"

  echo ""

  echo "Select an action:"
  select opt in \
    "Build Programs" \
    "Deploy Mint Program" \
    "Initialize Mint Program" \
    "Initialize Stake Program" \
    "Setup Metaplex" \
    "Set Mint Program Mint and Freeze Authorities" \
    "Set Stake Program Mint and Freeze Authorities" \
    "Show Accounts & PDAs" \
    "Create Mint Token" \
    "Create Stake Token" \
    "Create Mint Program Redeem Vault Token Account" \
    "Create Stake Program Vault Token Account" \
    "Deploy Staking Program" \
    "Exit"
  do
    case $REPLY in
      1) build_program; break ;;
      2) deploy_mint_program; break ;;
      3) initialize_mint_program; break ;;
      4) initialize_stake_program; break ;;
      5) setup_metaplex; break ;;
      6) set_mint_prog_mint_and_freeze_authority; break ;;
      7) set_stake_prog_mint_and_freeze_authority; break ;;
      8) show_accounts_and_pdas; break ;;
      9) create_mint_prog_mint_token; break ;;
      10) create_stake_prog_mint_token; break ;;
      11) create_mint_prog_redeem_vault_token_account; break ;;
      12) create_stake_prog_vault_token_account; break ;;
      13) deploy_staking_program; break ;;
      14) exit 0 ;;
      *) echo "Invalid option"; break ;;
    esac
  done
done
