#!/usr/bin/env bash
set -euo pipefail

target="${1:?target is required}"
image="${2:?image is required}"
package_path="${3:?package path is required}"
command="${4:?package command is required}"

case "$target" in
  ubuntu:*|debian:*) install="dpkg -i /package/$(basename "$package_path")" ;;
  el:*|sles:*) install="rpm -i /package/$(basename "$package_path")" ;;
  *) echo "Unsupported target: $target" >&2; exit 2 ;;
esac

docker run --rm --platform linux/amd64 \
  -v "$(dirname "$package_path"):/package:ro" \
  --entrypoint /bin/bash \
  "$image" \
  -lc "$install && $command"
