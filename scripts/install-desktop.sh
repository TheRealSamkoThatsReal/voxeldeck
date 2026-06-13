#!/usr/bin/env bash
#
# Installs a desktop launcher so "VoxelDeck" shows up in your
# application menu and launches the app directly from this folder. No packaging
# or build step required — it just runs `electron .` from here.
#
# Usage:   npm run install-desktop      (or:  bash scripts/install-desktop.sh)
# Remove:  bash scripts/install-desktop.sh --uninstall
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons"
DESKTOP_FILE="$DESKTOP_DIR/voxeldeck.desktop"
ICON_FILE="$ICON_DIR/voxeldeck.png"

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$DESKTOP_FILE" "$ICON_FILE"
  echo "Removed desktop launcher."
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DESKTOP_DIR" || true
  exit 0
fi

# Resolve a Node/Electron launch command. Prefer the locally-installed electron.
ELECTRON_BIN="$APP_DIR/node_modules/.bin/electron"
if [[ ! -x "$ELECTRON_BIN" ]]; then
  echo "Local electron not found — running 'npm install' first..."
  (cd "$APP_DIR" && npm install)
fi

mkdir -p "$DESKTOP_DIR" "$ICON_DIR"
cp "$APP_DIR/src/renderer/assets/icon.png" "$ICON_FILE"

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=VoxelDeck
Comment=Manage your Minecraft servers: RAM, software, files, mods/plugins, console
Exec=$ELECTRON_BIN $APP_DIR
Path=$APP_DIR
Icon=$ICON_FILE
Terminal=false
Categories=Game;Utility;
StartupWMClass=voxeldeck
EOF

chmod +x "$DESKTOP_FILE"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DESKTOP_DIR" || true

echo "✓ Installed launcher: $DESKTOP_FILE"
echo "  Look for \"VoxelDeck\" in your application menu."
echo "  (You can also just run 'npm start' from $APP_DIR)"
