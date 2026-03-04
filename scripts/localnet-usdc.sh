#!/bin/bash

# Optional overrides:
#   SOLANA_LOCALNET_KEYPAIR: path to the localnet keypair used for `solana config set --keypair`
#   SOLANA_FREEZE_ADMIN_KEYPAIR: path to the freeze admin keypair (airdrop + token owner)
SOLANA_LOCALNET_KEYPAIR="${SOLANA_LOCALNET_KEYPAIR:-~/.config/solana/hastra-localnet-id.json}"
SOLANA_FREEZE_ADMIN_KEYPAIR="${SOLANA_FREEZE_ADMIN_KEYPAIR:-~/temp/freeze_admin1.json}"

solana config set --url l
solana config set --keypair "${SOLANA_LOCALNET_KEYPAIR}"

PUBLIC_KEY=$(solana-keygen pubkey)

solana airdrop 1000 "$PUBLIC_KEY" --url l
solana airdrop 1000 --keypair "${SOLANA_FREEZE_ADMIN_KEYPAIR}" --url l

spl-token create-token --decimals 6 --enable-freeze --output json

USDC_TOKEN=$(spl-token create-token --decimals 6 --enable-freeze --output json | jq -r .commandOutput.address)
# Use freeze admin as owner
USDC_VAULT_TOKEN_ACCOUNT=$(spl-token create-account "$USDC_TOKEN" --owner "${SOLANA_FREEZE_ADMIN_KEYPAIR}" 2>&1 | grep "Creating account" | awk '{print $3}')
echo "USDC: ${USDC_TOKEN}"
echo "USDC Vault Account: ${USDC_VAULT_TOKEN_ACCOUNT}"

