#!/usr/bin/env bash
set -euo pipefail

target="${1:?target is required}"
image="${2:?image is required}"
package_path="${3:?package path is required}"
command="${4:?package command is required}"
package_file="/package/$(basename "$package_path")"

case "$target" in
  ubuntu:*|debian:*) install="apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y '$package_file'" ;;
  el:*) install="dnf install -y '$package_file'" ;;
  sles:*) install="zypper --non-interactive --no-gpg-checks install '$package_file'" ;;
  *) echo "Unsupported target: $target" >&2; exit 2 ;;
esac

docker run --rm --platform linux/amd64 \
  -v "$(dirname "$package_path"):/package:ro" \
  --entrypoint /bin/bash \
  "$image" \
  -lc "$install && $command"
