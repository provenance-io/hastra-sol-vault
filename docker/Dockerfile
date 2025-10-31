FROM solanafoundation/anchor:v0.32.1

# Update node version to 20.18.0
RUN nvm install v20.18.0

# Set working directory
WORKDIR /workspace

# Copy package files first for better caching
COPY package.json yarn.lock ./
COPY Cargo.toml Cargo.lock ./
COPY programs/*/Cargo.toml ./programs/

# Install Node.js dependencies
RUN yarn install --frozen-lockfile

# Copy the rest of the project
COPY . .

# Build the Anchor project
RUN anchor build

# Set default command
CMD ["/bin/bash"] 
