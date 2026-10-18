#!/usr/bin/env bash
# Read-only inventory. Run using existing sudo access; no permission changes.
# Never dump inspect JSON, container environments, command arguments or application logs.
set -u
printf '== ADL DOCKER CAPACITY: READ ONLY ==\n'
date -u '+%Y-%m-%dT%H:%M:%SZ'
printf 'collectorUid=%s\n' "$(id -u)"
free -b
df -hT / /var/lib/docker 2>/dev/null || true
printf '\n== REGION (IMDSv2, optional; no credentials queried) ==\n'
if command -v curl >/dev/null; then
  metadata_token=$(curl --noproxy '*' -fsS --connect-timeout 1 --max-time 2 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token 2>/dev/null) || metadata_token=''
  if [ -n "$metadata_token" ]; then
    region=$(curl --noproxy '*' -fsS --connect-timeout 1 --max-time 2 -H "X-aws-ec2-metadata-token: $metadata_token" http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null) || region=''
    if [[ "$region" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]]; then printf 'region=%s\n' "$region"; else printf 'region=unavailable\n'; fi
  else printf 'region=unavailable\n'; fi
  unset metadata_token region
fi
if ! command -v docker >/dev/null; then printf 'docker=cli_missing\n'; exit 2; fi
# Selected output only. Classify errors without exposing raw daemon responses/URLs.
query() {
  local output status
  output=$(docker "$@" 2>&1); status=$?
  if [ "$status" -ne 0 ]; then
    case "$output" in
      *'permission denied'*|*'Permission denied'*) printf 'dockerQuery=failed code=%s category=permission_denied\n' "$status" ;;
      *'Cannot connect'*|*'cannot connect'*|*'connection refused'*) printf 'dockerQuery=failed code=%s category=daemon_unreachable\n' "$status" ;;
      *) printf 'dockerQuery=failed code=%s category=other_sanitized\n' "$status" ;;
    esac
    return "$status"
  fi
  printf '%s\n' "$output"
}
printf '\n== SERVER ACCESS ==\n'
if ! query info --format 'serverVersion={{.ServerVersion}} CPUs={{.NCPU}} MemoryBytes={{.MemTotal}} cgroup={{.CgroupVersion}} driver={{.CgroupDriver}}'; then
  printf 'Inventory incomplete. No permissions or services changed. Check existing sudo access / intended rootless Docker context.\n'
  exit 2
fi
printf '\n== CONTAINERS (INCLUDING STOPPED) ==\n'
query ps -a --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' || exit 2
printf '\n== CURRENT USAGE (NOT PEAKS) ==\n'
query stats --no-stream --format '{{.Name}} CPU={{.CPUPerc}} MEM={{.MemUsage}} MEM_PERCENT={{.MemPerc}} PIDS={{.PIDs}}' || exit 2
printf '\n== LIMITS / HEALTH / STORAGE TARGETS ==\n'
# IDs are only used as Docker arguments after a successful listing, never eval.
container_ids=$(docker ps -aq 2>/dev/null) || { printf 'containerList=failed\n'; exit 2; }
for container_id in $container_ids; do
  [[ "$container_id" =~ ^[a-f0-9]+$ ]] || { printf 'containerId=invalid\n'; exit 2; }
  query inspect --format '{{.Name}} running={{.State.Running}} oomKilled={{.State.OOMKilled}} restarts={{.RestartCount}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}unconfigured{{end}} memoryBytes={{.HostConfig.Memory}} memoryReservationBytes={{.HostConfig.MemoryReservation}} memorySwapBytes={{.HostConfig.MemorySwap}} nanoCpus={{.HostConfig.NanoCpus}} cpuQuota={{.HostConfig.CpuQuota}} cpuPeriod={{.HostConfig.CpuPeriod}} cpuShares={{.HostConfig.CpuShares}} cpuset={{.HostConfig.CpusetCpus}} pidsLimit={{.HostConfig.PidsLimit}} restartPolicy={{.HostConfig.RestartPolicy.Name}} logDriver={{.HostConfig.LogConfig.Type}} logMaxSize={{index .HostConfig.LogConfig.Config "max-size"}} logMaxFile={{index .HostConfig.LogConfig.Config "max-file"}} mounts={{range .Mounts}}{{.Type}}:{{.Destination}}:rw={{.RW}} {{end}}' "$container_id" || exit 2
done
printf '\nMemory=0 / nanoCpus=0 means no corresponding explicit cap; CPU quota/cpuset may still apply. Reservations are not exclusive physical RAM.\n'
printf 'Rootful inventory does not establish absence of separate rootless Docker daemons. No logs/env/credentials queried.\n'
printf '== END: NO SERVICES OR RESOURCES CHANGED ==\n'
