#!/bin/sh

if [ "$#" -ne 2 ] && [ "$#" -ne 3 ]; then
  echo "Usage: codex-auth-merge-extract.sh <asset-dir> <asset-tar> [merge|device]" >&2
  exit 1
fi

asset_dir=$1
asset_tar=$2
# Fork: "device" (the Codex fallback of a Claude agent) links auth.json to this
# device's own ~/.codex/auth.json instead of merging credentials: nothing from
# the host is installed and no copy of the device's login is kept.
auth_mode=${3:-merge}
if [ "$auth_mode" != "merge" ] && [ "$auth_mode" != "device" ]; then
  echo "codex-auth-merge-extract.sh: unknown auth mode" >&2
  exit 1
fi
auth_name=auth.json
stage_root="$asset_dir.paperclip-extract.$$"
stage_dir="$stage_root/stage"
preserve_dir="$stage_root/preserve"
sandbox_auth="$asset_dir/$auth_name"
host_auth="$stage_dir/$auth_name"
preserve_auth="$preserve_dir/$auth_name"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
decision_script="$script_dir/codex-auth-merge-decision.cjs"

cleanup() {
  rm -rf "$stage_root" "$asset_tar"
}
trap cleanup EXIT HUP INT TERM
rm -rf "$stage_root" &&
mkdir -p "$stage_dir" "$preserve_dir" &&
tar -xf "$asset_tar" -C "$stage_dir" || exit 1

keep_sandbox=0
# A linked auth.json is a device login (device mode), never a sandbox credential to keep.
if [ "$auth_mode" = "merge" ] && [ -f "$sandbox_auth" ] && [ ! -L "$sandbox_auth" ]; then
  if command -v node >/dev/null 2>&1; then
    node "$decision_script" "$sandbox_auth" "$host_auth"
    decision_rc=$?
    if [ "$decision_rc" -eq 10 ]; then
      keep_sandbox=1
    else
      keep_sandbox=0
    fi
  else
    echo "[paperclip] node not found in PATH; cannot evaluate auth-merge decision - aborting sandbox restore" >&2
    exit 1
  fi
fi

if [ "$keep_sandbox" -eq 1 ]; then
  if ! ( umask 077 && rm -f "$preserve_auth" && cat "$sandbox_auth" > "$preserve_auth" ); then
    keep_sandbox=0
  fi
fi

rm -rf "$asset_dir" || exit 1
mkdir -p "$asset_dir" || exit 1
find "$stage_dir" -mindepth 1 -maxdepth 1 ! -name "$auth_name" -exec mv -f -- {} "$asset_dir/" \; || exit 1

if [ "$auth_mode" = "device" ]; then
  device_auth="${HOME:-/nonexistent}/.codex/$auth_name"
  if [ -f "$device_auth" ]; then
    ln -s "$device_auth" "$asset_dir/$auth_name" || exit 1
  fi
  exit 0
fi

source_auth="$host_auth"
if [ "$keep_sandbox" -eq 1 ] && [ -f "$preserve_auth" ]; then
  source_auth="$preserve_auth"
fi

# When neither the shipped host home nor a preserved prior-lease credential
# provides auth.json, fall back to the sandbox image's own Codex login so an
# image signed in to Codex works on hosts with no credentials (managed cloud
# hosts never have one). Host and preserved credentials always win over the
# image login, preserving the existing shadowing precedence.
if [ ! -f "$source_auth" ] && [ -f "${HOME:-/nonexistent}/.codex/$auth_name" ]; then
  source_auth="${HOME:-/nonexistent}/.codex/$auth_name"
fi

if [ -f "$source_auth" ]; then
  target_auth="$asset_dir/$auth_name"
  target_tmp="$asset_dir/.auth.json.paperclip.$$"
  ( umask 077 && rm -f "$target_tmp" && cat "$source_auth" > "$target_tmp" ) || exit 1
  mv -f "$target_tmp" "$target_auth" || exit 1
fi
