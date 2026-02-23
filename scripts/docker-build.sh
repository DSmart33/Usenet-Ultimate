#!/bin/bash
# ============================================================================
# Usenet Ultimate Docker Multi-Arch Build Script
# ============================================================================
#
# NOTE: For full release workflow (version bump + build + git tag + GitHub
# release), use release.sh instead:
#
#   ./release.sh patch       # bump, build, tag — all in one
#   ./release.sh --help      # see all options
#
# This script is kept for standalone Docker builds without versioning.
#
# Usage:
#   ./docker-build.sh              # Build for both amd64 and arm64
#   ./docker-build.sh --push       # Build and push to registry
#   ./docker-build.sh --load       # Build and load into local Docker (single arch only)
#   ./docker-build.sh --tag v1.0   # Custom tag (default: latest)
#
# Prerequisites:
#   - Docker with buildx support
#   - For multi-arch: docker buildx create --use (one-time setup)
# ============================================================================

set -e

IMAGE_NAME="dsmart33/usenet-ultimate"
TAG="latest"
PLATFORMS="linux/amd64,linux/arm64"
ACTION=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --push)
      ACTION="--push"
      shift
      ;;
    --load)
      ACTION="--load"
      # --load only supports single platform
      PLATFORMS="linux/$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/')"
      echo "Note: --load only supports single platform, building for $PLATFORMS"
      shift
      ;;
    --tag)
      [ -z "$2" ] && echo "Error: --tag requires a value" && exit 1
      TAG="$2"
      shift 2
      ;;
    --name)
      [ -z "$2" ] && echo "Error: --name requires a value" && exit 1
      IMAGE_NAME="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--push] [--load] [--tag TAG] [--name IMAGE_NAME]"
      exit 1
      ;;
  esac
done

echo "============================================"
echo "Usenet Ultimate Docker Build"
echo "============================================"
echo "Image:     ${IMAGE_NAME}:${TAG}"
echo "Platforms: ${PLATFORMS}"
echo "Action:    ${ACTION:-'build only (no push/load)'}"
echo "============================================"

# Ensure buildx builder exists for multi-arch
if ! docker buildx inspect usenet-ultimate-builder >/dev/null 2>&1; then
  echo "Creating buildx builder for multi-arch support..."
  docker buildx create --name usenet-ultimate-builder --use --bootstrap
else
  docker buildx use usenet-ultimate-builder
fi

# Build
if [ -n "$ACTION" ]; then
  docker buildx build \
    --platform "${PLATFORMS}" \
    -t "${IMAGE_NAME}:${TAG}" \
    ${ACTION} \
    .
else
  # No action specified - just build (validates the image builds successfully)
  docker buildx build \
    --platform "${PLATFORMS}" \
    -t "${IMAGE_NAME}:${TAG}" \
    .
fi

echo ""
echo "============================================"
echo "Build complete: ${IMAGE_NAME}:${TAG}"
echo "============================================"

if [ "$ACTION" = "--load" ]; then
  echo ""
  echo "Run with:"
  echo "  docker run -d -p 1337:1337 -v ./config:/app/config ${IMAGE_NAME}:${TAG}"
fi
