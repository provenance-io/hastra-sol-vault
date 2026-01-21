#!/bin/bash

# Build script for Sol Vault Mint Docker image

set -e

echo "Building Sol Vault Mint Docker image..."

# Build the Docker image
docker build -f docker/Dockerfile -t hastra-vault-mint .

echo "Build completed successfully!"
