#!/usr/bin/env bash
# Read-only readiness report. Does not install dependencies, deploy, or restart services.
set -u
printf '\n== Motion Studio VPS staging readiness ==\n'
printf 'Date (UTC): '; date -u +'%Y-%m-%dT%H:%M:%SZ'
printf 'OS: '; uname -sr
printf '\n== Disk ==\n'
df -h / 2>/dev/null || true
printf '\n== Memory ==\n'
free -h 2>/dev/null || true
printf '\n== Runtime ==\n'
for name in node npm ffmpeg ffprobe git docker; do
  if command -v "$name" >/dev/null 2>&1; then
    printf '%s: %s\n' "$name" "$(command -v "$name")"
  else
    printf '%s: not found\n' "$name"
  fi
done
node --version 2>/dev/null || true
npm --version 2>/dev/null || true
ffmpeg -version 2>/dev/null | head -n 1 || true
printf '\n== Container status (read-only) ==\n'
if command -v docker >/dev/null 2>&1; then
  docker ps --format '{{.Names}}\t{{.Status}}' 2>/dev/null || true
fi
if [ "${1:-}" != "" ]; then
  printf '\n== Git worktree: %s ==\n' "$1"
  if [ -d "$1/.git" ]; then
    git -C "$1" branch --show-current 2>/dev/null || true
    git -C "$1" log -1 --format='%h %s' 2>/dev/null || true
    git -C "$1" status --short 2>/dev/null || true
  else
    printf 'No existing Git worktree at that path.\n'
  fi
fi
printf '\nNo server state was changed by this script.\n'
