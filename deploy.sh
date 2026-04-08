#!/bin/sh
set -e

REPO="https://github.com/bleepbleepbl00p/SMTP2Graph.git"
BRANCH="claude/gallant-lewin"
INSTALL_DIR="${1:-/opt/smtp2graph}"

echo "=== SMTP2Graph Deployment ==="
echo "Install directory: $INSTALL_DIR"
echo ""

# Check for required tools
for cmd in git node npm docker docker-compose; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "ERROR: '$cmd' is required but not found." >&2
        exit 1
    fi
done

# Clone or update repo
if [ -d "$INSTALL_DIR/.git" ]; then
    echo ">> Updating existing installation..."
    cd "$INSTALL_DIR"
    git fetch origin
    git checkout "$BRANCH"
    git pull origin "$BRANCH"
else
    echo ">> Cloning repository..."
    git clone -b "$BRANCH" "$REPO" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# Install dependencies and build
echo ">> Installing dependencies..."
npm ci

echo ">> Building application..."
npm run build

# Create data directory
mkdir -p data

# Build and start container
echo ">> Building Docker image..."
docker-compose build --no-cache

echo ">> Starting container..."
docker-compose up -d

echo ""
echo "=== Deployment Complete ==="
echo ""
echo "SMTP relay:  port 587"
echo "WebUI:       port 3000"
echo ""
if [ ! -f data/config.yml ]; then
    echo "No config.yml found — the WebUI will start in Setup Wizard mode."
    echo "Open http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'your-server-ip'):3000 to configure."
else
    echo "Using existing config at $INSTALL_DIR/data/config.yml"
fi
echo ""
echo "View logs:   docker logs -f smtp2graph"
echo "Stop:        docker-compose down"
echo "Restart:     docker-compose restart"
