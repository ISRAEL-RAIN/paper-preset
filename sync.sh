#!/usr/bin/env bash
#
# sync.sh — install or update the `paper` agent preset on a DSH deployment.
#
# WHY THIS IS A SCRIPT AND NOT A PROMPT. The preset contains .mjs files that
# DSH executes inside its own host process with the privileges of whoever runs
# the deployment. "Ask the agent to fetch the latest from the internet and
# install it" therefore hands arbitrary remote code that privilege level. This
# script keeps the trust decision in one auditable place: it verifies the
# checksums that ship alongside the code, refuses a silent downgrade, installs
# deterministically, and can roll back. Let a human or a timer run it; let the
# agent at most run it and report the output.
#
# WHAT IT DOES NOT DO. Nothing here is automatic. `git pull` is yours to run,
# this script is yours to run, and the restart below is yours to schedule.
# There is no daemon, no polling, and no phone-home.
#
# TWO NON-OBVIOUS FACTS ABOUT HOW AN UPDATE LANDS. Both were verified against a
# running DSH (dsh-agent-presets + cordis-plugin-loader), not assumed.
#
# 1. DSH decides whether a mounted preset is stale by stamping the composition
#    FILE — mtimeMs + size of `agent.cordis.yml` — not the directory. So after
#    copying files in, the composition must be re-stamped or DSH keeps serving
#    the mount it already has. That is what the `touch` below is for.
#
# 2. THAT TOUCH IS NOT ENOUGH FOR PLUGIN CODE. The loader imports a relative
#    row with a plain `import(new URL(name, baseUrl).href)` — no cache-busting
#    query. Node caches an ES module by resolved URL for the lifetime of the
#    process, so a re-mount of a CHANGED .mjs file re-runs `apply` from the
#    CACHED module: tools, prompt text and command handlers stay on the old
#    code. Only a process restart clears it. Measured directly: a brand-new
#    .mjs is evaluated on mount, the same .mjs edited and re-mounted is not.
#
#    Practical rule: changes to agent.cordis.yml (rows, configs, persona text)
#    land on the next session; ANY change to an .mjs file needs a restart.
#    This script compares the incoming .mjs files against the installed ones
#    and tells you which of the two you just did.

set -euo pipefail

PRESET_ID="paper"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="${SCRIPT_DIR}/preset"
DSH_HOME_DIR="${DSH_HOME:-${HOME}/.dsh}"
TARGET_DIR="${DSH_HOME_DIR}/.agent-presets/${PRESET_ID}"
BACKUP_ROOT="${DSH_HOME_DIR}/.agent-presets"
INSTALLED_FILE="${TARGET_DIR}/INSTALLED.json"
STAMP="$(date +%Y%m%d-%H%M%S)"

DRY_RUN=0
ROLLBACK=0
STATUS=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --rollback) ROLLBACK=1 ;;
    --status) STATUS=1 ;;
    --force) FORCE=1 ;;
    -h|--help)
      cat <<'USAGE'
用法:
  ./sync.sh              安装或更新 paper preset
  ./sync.sh --dry-run    只检查并预告，不写任何东西
  ./sync.sh --status     只报告当前装了什么版本，不写任何东西
  ./sync.sh --rollback   回滚到最近一次备份
  ./sync.sh --force      忽略「已是最新」或「这是降级」的拦截，强制安装
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
require_cmd sed
require_cmd sort

# ── version helpers ─────────────────────────────────────────────────────────

# The version recorded by the last install, or nothing when never installed.
read_installed_version() {
  [ -f "$INSTALLED_FILE" ] || return 1
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$INSTALLED_FILE" | head -n1
}

# Is $1 >= $2 under version sort? Used to tell an upgrade from a downgrade.
version_ge() {
  [ "$1" = "$2" ] && return 0
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | tail -n1)" = "$1" ]
}

# ── host compatibility preflight ────────────────────────────────────────────
# A preset bundle is NOT a DSH. Its composition names host packages, and every
# one of them must resolve on the customer's install or the mount fails and
# sessions on this preset refuse to start. COMPATIBILITY.json records the exact
# install this bundle was validated against; this compares the two.
#
# What it CAN catch: a renamed or missing package, a DSH carrying a different
# package set, too-old Node.
# What it CANNOT catch: a config-schema change inside a package that kept its
# version, or a host service the preset's rows inject that this deployment does
# not mount. Only a real mount catches those — which is why the operator must
# open a session after installing, and why --rollback exists.
compat_preflight() {
  local file="${SCRIPT_DIR}/COMPATIBILITY.json"
  if [ ! -f "$file" ]; then
    say "警告: 缺少 COMPATIBILITY.json，跳过宿主兼容性预检。"
    return 0
  fi

  local node_min node_now
  node_min="$(sed -n 's/.*"nodeMinimum"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -n1)"
  node_now="$(node --version 2>/dev/null | sed 's/^v//')"
  if [ -n "$node_now" ] && [ -n "$node_min" ] && ! version_ge "$node_now" "$node_min"; then
    die "Node 版本过低: 当前 v${node_now}，这个 preset 需要 >= v${node_min}（插件用到 process.getBuiltinModule）。"
  fi

  local dsh_bin
  dsh_bin="$(command -v dsh || true)"
  if [ -z "$dsh_bin" ]; then
    say "警告: PATH 里找不到 dsh，无法预检宿主兼容性（请用运行 DSH 的那个用户执行）。"
    return 0
  fi

  local entry install_root pkg_root
  entry="$(readlink -f "$dsh_bin" 2>/dev/null || echo "$dsh_bin")"
  install_root="$(cd -- "$(dirname -- "$entry")/.." 2>/dev/null && pwd || echo '')"
  pkg_root="$(cd -- "${install_root}/.." 2>/dev/null && pwd || echo '')"

  local declared_dsh dsh_now
  declared_dsh="$(sed -n 's/.*"dshVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -n1)"
  dsh_now="$(dsh --version 2>/dev/null | tr -d '[:space:]' || echo '')"

  if [ -z "$install_root" ] || [ ! -d "${install_root}/node_modules/@deepseek-ai" ]; then
    say "警告: 认不出 DSH 的安装目录，跳过包检查。"
    return 0
  fi

  local missing='' mismatched='' checked=0 pair pkg want name have candidate
  while IFS= read -r pair; do
    [ -n "$pair" ] || continue
    pkg="${pair%%: *}"
    want="${pair##*: }"
    name="${pkg##*/}"
    have=''
    for candidate in "${install_root}/node_modules/@deepseek-ai/${name}" "${pkg_root}/${name}"; do
      if [ -f "${candidate}/package.json" ]; then
        have="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${candidate}/package.json" | head -n1)"
        break
      fi
    done
    checked=$((checked + 1))
    if [ -z "$have" ]; then
      missing="${missing}${missing:+, }${pkg}"
    elif [ "$want" != "unknown" ] && [ "$have" != "$want" ]; then
      mismatched="${mismatched}${mismatched:+, }${pkg} (验证于 ${want}，此处 ${have})"
    fi
  done < <(sed -n '/"packages"[[:space:]]*:[[:space:]]*{/,/^  }/p' "$file" \
    | grep -oE '"[^"]+"[[:space:]]*:[[:space:]]*"[^"]+"' | sed 's/"//g')

  say "宿主兼容性预检: 检查了 ${checked} 个包"

  if [ -n "$missing" ]; then
    if [ "$FORCE" = 1 ]; then
      say "⚠️  以下包在该 DSH 上找不到，--force 已指定，继续（挂载很可能失败）:"
      say "      ${missing}"
    else
      die "以下包在该 DSH 上找不到，preset 挂载必然失败:
     ${missing}
     DSH 版本: ${dsh_now:-未知}（本 bundle 验证于 ${declared_dsh}）
     这台机器的 DSH 与本 preset 不兼容 —— 请不要安装，或升级 DSH 后再试。
     确实要强行安装: ./sync.sh --force"
    fi
  fi

  if [ -n "$dsh_now" ] && [ -n "$declared_dsh" ] && [ "$dsh_now" != "$declared_dsh" ]; then
    say "⚠️  DSH 版本不同: 此处 ${dsh_now}，本 bundle 验证于 ${declared_dsh}"
  fi
  if [ -n "$mismatched" ]; then
    say "⚠️  以下包版本与验证环境不同（通常无害，但配置项可能已变）:"
    say "      ${mismatched}"
  fi
}

PACKAGE_VERSION="$(cat "${SCRIPT_DIR}/VERSION" 2>/dev/null || echo '')"

# ── status path (read-only) ─────────────────────────────────────────────────
if [ "$STATUS" = 1 ]; then
  say "分发包版本: ${PACKAGE_VERSION:-(缺少 VERSION 文件)}"
  say "DSH 主目录: ${DSH_HOME_DIR}"
  say "安装位置:   ${TARGET_DIR}"
  installed="$(read_installed_version || true)"
  if [ -z "$installed" ]; then
    if [ -d "$TARGET_DIR" ]; then
      say "当前状态:   已安装，但没有 INSTALLED.json（v0.1.2 或更早装的）"
    else
      say "当前状态:   未安装"
    fi
  else
    say "当前状态:   已安装 v${installed}"
    sed -n 's/.*"installedAt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/安装时间:   \1/p' "$INSTALLED_FILE"
    sed -n 's/.*"commit"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/对应提交:   \1/p' "$INSTALLED_FILE"
    if [ -n "$PACKAGE_VERSION" ] && version_ge "$PACKAGE_VERSION" "$installed" && [ "$PACKAGE_VERSION" != "$installed" ]; then
      say "可更新到:   v${PACKAGE_VERSION}"
    elif [ "$PACKAGE_VERSION" = "$installed" ]; then
      say "已是最新。"
    fi
  fi
  exit 0
fi

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
[ -n "$PACKAGE_VERSION" ] || die "缺少 VERSION 文件，无法判断这是升级还是降级"
[ -d "$DSH_HOME_DIR" ] || die "找不到 DSH 主目录 ${DSH_HOME_DIR}（是不是 DSH_HOME 设错了？）"

# A DSH home that is NOT the one the running DSH uses accepts the files and
# then does nothing visible: the service keeps reading its own home and the
# operator sees a successful install with no effect. On a deployment whose DSH
# runs as a service account this is the single most likely silent failure, so
# it is checked rather than assumed.
if [ ! -d "${DSH_HOME_DIR}/profiles" ] && [ ! -f "${DSH_HOME_DIR}/settings.yaml" ]; then
  say "警告: ${DSH_HOME_DIR} 看起来不像一个 DSH 主目录。"
  say "      （既没有 profiles/ 也没有 settings.yaml）"
  say "      如果 DSH 是以别的用户运行的，这样装完不会有任何效果 —— 请用运行 DSH 的"
  say "      那个用户执行本脚本，或显式指定 DSH_HOME=/path/to/that/users/.dsh"
  say ""
fi

if [ ! -w "$DSH_HOME_DIR" ]; then
  die "${DSH_HOME_DIR} 不可写。请用运行 DSH 的那个用户执行，或修正权限。"
fi

say "分发包版本: ${PACKAGE_VERSION}"
say "DSH 主目录: ${DSH_HOME_DIR}"
say ""

# ── host compatibility: does this DSH actually carry what the preset names? ──
compat_preflight
say ""

# ── integrity: verify every file against the shipped checksums ──────────────
if [ -f "${SCRIPT_DIR}/checksums.txt" ]; then
  say "校验文件完整性…"
  ( cd "$SOURCE_DIR" && sha256sum --check --quiet "${SCRIPT_DIR}/checksums.txt" ) \
    || die "校验失败：文件与 checksums.txt 不一致，拒绝安装。"
  say "  校验通过（$(wc -l < "${SCRIPT_DIR}/checksums.txt") 个文件）"
else
  say "警告：没有 checksums.txt，跳过完整性校验。"
fi

# ── version gate ────────────────────────────────────────────────────────────
# Read BEFORE anything is removed: this is the only copy of what is installed.
INSTALLED_VERSION="$(read_installed_version || true)"
if [ -n "$INSTALLED_VERSION" ]; then
  say "当前已装:   v${INSTALLED_VERSION}"
  if [ "$INSTALLED_VERSION" = "$PACKAGE_VERSION" ]; then
    if [ "$FORCE" = 1 ]; then
      say "版本相同（v${PACKAGE_VERSION}），--force 已指定，继续重装。"
    else
      say ""
      say "已经是 v${PACKAGE_VERSION}，无需更新。"
      say "确实要重装同一版本，请显式指定: ./sync.sh --force"
      exit 0
    fi
  elif ! version_ge "$PACKAGE_VERSION" "$INSTALLED_VERSION"; then
    if [ "$FORCE" = 1 ]; then
      say "⚠️  这是降级：v${INSTALLED_VERSION} → v${PACKAGE_VERSION}，--force 已指定，继续。"
    else
      say ""
      die "这是降级：当前 v${INSTALLED_VERSION}，而这个包是 v${PACKAGE_VERSION}。
     通常意味着仓库被切到了旧提交、旧分支，或被人 force-push 回了旧状态。
     如果确实要降级，请显式指定: ./sync.sh --force"
    fi
  else
    say "将更新为:   v${INSTALLED_VERSION} → v${PACKAGE_VERSION}"
  fi
else
  say "当前已装:   无（首次安装）"
fi

say ""
if [ "$DRY_RUN" = 1 ]; then
  say "[dry-run] 不会真的写入。上面就是将要发生的全部动作。"
  exit 0
fi

# ── backup, then swap ───────────────────────────────────────────────────────
# Detect whether any PLUGIN CODE changed before we overwrite the old copy: that
# decides which advice to print at the end (see CODE_CHANGED below).
CODE_CHANGED=0
if [ -d "$TARGET_DIR" ]; then
  for source_file in "${SOURCE_DIR}"/*.mjs; do
    [ -e "$source_file" ] || continue
    name="$(basename "$source_file")"
    if ! cmp -s "$source_file" "${TARGET_DIR}/${name}"; then
      CODE_CHANGED=1
      break
    fi
  done

  backup="${BACKUP_ROOT}/${PRESET_ID}.bak.${STAMP}"
  cp -r "$TARGET_DIR" "$backup"
  say "已备份旧版本 -> ${backup}"
fi

rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"
cp -r "${SOURCE_DIR}/." "$TARGET_DIR/"

# Re-stamps the composition file so DSH rebuilds the preset's standing mount
# instead of serving the one it already has. This IS enough for changes to
# agent.cordis.yml — but NOT for changes to .mjs files, because the loader
# imports them with a plain `import(url)` and Node caches that module for the
# lifetime of the process. See the header comment.
touch "${TARGET_DIR}/agent.cordis.yml"

# ── record what was installed ───────────────────────────────────────────────
COMMIT="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
cat > "$INSTALLED_FILE" <<EOF
{
  "preset": "${PRESET_ID}",
  "version": "${PACKAGE_VERSION}",
  "commit": "${COMMIT}",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "installedBy": "$(id -un 2>/dev/null || echo unknown)",
  "dshHome": "${DSH_HOME_DIR}"
}
EOF

# ── verify what landed ──────────────────────────────────────────────────────
for required in agent.cordis.yml preset.yml paper-policy.mjs paper-refs.mjs paper-commands.mjs INSTALLED.json; do
  [ -f "${TARGET_DIR}/${required}" ] || die "安装后缺少 ${required}"
done
[ -d "${TARGET_DIR}/skills" ] || die "安装后缺少 skills/ 目录"

say ""
say "完成。v${PACKAGE_VERSION} 已安装到 ${TARGET_DIR}"
say ""
if [ "$CODE_CHANGED" = 1 ]; then
  say "⚠️  本次更新改动了 .mjs 插件代码。"
  say "    DSH 用普通 import() 加载这些文件，Node 会按 URL 把模块缓存到进程结束，"
  say "    因此只 touch composition 是不够的 —— 必须重启 DSH 进程，否则新会话仍跑旧代码。"
  say ""
  say "    重启方式取决于你的部署（systemctl restart <服务名> / 重启容器 / 重跑 dsh web）。"
else
  say "本次未改动 .mjs 插件代码，新开一个会话即可生效（已挂载的旧会话保持原样）。"
fi
say ""
say "查当前版本: ./sync.sh --status"
say "出问题回滚: ./sync.sh --rollback"
