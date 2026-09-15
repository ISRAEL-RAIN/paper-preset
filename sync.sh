#!/usr/bin/env bash
#
# sync.sh — install or update the `paper` agent preset on a DSH deployment.
#
# WHY THIS IS A SCRIPT AND NOT A PROMPT. The preset contains .mjs files that
# DSH executes inside its own host process with the privileges of whoever runs
# the deployment. "Ask the agent to fetch the latest from the internet and
# install it" therefore hands arbitrary remote code that privilege level. This
# script keeps the trust decision in one auditable place: it verifies the
# checksums that ship alongside the code, installs deterministically, and can
# roll back. Let a human or a timer run it; let the agent at most run it and
# report the output.
#
# THE ONE NON-OBVIOUS STEP. DSH decides whether a mounted preset is stale by
# stamping the composition FILE — mtimeMs + size of `agent.cordis.yml` — not
# the directory. Replacing only the .mjs files leaves that stamp untouched, so
# the running DSH keeps serving the old generation to every new session and the
# update silently does nothing. Touching the composition file is what makes the
# new code take effect. Do not remove that step.

set -euo pipefail

PRESET_ID="paper"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="${SCRIPT_DIR}/preset"
DSH_HOME_DIR="${DSH_HOME:-${HOME}/.dsh}"
TARGET_DIR="${DSH_HOME_DIR}/.agent-presets/${PRESET_ID}"
BACKUP_ROOT="${DSH_HOME_DIR}/.agent-presets"
STAMP="$(date +%Y%m%d-%H%M%S)"

DRY_RUN=0
ROLLBACK=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --rollback) ROLLBACK=1 ;;
    -h|--help)
      cat <<'USAGE'
用法:
  ./sync.sh              安装或更新 paper preset
  ./sync.sh --dry-run    只检查，不写任何东西
  ./sync.sh --rollback   回滚到最近一次备份
环境变量:
  DSH_HOME               DSH 主目录（默认 ~/.dsh）
USAGE
      exit 0 ;;
    *) echo "未知参数: $arg（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf '错误: %s\n' "$*" >&2; exit 1; }

require_cmd() { command -v "$1" >/dev/null 2>&1 || die "缺少命令 $1"; }
require_cmd sha256sum
require_cmd touch
require_cmd cp

# ── rollback path ───────────────────────────────────────────────────────────
if [ "$ROLLBACK" = 1 ]; then
  latest="$(ls -1d "${BACKUP_ROOT}/${PRESET_ID}.bak."* 2>/dev/null | sort | tail -n1 || true)"
  [ -n "$latest" ] || die "找不到任何备份（${BACKUP_ROOT}/${PRESET_ID}.bak.*）"
  say "回滚到: ${latest}"
  if [ "$DRY_RUN" = 1 ]; then say "[dry-run] 不会真的写入"; exit 0; fi
  rm -rf "${TARGET_DIR}"
  cp -r "$latest" "$TARGET_DIR"
  touch "${TARGET_DIR}/agent.cordis.yml"
  say "已回滚。新开会话生效；正在进行的会话不受影响。"
  exit 0
fi

# ── sanity checks ───────────────────────────────────────────────────────────
[ -d "$SOURCE_DIR" ] || die "找不到源目录 ${SOURCE_DIR}"
[ -f "${SOURCE_DIR}/agent.cordis.yml" ] || die "源目录里没有 agent.cordis.yml"
[ -f "${SOURCE_DIR}/preset.yml" ] || die "源目录里没有 preset.yml"
[ -d "$DSH_HOME_DIR" ] || die "找不到 DSH 主目录 ${DSH_HOME_DIR}（是不是 DSH_HOME 设错了？）"

# ── integrity: verify every file against the shipped checksums ──────────────
if [ -f "${SCRIPT_DIR}/checksums.txt" ]; then
  say "校验文件完整性…"
  ( cd "$SOURCE_DIR" && sha256sum --check --quiet "${SCRIPT_DIR}/checksums.txt" ) \
    || die "校验失败：文件与 checksums.txt 不一致，拒绝安装。"
  say "  校验通过（$(wc -l < "${SCRIPT_DIR}/checksums.txt") 个文件）"
else
  say "警告：没有 checksums.txt，跳过完整性校验。"
fi

say ""
say "将安装: ${SOURCE_DIR}"
say "  到:   ${TARGET_DIR}"

if [ "$DRY_RUN" = 1 ]; then
  say "[dry-run] 不会真的写入。"
  exit 0
fi

# ── backup, then swap ───────────────────────────────────────────────────────
if [ -d "$TARGET_DIR" ]; then
  backup="${BACKUP_ROOT}/${PRESET_ID}.bak.${STAMP}"
  cp -r "$TARGET_DIR" "$backup"
  say "已备份旧版本 -> ${backup}"
fi

rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"
cp -r "${SOURCE_DIR}/." "$TARGET_DIR/"

# The step that actually makes DSH notice. See the header comment.
touch "${TARGET_DIR}/agent.cordis.yml"

# ── verify what landed ──────────────────────────────────────────────────────
for required in agent.cordis.yml preset.yml paper-policy.mjs paper-refs.mjs paper-commands.mjs; do
  [ -f "${TARGET_DIR}/${required}" ] || die "安装后缺少 ${required}"
done
[ -d "${TARGET_DIR}/skills" ] || die "安装后缺少 skills/ 目录"

say ""
say "完成。安装内容:"
( cd "$TARGET_DIR" && find . -type f | sort | sed 's/^/  /' )
say ""
say "生效方式: 新开一个会话即可（已挂载的旧会话保持原样，不会被中断）。"
say "若新会话报 preset 挂载失败: ./sync.sh --rollback"
