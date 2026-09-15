#!/usr/bin/env bash
# Regenerate COMPATIBILITY.json from the DSH install this bundle was validated
# against. Run it on the machine where you tested the preset, then commit the
# result — sync.sh reads it on the customer side to preflight the host.
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_BIN="$(command -v dsh || true)"
[ -n "$DSH_BIN" ] || { echo "找不到 dsh 命令" >&2; exit 1; }

# Resolve the symlink to the real entry point, then walk up to the install root.
ENTRY="$(readlink -f "$DSH_BIN")"
ROOT="$(cd -- "$(dirname -- "$ENTRY")/.." && pwd)"        # <install>/@deepseek-ai/dsh
PKG_ROOT="$(cd -- "$ROOT/.." && pwd)"                      # <install>/@deepseek-ai

read_version() {
  local dir="$1"
  [ -f "$dir/package.json" ] || return 1
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$dir/package.json" | head -n1
}

# Every @deepseek-ai/* row the composition names, sub-paths collapsed.
PKGS="$(grep -oE "name: '@deepseek-ai/[^']+'" "$HERE/preset/agent.cordis.yml" \
  | sed "s/name: '//; s/'//" | sed 's#\(@deepseek-ai/[^/]*\)/.*#\1#' | sort -u)"

{
  printf '{\n'
  printf '  "validatedOn": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "dshVersion": "%s",\n' "$(dsh --version 2>/dev/null | tr -d '[:space:]')"
  printf '  "nodeVersion": "%s",\n' "$(node --version 2>/dev/null | tr -d '[:space:]')"
  printf '  "nodeMinimum": "22.0.0",\n'
  printf '  "packages": {\n'
  first=1
  for pkg in $PKGS; do
    name="$(basename "$pkg")"
    version=""
    for candidate in "$ROOT/node_modules/@deepseek-ai/$name" "$PKG_ROOT/$name"; do
      if version="$(read_version "$candidate")"; then break; fi
      version=""
    done
    [ -n "$version" ] || version="unknown"
    [ "$first" = 1 ] || printf ',\n'
    first=0
    printf '    "%s": "%s"' "$pkg" "$version"
  done
  printf '\n  }\n}\n'
} > "$HERE/COMPATIBILITY.json"

echo "已写入 $HERE/COMPATIBILITY.json"
