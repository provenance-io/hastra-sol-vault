FROM solanafoundation/anchor:v0.31.1

# Update Rust toolchain to match local development (1.90.0+).
# Use 'toolchain install' rather than 'rustup update' to avoid the cross-device
# rename error (os error 18) that occurs when building amd64 images on Apple Silicon
# via QEMU emulation. This is safe on all platforms including GHA.
RUN rustup toolchain install stable --no-self-update && rustup default stable

# Update Solana CLI to latest stable. The base image's bundled version ships with
# BPF platform tools that use Rust 1.79.0-dev, which is too old for indexmap >= 2.12
# (requires rustc >= 1.82). Installing a newer release updates the platform tools.
RUN sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
ENV PATH=/root/.local/share/solana/install/active_release/bin:$PATH

# nvm is a shell function; source it explicitly and install the required Node version.
# Update PATH via ENV so all subsequent RUN steps use v20.19.0 instead of the
# base image default (20.18.0), which is incompatible with yargs@18.
RUN bash -c "source /root/.nvm/nvm.sh && nvm install v20.19.0 && nvm alias default v20.19.0"
ENV PATH=/root/.nvm/versions/node/v20.19.0/bin:$PATH

# Set working directory
WORKDIR /workspace

# Copy package files first for better caching
COPY package.json yarn.lock ./
COPY Cargo.toml Cargo.lock ./
COPY programs/vault-mint/Cargo.toml ./programs/vault-mint/
COPY programs/vault-stake/Cargo.toml ./programs/vault-stake/

# Install Node.js dependencies
RUN yarn install --frozen-lockfile

# Copy the rest of the project
COPY . .

# Build the Anchor project
RUN anchor build

# Set default command
CMD ["/bin/bash"] 
