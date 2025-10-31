# Docker Setup for Sol Vault Mint

This directory contains Docker configuration for building and developing the Sol Vault Mint Anchor project.

## Prerequisites

- Docker

## Quick Start

### Build the Docker image

```bash
# From the project root directory
docker build -f docker/Dockerfile -t vault-mint .
```

## Available Commands

Once inside the container, you can run:

```bash
# Build the Anchor project
anchor build

# Run tests
anchor test

# Deploy to devnet
anchor deploy

# Run specific scripts
yarn run ts-node scripts/initialize.ts
yarn run ts-node scripts/deposit.ts

# Check Solana CLI
solana --version

# Check Anchor version
anchor --version
```

## Volumes

The following volumes are mounted for better performance:
- `cargo-cache`: Caches Rust dependencies
- `yarn-cache`: Caches Node.js dependencies
- Project directory: Mounted for live development

## Troubleshooting

### Build Issues
- Ensure you have sufficient disk space for the build
- Clear Docker cache if needed: `docker system prune -a`

### Permission Issues
- The container runs as root, so file permissions should not be an issue this setup

### Network Issues
- If you're behind a corporate firewall, you may need to configure Docker to use a proxy

## Cleanup

To remove all Dockeros volumes and images:

```bash
docker rmi vault-mint
``` 
