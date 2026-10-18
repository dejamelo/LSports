#!/usr/bin/env bash
# Read-only: no installs, prune, restart, configuration/env/log dumps or resource creation.
set -u
printf '\n== ADL AWS HOST DIAGNOSTIC (READ ONLY) ==\n'
date -u '+%Y-%m-%dT%H:%M:%SZ'
uname -srm
getconf _NPROCESSORS_ONLN
for f in /sys/class/dmi/id/sys_vendor /sys/class/dmi/id/product_name; do [ ! -r "$f" ] || cat "$f"; done
uptime
command -v timedatectl >/dev/null && timedatectl show -p NTPSynchronized --value || true
free -b
printf '\n== DISK AND INODES ==\n'
df -hT / /var/lib/docker /opt /srv 2>/dev/null || true
df -i / /var/lib/docker 2>/dev/null || true
printf '\n== CURRENT CPU / RAM (NOT PEAK HISTORY) ==\n'
command -v vmstat >/dev/null && vmstat 1 2 || true
ps -eo pid=,ppid=,rss=,comm= --sort=-rss 2>/dev/null | head -20 || true
printf '\n== LISTENING TCP PORTS ==\n'
command -v ss >/dev/null && ss -lntH | awk '{print $4}' || true
printf '\n== EXISTING SERVICES ==\n'
command -v systemctl >/dev/null && systemctl is-active docker caddy || true
command -v caddy >/dev/null && caddy version || true
if command -v docker >/dev/null; then
  printf '\n== DOCKER (NO ENVIRONMENT OR SECRETS) ==\n'
  docker version --format '{{.Server.Version}}' 2>/dev/null || true
  docker compose version 2>/dev/null || true
  docker info --format 'DockerRoot={{.DockerRootDir}} CPUs={{.NCPU}} MemoryBytes={{.MemTotal}}' 2>/dev/null || true
  docker compose ls --format json 2>/dev/null || true
  docker ps -a --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || true
  docker stats --no-stream --format '{{.Name}} CPU={{.CPUPerc}} MEM={{.MemUsage}} PIDS={{.PIDs}}' 2>/dev/null || true
  docker network ls --format '{{.Name}}\t{{.Driver}}' 2>/dev/null || true
  for id in $(docker ps -q 2>/dev/null); do
    docker inspect --format '{{.Name}} MemoryLimit={{.HostConfig.Memory}} NanoCpus={{.HostConfig.NanoCpus}} Restart={{.HostConfig.RestartPolicy.Name}} Network={{.HostConfig.NetworkMode}} Mounts={{range .Mounts}}{{.Type}}:{{.Destination}} {{end}}' "$id" 2>/dev/null || true
  done
else
  printf 'Docker unavailable; no installation attempted.\n'
fi
printf '\n== END: NO SERVICES OR RESOURCES CHANGED ==\n'
