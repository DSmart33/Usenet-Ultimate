#!/bin/bash
# ============================================================================
# Usenet Ultimate — Docker Cleanup Script
# ============================================================================
#
# Cleans up Docker resources related to this project.
#
# Usage:
#   ./docker-clean.sh          # interactive (shows what will be cleaned)
#   ./docker-clean.sh --force  # no prompts
#   ./docker-clean.sh --all    # also prune ALL dangling Docker resources
#
# ============================================================================

set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────────────
FORCE=false
CLEAN_ALL=false
IMAGE_NAME="usenet-ultimate"
CONTAINER_NAME="usenet-ultimate"
BUILDER_NAME="usenet-ultimate-builder"

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

info()  { echo -e "${CYAN}[info]${NC}  $*"; }
ok()    { echo -e "${GREEN}[done]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
step()  { echo -e "\n${BOLD}── $* ──${NC}"; }

# ── Parse Arguments ─────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --force|-f) FORCE=true; shift ;;
    --all|-a)   CLEAN_ALL=true; shift ;;
    -h|--help)
      echo "Usage: $0 [--force] [--all]"
      echo "  --force   Skip confirmation prompts"
      echo "  --all     Also prune ALL dangling Docker resources"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Inventory ───────────────────────────────────────────────────────────────
echo -e "${BOLD}============================================${NC}"
echo -e "${BOLD}  Docker Cleanup — ${IMAGE_NAME}${NC}"
echo -e "${BOLD}============================================${NC}"
echo ""

# Find project containers (running + stopped)
CONTAINERS=$(docker ps -a --filter "name=${CONTAINER_NAME}" --format "{{.ID}}\t{{.Names}}\t{{.Status}}" 2>/dev/null || true)
if [ -n "$CONTAINERS" ]; then
  info "Containers found:"
  echo "$CONTAINERS" | while IFS=$'\t' read -r id name status; do
    echo -e "    ${DIM}${id}${NC}  ${name}  ${DIM}(${status})${NC}"
  done
else
  info "No project containers found"
fi

# Find project images
IMAGES=$(docker images "${IMAGE_NAME}" --format "{{.ID}}\t{{.Repository}}:{{.Tag}}\t{{.Size}}" 2>/dev/null || true)
if [ -n "$IMAGES" ]; then
  info "Images found:"
  echo "$IMAGES" | while IFS=$'\t' read -r id nametag size; do
    echo -e "    ${DIM}${id}${NC}  ${nametag}  ${DIM}(${size})${NC}"
  done
else
  info "No project images found"
fi

# Check buildx builder
BUILDER_EXISTS=false
if docker buildx inspect "${BUILDER_NAME}" >/dev/null 2>&1; then
  BUILDER_EXISTS=true
  info "Buildx builder: ${BUILDER_NAME}"
fi

# Dangling images
DANGLING=$(docker images -f "dangling=true" -q 2>/dev/null | wc -l | tr -d ' ')
if [ "$DANGLING" -gt 0 ]; then
  info "Dangling images: ${DANGLING}"
fi

# Build cache
CACHE_SIZE=$(docker system df --format '{{.Size}}' 2>/dev/null | tail -1 || echo "unknown")
info "Build cache: ${CACHE_SIZE}"

echo ""

# Nothing to clean?
if [ -z "$CONTAINERS" ] && [ -z "$IMAGES" ] && [ "$BUILDER_EXISTS" = false ] && [ "$DANGLING" -eq 0 ]; then
  ok "Already clean! Nothing to do."
  exit 0
fi

# ── Confirm ─────────────────────────────────────────────────────────────────
if [ "$FORCE" = false ]; then
  echo -n "Proceed with cleanup? [y/N] "
  read -r answer
  if [[ ! "$answer" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# ── Clean ───────────────────────────────────────────────────────────────────
SPACE_BEFORE=$(docker system df --format '{{.Size}}' 2>/dev/null | head -1 || echo "0")

# Stop and remove project containers
if [ -n "$CONTAINERS" ]; then
  step "Removing containers"
  docker ps -a --filter "name=${CONTAINER_NAME}" -q | xargs -r docker rm -f 2>/dev/null || true
  ok "Removed project containers"
fi

# Remove project images
if [ -n "$IMAGES" ]; then
  step "Removing images"
  docker images "${IMAGE_NAME}" -q | sort -u | xargs -r docker rmi -f 2>/dev/null || true
  ok "Removed project images"
fi

# Remove dangling images
if [ "$DANGLING" -gt 0 ]; then
  step "Removing dangling images"
  docker image prune -f >/dev/null 2>&1
  ok "Pruned ${DANGLING} dangling images"
fi

# Clean build cache
step "Cleaning build cache"
docker builder prune -f >/dev/null 2>&1 || true
ok "Pruned build cache"

# Remove buildx builder (it gets recreated automatically)
if [ "$BUILDER_EXISTS" = true ]; then
  step "Removing buildx builder"
  docker buildx rm "${BUILDER_NAME}" 2>/dev/null || true
  ok "Removed ${BUILDER_NAME} (will be recreated on next build)"
fi

# Full system prune if --all
if [ "$CLEAN_ALL" = true ]; then
  step "Pruning all unused Docker resources"
  docker system prune -f --volumes >/dev/null 2>&1 || true
  ok "Full system prune complete"
fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}============================================${NC}"
echo -e "${GREEN}  Cleanup complete!${NC}"
echo -e "${BOLD}============================================${NC}"

# Show current Docker disk usage
echo ""
docker system df 2>/dev/null || true
echo ""
