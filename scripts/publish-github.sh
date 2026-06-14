#!/usr/bin/env bash
#
# Publishes VoxelDeck to GitHub: creates the repo, pushes the source, uploads the
# built apps as a Release, and turns on GitHub Pages (the download site in docs/).
#
# Prereqs (one time):
#   sudo pacman -S github-cli      # or your platform's gh install
#   gh auth login                  # sign in to GitHub
#
# Then run:  bash scripts/publish-github.sh
#
set -euo pipefail

REPO="voxeldeck"
TAG="v1.0.0"
TITLE="VoxelDeck 1.0.0"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v gh >/dev/null || { echo "❌ gh (GitHub CLI) not found. Install it, then 'gh auth login'."; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "❌ Not signed in. Run: gh auth login"; exit 1; }

OWNER="$(gh api user -q .login)"
echo "▶ Publishing as: $OWNER/$REPO"

# 1) Bake the GitHub username into the download links on the Pages site.
sed -i "s|__OWNER__|$OWNER|g" docs/index.html

# 2) Make sure everything is committed.
git add -A
git commit -m "VoxelDeck 1.0.0 — app, builds page, docs" >/dev/null 2>&1 || echo "  (nothing new to commit)"

# 3) Create the repo (public) and push, unless it already exists.
if gh repo view "$OWNER/$REPO" >/dev/null 2>&1; then
  echo "  repo exists — pushing"
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$OWNER/$REPO.git"
  git branch -M main
  git push -u origin main
else
  gh repo create "$REPO" --public --source=. --remote=origin --push \
    --description "VoxelDeck — a dark-themed desktop dashboard for managing Minecraft servers."
fi

# 4) Release assets — electron-builder already gives them stable, version-less
#    names so the website's "latest/download/…" links never break.
ASSETS=(
  "dist/VoxelDeck.AppImage"
  "dist/voxeldeck.deb"
  "dist/VoxelDeck-Setup.exe"
  "dist/VoxelDeck-Portable.exe"
)
# Include electron-updater metadata so the in-app auto-updater can find updates.
# (The GitHub Actions release flow uploads these automatically; we add them here
#  too in case you publish with this script.)
for y in dist/latest.yml dist/latest-linux.yml dist/latest-mac.yml; do
  [ -f "$y" ] && ASSETS+=("$y")
done

# 5) Create (or update) the GitHub Release with the built apps.
NOTES="VoxelDeck $TAG.

Downloads:
- Windows installer — VoxelDeck-Setup.exe
- Windows portable — VoxelDeck-Portable.exe
- Linux AppImage — VoxelDeck.AppImage
- Debian/Ubuntu — voxeldeck.deb

Builds are unsigned, so Windows SmartScreen may warn (More info → Run anyway).
Get the app from the website: https://$OWNER.github.io/$REPO/"

if gh release view "$TAG" >/dev/null 2>&1; then
  gh release upload "$TAG" "${ASSETS[@]}" --clobber
else
  gh release create "$TAG" "${ASSETS[@]}" --title "$TITLE" --notes "$NOTES"
fi

# 6) Turn on GitHub Pages from the docs/ folder (on the repo's default branch).
DEFBR="$(git rev-parse --abbrev-ref HEAD)"
gh api --method POST "repos/$OWNER/$REPO/pages" \
  --input - >/dev/null 2>&1 <<JSON || echo "  (Pages may already be enabled)"
{"source":{"branch":"$DEFBR","path":"/docs"}}
JSON

echo
echo "✅ Done!"
echo "   Website : https://$OWNER.github.io/$REPO/"
echo "   Repo    : https://github.com/$OWNER/$REPO"
echo "   Releases: https://github.com/$OWNER/$REPO/releases/latest"
echo "   (Pages can take a minute to go live the first time.)"
