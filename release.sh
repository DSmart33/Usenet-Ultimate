#!/bin/bash
# ============================================================================
# Usenet Ultimate — Release Script
# ============================================================================
#
# One command to bump version, build Docker, tag git, and optionally publish.
#
# Usage:
#   ./release.sh patch          # 1.0.0 → 1.0.1
#   ./release.sh minor          # 1.0.0 → 1.1.0
#   ./release.sh major          # 1.0.0 → 2.0.0
#   ./release.sh 2.5.0          # explicit version
#   ./release.sh                # show current version + usage
#
# Flags:
#   --push        Push git tag + create GitHub release (requires gh CLI)
#   --no-docker   Skip Docker build (just version bump + git tag)
#   --dry-run     Preview what would happen without changing anything
#   --clean       Run scripts/docker-clean.sh before building
#
# Examples:
#   ./release.sh patch                     # quick patch release
#   ./release.sh minor --push              # feature release → GitHub
#   ./release.sh patch --dry-run           # see what would happen
#   ./release.sh major --clean --push      # full major release
#
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ── Defaults ────────────────────────────────────────────────────────────────
IMAGE_NAME="usenet-ultimate"
GHCR_IMAGE="ghcr.io/dsmart33/usenet-ultimate"
BUMP=""
DO_PUSH=false
DO_DOCKER=true
DRY_RUN=false
DO_CLEAN=false

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ── Helpers ─────────────────────────────────────────────────────────────────
info()  { echo -e "${CYAN}[info]${NC}  $*"; }
ok()    { echo -e "${GREEN}[done]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
err()   { echo -e "${RED}[err]${NC}   $*" >&2; }
step()  { echo -e "\n${BOLD}── $* ──${NC}"; }
dry()   { echo -e "${DIM}[dry-run]${NC} $*"; }

get_version() {
  grep -o '"version": *"[^"]*"' package.json | head -1 | grep -o '[0-9][0-9.]*'
}

bump_version() {
  local current="$1" type="$2"
  local major minor patch
  IFS='.' read -r major minor patch <<< "$current"

  case "$type" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "${major}.$((minor + 1)).0" ;;
    patch) echo "${major}.${minor}.$((patch + 1))" ;;
    *)
      # Treat as explicit version if it matches semver pattern
      if [[ "$type" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "$type"
      else
        return 1
      fi
      ;;
  esac
}

set_version() {
  local file="$1" version="$2"
  # Use portable sed syntax
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/\"version\": *\"[^\"]*\"/\"version\": \"$version\"/" "$file"
  else
    sed -i "s/\"version\": *\"[^\"]*\"/\"version\": \"$version\"/" "$file"
  fi
}

usage() {
  local current
  current=$(get_version)
  echo -e "${BOLD}Usenet Ultimate Release Script${NC}"
  echo ""
  echo -e "  Current version: ${GREEN}v${current}${NC}"
  echo ""
  echo "  Usage: $0 <patch|minor|major|x.y.z> [flags]"
  echo ""
  echo "  Version bumps:"
  echo "    patch          ${current} → $(bump_version "$current" patch)"
  echo "    minor          ${current} → $(bump_version "$current" minor)"
  echo "    major          ${current} → $(bump_version "$current" major)"
  echo "    x.y.z          Set explicit version"
  echo ""
  echo "  Flags:"
  echo "    --push         Push tag + create GitHub release (requires gh)"
  echo "    --no-docker    Skip Docker image build"
  echo "    --dry-run      Preview actions without executing"
  echo "    --clean        Clean Docker resources before build"
  echo ""
  echo "  Examples:"
  echo "    $0 patch                  Quick bug-fix release"
  echo "    $0 minor --push           Feature release to GitHub"
  echo "    $0 patch --dry-run        Preview what would happen"
  echo "    $0 major --clean --push   Full major release"
}

# ── Parse Arguments ─────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    patch|minor|major) BUMP="$1"; shift ;;
    --push)      DO_PUSH=true; shift ;;
    --no-docker) DO_DOCKER=false; shift ;;
    --dry-run)   DRY_RUN=true; shift ;;
    --clean)     DO_CLEAN=true; shift ;;
    -h|--help)   usage; exit 0 ;;
    *)
      # Check if it's an explicit version
      if [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        BUMP="$1"; shift
      else
        err "Unknown argument: $1"
        echo ""
        usage
        exit 1
      fi
      ;;
  esac
done

# No bump specified → show usage
if [ -z "$BUMP" ]; then
  usage
  exit 0
fi

# ── Preflight Checks ───────────────────────────────────────────────────────
CURRENT_VERSION=$(get_version)
NEW_VERSION=$(bump_version "$CURRENT_VERSION" "$BUMP")

if [ -z "$NEW_VERSION" ]; then
  err "Invalid version bump: $BUMP"
  exit 1
fi

if [ "$CURRENT_VERSION" = "$NEW_VERSION" ]; then
  err "New version is the same as current ($CURRENT_VERSION)"
  exit 1
fi

# Check for uncommitted changes
if ! git diff --quiet HEAD 2>/dev/null; then
  warn "You have uncommitted changes. They will NOT be included in the release commit."
  warn "Consider committing or stashing them first."
  if [ "$DRY_RUN" = false ]; then
    echo -n "Continue anyway? [y/N] "
    read -r answer
    if [[ ! "$answer" =~ ^[Yy]$ ]]; then
      echo "Aborted."
      exit 1
    fi
  fi
fi

# Check gh CLI if pushing
if [ "$DO_PUSH" = true ] && ! command -v gh &>/dev/null; then
  err "GitHub CLI (gh) is required for --push. Install: https://cli.github.com"
  exit 1
fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}============================================${NC}"
echo -e "${BOLD}  Usenet Ultimate Release${NC}"
echo -e "${BOLD}============================================${NC}"
echo -e "  Version:   ${RED}v${CURRENT_VERSION}${NC} → ${GREEN}v${NEW_VERSION}${NC}"
echo -e "  Docker:    $([ "$DO_DOCKER" = true ] && echo "${GREEN}build${NC}" || echo "${DIM}skip${NC}")"
echo -e "  Git tag:   ${GREEN}v${NEW_VERSION}${NC}"
echo -e "  Push:      $([ "$DO_PUSH" = true ] && echo "${GREEN}yes (GitHub release)${NC}" || echo "${DIM}no (local only)${NC}")"
echo -e "  Clean:     $([ "$DO_CLEAN" = true ] && echo "${GREEN}yes${NC}" || echo "${DIM}no${NC}")"
if [ "$DRY_RUN" = true ]; then
  echo -e "  Mode:      ${YELLOW}DRY RUN${NC}"
fi
echo -e "${BOLD}============================================${NC}"
echo ""

if [ "$DRY_RUN" = true ]; then
  step "Dry Run — here's what would happen"
  dry "Update package.json + lock:      v${CURRENT_VERSION} → v${NEW_VERSION}"
  dry "Update ui/package.json + lock:   v${CURRENT_VERSION} → v${NEW_VERSION}"
  [ "$DO_CLEAN" = true ] && dry "Run scripts/docker-clean.sh"
  if [ "$DO_DOCKER" = true ] && [ "$DO_PUSH" = true ]; then
    dry "Build multi-arch Docker:  ${GHCR_IMAGE}:v${NEW_VERSION} (amd64 + arm64)"
    dry "Push to GHCR:             ${GHCR_IMAGE}:latest"
  elif [ "$DO_DOCKER" = true ]; then
    dry "Build Docker image:       ${IMAGE_NAME}:v${NEW_VERSION} (local arch only)"
    dry "Tag Docker image:         ${IMAGE_NAME}:latest"
  fi
  dry "Git commit:               release: v${NEW_VERSION}"
  dry "Git tag:                  v${NEW_VERSION}"
  [ "$DO_PUSH" = true ] && dry "Push tag to origin"
  [ "$DO_PUSH" = true ] && dry "Create GitHub release:    v${NEW_VERSION}"
  echo ""
  ok "Dry run complete. Remove --dry-run to execute."
  exit 0
fi

# ── Step 1: Bump version ───────────────────────────────────────────────────
step "Bumping version to v${NEW_VERSION}"

set_version "package.json" "$NEW_VERSION"
ok "Updated package.json"

set_version "ui/package.json" "$NEW_VERSION"
ok "Updated ui/package.json"

# Sync lock files (npm updates only the root version entry, not every dependency)
info "Syncing lock files..."
npm install --package-lock-only --ignore-scripts 2>/dev/null
(cd ui && npm install --package-lock-only --ignore-scripts 2>/dev/null)
ok "Synced package-lock.json files"

# ── Step 2: Docker cleanup (optional) ──────────────────────────────────────
if [ "$DO_CLEAN" = true ]; then
  step "Cleaning Docker resources"
  if [ -f "$SCRIPT_DIR/scripts/docker-clean.sh" ]; then
    bash "$SCRIPT_DIR/scripts/docker-clean.sh" --force
  else
    warn "scripts/docker-clean.sh not found, skipping cleanup"
  fi
fi

# ── Step 3: Docker build (optional) ────────────────────────────────────────
if [ "$DO_DOCKER" = true ]; then
  step "Building Docker image"

  # Ensure buildx builder exists
  if ! docker buildx inspect usenet-ultimate-builder >/dev/null 2>&1; then
    info "Creating buildx builder..."
    docker buildx create --name usenet-ultimate-builder --use --bootstrap
  else
    docker buildx use usenet-ultimate-builder 2>/dev/null || true
  fi

  if [ "$DO_PUSH" = true ]; then
    # Multi-arch build + push to GHCR
    PLATFORMS="linux/amd64,linux/arm64"
    info "Building multi-arch (${PLATFORMS}) and pushing to GHCR..."
    docker buildx build \
      --platform "${PLATFORMS}" \
      --build-arg VERSION="${NEW_VERSION}" \
      -t "${GHCR_IMAGE}:v${NEW_VERSION}" \
      -t "${GHCR_IMAGE}:latest" \
      --push \
      .
    ok "Pushed ${GHCR_IMAGE}:v${NEW_VERSION} (amd64 + arm64)"
  else
    # Local build — single arch, load into Docker
    PLATFORM="linux/$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/')"
    info "Building for ${PLATFORM} (local only)..."
    docker buildx build \
      --platform "${PLATFORM}" \
      --build-arg VERSION="${NEW_VERSION}" \
      -t "${IMAGE_NAME}:v${NEW_VERSION}" \
      -t "${IMAGE_NAME}:latest" \
      --load \
      .
    ok "Built ${IMAGE_NAME}:v${NEW_VERSION} + ${IMAGE_NAME}:latest"
  fi
fi

# ── Step 4: Git commit + tag ───────────────────────────────────────────────
step "Creating git commit and tag"

git add package.json package-lock.json ui/package.json ui/package-lock.json
git commit -m "release: v${NEW_VERSION}"
ok "Committed version bump"

git tag -a "v${NEW_VERSION}" -m "Release v${NEW_VERSION}"
ok "Created tag v${NEW_VERSION}"

# ── Step 5: Push + GitHub release (optional) ───────────────────────────────
if [ "$DO_PUSH" = true ]; then
  step "Publishing to GitHub"

  git push origin "$(git branch --show-current)"
  ok "Pushed commits"

  git push origin "v${NEW_VERSION}"
  ok "Pushed tag v${NEW_VERSION}"

  # Generate changelog from commits since last tag
  PREV_TAG=$(git tag --sort=-v:refname | grep -v "v${NEW_VERSION}" | head -1)
  if [ -n "$PREV_TAG" ]; then
    CHANGELOG=$(git log "${PREV_TAG}..v${NEW_VERSION}" --pretty=format:"- %s" --no-merges | grep -v "^- release:")
  else
    CHANGELOG=$(git log --pretty=format:"- %s" --no-merges -20 | grep -v "^- release:")
  fi

  gh release create "v${NEW_VERSION}" \
    --title "v${NEW_VERSION}" \
    --notes "## What's Changed
${CHANGELOG}

---
**Full Changelog**: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/compare/${PREV_TAG:-initial}...v${NEW_VERSION}"

  ok "Created GitHub release v${NEW_VERSION}"
fi

# ── Done ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}============================================${NC}"
echo -e "${GREEN}  Release v${NEW_VERSION} complete!${NC}"
echo -e "${BOLD}============================================${NC}"
echo ""

if [ "$DO_PUSH" = false ]; then
  echo "  Next steps:"
  echo "    git push origin $(git branch --show-current)   # push commits"
  echo "    git push origin v${NEW_VERSION}                # push tag"
  echo "    gh release create v${NEW_VERSION} --generate-notes   # create GitHub release"
  echo ""
fi

if [ "$DO_DOCKER" = true ]; then
  echo "  Docker:"
  echo "    docker run -d -p 1337:1337 -v ./config:/app/config ${IMAGE_NAME}:v${NEW_VERSION}"
  echo "    docker compose up -d                          # or use compose"
  echo ""
fi
