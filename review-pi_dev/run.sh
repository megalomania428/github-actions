#!/usr/bin/env bash
set -ueo pipefail
# Entry point inside the review container. Warm up the metadata cache of the MCP
# servers with direct tools, so the agent sees those tools from its first request,
# then replace this shell with pi called with the arguments given by launch.sh.
# Both pi runs read only the MCP config passed by "--mcp-config", so MCP configs
# of the reviewed repository cannot change the servers.
export PI_MCP_CONFIG_MODE='exclusive'
warm_cfg='/opt/review/mcp-warm.json'
cache="${HOME}/.pi/agent/mcp-cache.json"
# Succeed only when every server of the warm-up config has a cache entry the
# adapter accepts: config hash, tool list, and an age below both its TTL and the
# adapter limit of seven days.
cache_complete() {
  node -e '
const fs = require("node:fs");
const read = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
let cached = {};
try {
  cached = read(process.argv[2]).servers ?? {};
} catch {
  cached = {};
}
const week = 7 * 24 * 60 * 60 * 1000;
const usable = (entry) => typeof entry?.configHash === "string" &&
  Array.isArray(entry.tools) && typeof entry.cachedAt === "number" &&
  entry.cachedAt > 0 && (entry.ttlMs === undefined || entry.ttlMs > 0) &&
  Date.now() - entry.cachedAt < Math.min(entry.ttlMs ?? week, week);
const missing = Object.keys(read(process.argv[1]).mcpServers ?? {})
  .filter((name) => !usable(cached[name]));
if (missing.length > 0) {
  console.error("MCP metadata cache misses: " + missing.join(" "));
  process.exit(1);
}
' "${warm_cfg}" "${cache}"
}
# Only the warm-up config is visible to this run, so pi connects just the direct
# servers; "/mcp status" waits for the MCP initialization without calling the LLM.
warm_up() {
  rm -f "${cache}"
  pi --no-session --no-context-files --mcp-config "${warm_cfg}" -p '/mcp status' &&
    cache_complete
}
if [[ -f "${warm_cfg}" ]]; then
  pauses=(3 9 15)
  attempt=0
  until warm_up; do
    if ((attempt >= ${#pauses[@]})); then
      echo "MCP warm-up failed after ${attempt} retries" >&2
      exit 1
    fi
    echo "MCP warm-up failed, retry $((attempt + 1)) in ${pauses[attempt]} seconds" >&2
    sleep "${pauses[attempt]}"
    attempt=$((attempt + 1))
  done
fi
# An existing cache file keeps the adapter from bootstrapping every server at start,
# so lazy servers stay disconnected even when nothing was warmed up.
[[ -f "${cache}" ]] || printf '{"version":1,"servers":{}}\n' >"${cache}"
exec pi --mcp-config "${HOME}/.pi/agent/mcp.json" "$@"
