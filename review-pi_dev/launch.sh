#!/usr/bin/env bash
set -ueo pipefail
# Prepare pi configs from a YAML template and run the pi review container against
# the checked-out repository. Placeholders "env<NAME>" in the template are replaced
# by the value of the "<NAME>" environment variable, and values equal to
# "json<NAME>" by the value of "<NAME>" parsed as JSON.
# cspell:ignore argjson subst abrt gsub fromjson
export LLM_NAME="${LLM_NAME:-review}"
export LLM_URL="${LLM_URL:-dummy}"
export LLM_API="${LLM_API:-openai-responses}"
export LLM_KEY="${LLM_KEY:-dummy}"
export LLM_EFF="${LLM_EFF:-true}"
export LLM_RSN="${LLM_RSN:-true}"
export LLM_CTX="${LLM_CTX:-1000000}"
export LLM_MAX="${LLM_MAX:-131072}"
export LLM_LVL="${LLM_LVL:-max}"
export LLM_RETRIES="${LLM_RETRIES:-111}"
# jscpd:ignore-start
export GITHUB_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-dummy}}"
export GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN}}"
export SEARCH_MCP_URL="${SEARCH_MCP_URL:-dummy}"
export SEARCH_MCP_KEY="${SEARCH_MCP_KEY:-dummy}"
export FETCH_MCP_URL="${FETCH_MCP_URL:-dummy}"
export FETCH_MCP_KEY="${FETCH_MCP_KEY:-dummy}"
export GITHUB_API_URL="${GITHUB_API_URL:-https://api.github.com}"
export GITHUB_REPOSITORY_OWNER="${GITHUB_REPOSITORY_OWNER:-dummy}"
export GITHUB_REPOSITORY_NAME="${GITHUB_REPOSITORY_NAME:-dummy}"
IMAGE="${IMAGE:-ghcr.io/raven428/review-pi_dev:latest}"
# Export a proxy variable only when it has a value, so an unset/empty proxy
# never overwrites what podman would otherwise leave untouched in the container.
maybe_export() {
  local name=$1 value=$2
  [[ -z "${value}" ]] && return 0
  export "${name}=${value}"
}
maybe_export HTTP_PROXY "${HTTP_PROXY:-${http_proxy:-}}"
maybe_export http_proxy "${http_proxy:-${HTTP_PROXY:-}}"
maybe_export HTTPS_PROXY "${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-}}}"
maybe_export https_proxy "${https_proxy:-${HTTPS_PROXY:-${HTTP_PROXY:-}}}"
maybe_export SOCKS_PROXY "${SOCKS_PROXY:-${socks_proxy:-}}"
maybe_export socks_proxy "${socks_proxy:-${SOCKS_PROXY:-}}"
maybe_export ALL_PROXY "${ALL_PROXY:-${all_proxy:-${SOCKS_PROXY:-}}}"
maybe_export all_proxy "${all_proxy:-${ALL_PROXY:-${SOCKS_PROXY:-}}}"
maybe_export NO_PROXY "${NO_PROXY:-${no_proxy:-}}"
maybe_export no_proxy "${no_proxy:-${NO_PROXY:-}}"
# Resolve the repository name from GITHUB_REPOSITORY (owner/name) when needed.
if [[ "${GITHUB_REPOSITORY_NAME}" == 'dummy' && -n "${GITHUB_REPOSITORY:-}" ]]; then
  GITHUB_REPOSITORY_OWNER="${GITHUB_REPOSITORY%%/*}"
  GITHUB_REPOSITORY_NAME="${GITHUB_REPOSITORY##*/}"
  export GITHUB_REPOSITORY_OWNER GITHUB_REPOSITORY_NAME
fi
# Resolve pull request number when the event context does not provide one
# (e.g. workflow_dispatch triggered from a feature branch). Looks up an open PR
# whose head branch matches the current ref via the GitHub REST API.
if [[ -z "${PR_NUMBER:-}" && "${GITHUB_REF_TYPE:-}" == 'branch' &&
  "${GITHUB_EVENT_NAME:-}" != 'pull_request' ]]; then
  pr_number="$(curl -fsSL -H "Authorization: Bearer ${GH_TOKEN}" \
    -H 'Accept: application/vnd.github+json' \
    "${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY_OWNER}/${GITHUB_REPOSITORY_NAME}\
/pulls?head=${GITHUB_REPOSITORY_OWNER}:${GITHUB_REF_NAME:-}&state=open" |
    jq -r '.[0].number // empty')" || pr_number=''
  export PR_NUMBER="${pr_number}"
fi
if [[ -z "${PR_NUMBER:-}" ]]; then
  echo 'No pull request number resolved' >&2
  exit 1
fi
# Fork code must not run next to review secrets in CI. Fork pull requests and failed
# lookups are refused; fork reviews use workstation chat apps outside this action.
if [[ "${GITHUB_ACTIONS:-}" == 'true' ]] &&
  ! curl -fsSL --connect-timeout 10 --max-time 30 \
    -H "Authorization: Bearer ${GH_TOKEN}" -H 'Accept: application/vnd.github+json' \
    "${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY_OWNER}/${GITHUB_REPOSITORY_NAME}\
/pulls/${PR_NUMBER}" |
  jq -e '.head.repo.id as $head | ($head | type) == "number" and $head > 0 and
    $head == .base.repo.id' >/dev/null; then
  echo "Pull request #${PR_NUMBER} comes from a fork or cannot be checked: fork code" \
    'must not run next to review secrets in CI; review it from a workstation' >&2
  exit 1
fi
# jscpd:ignore-end
# Locate the prompt and the config of the reviewed repository, otherwise fall back to
# the defaults shipped with this action.
action_dir="${GITHUB_ACTION_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
config_usr='.github/review-pi_dev.yaml'
prompt_tpl='.github/review-pi_dev.md'
[[ -f "${prompt_tpl}" ]] || prompt_tpl="${action_dir}/main.md"
# Create a private workspace and always clean it up, even on signals.
TMP="$(mktemp -d -t review-pi_dev-XXXXXX)"
trap 'rm -rf "${TMP}"' INT QUIT ABRT TERM EXIT
# Read the repository config apart from the jq call, so a broken YAML fails the run.
config_usr_json='null'
if [[ -f "${config_usr}" ]]; then
  config_usr_json="$(yq -o=json '.' "${config_usr}")"
fi
# Build every section from the shipped config.yaml: the same section of the repository
# config replaces its "defaults" unless missing or null, and its "mandatory" part is
# merged recursively under the result, so it only adds the keys left unset. Then convert
# the template to JSON and replace the placeholders: "env<NAME>" inside any string or
# object key becomes the string value of the variable, while a value equal to
# "json<NAME>" becomes the value of the variable parsed as JSON. An invalid JSON value
# fails the run here instead of producing a config pi cannot read.
yq -o=json -P '.' "${action_dir}/config.yaml" | jq --argjson usr "${config_usr_json}" \
  'with_entries(.key as $k | .value |= (.defaults as $d |
  .mandatory * ($usr[$k] | if . == null then $d else . end)))' |
  jq --argjson env "$(jq -n 'env')" 'def str:
  gsub("env(?<n>[A-Z_]+)"; ($env[.n] // ("env" + .n)));
def subst:
  if type == "string" then
    if test("^json[A-Z_]+$") and $env[.[4:]] != null then $env[.[4:]] | fromjson
    else str end
  elif type == "object" then
    with_entries(.key |= str | .value |= subst)
  elif type == "array" then
    map(subst)
  else . end;
subst' >"${TMP}/config.json"
# Split the sections into the files pi reads from its agent directory.
for part in settings models mcp; do
  jq -e --arg part "${part}" '.[$part]' "${TMP}/config.json" >"${TMP}/${part}.json"
done
# Servers whose URL was left unset (the "dummy" default) cannot be connected, so
# they are dropped from the effective MCP config instead of failing the warm-up.
jq '.mcpServers |= ((. // {}) | with_entries(select(.value.url != "dummy")))' \
  "${TMP}/mcp.json" >"${TMP}/mcp-live.json"
mv "${TMP}/mcp-live.json" "${TMP}/mcp.json"
# Enabled servers with direct tools, set per server or by the global default, are
# warmed up before the review, so their tools are registered from the metadata
# cache on the first request; the rest stay lazy.
jq '(.settings.directTools // false) as $all | .mcpServers |= ((. // {}) |
  with_entries(select(.value.disabled != true and (if .value | has("directTools")
  then .value.directTools else $all end) != false)))' "${TMP}/mcp.json" \
  >"${TMP}/mcp-warm.json"
cp "${prompt_tpl}" "${TMP}/main.md"
podman_args=(-v "${TMP}/main.md:/opt/review/main.md:ro"
  -v "${action_dir}/log.ts:/opt/review/log.ts:ro"
  -v "${action_dir}/retry.ts:/opt/review/retry.ts:ro")
if jq -e '.mcpServers | length > 0' "${TMP}/mcp-warm.json" >/dev/null; then
  podman_args+=(-v "${TMP}/mcp-warm.json:/opt/review/mcp-warm.json:ro")
fi
# The review rules come from main.md; context files of the reviewed repository are
# not loaded, except copilot-instructions.md, which may extend or override the rules.
pi_args=(--no-session --no-context-files --append-system-prompt /opt/review/main.md)
if [[ -f '.github/copilot-instructions.md' ]]; then
  pi_args+=(--append-system-prompt /workspace/repo/.github/copilot-instructions.md)
fi
# The log.ts extension streams the prompt, thinking, answers and tool calls with their
# output to stderr, so the CI log shows the review progress live. The retry.ts extension
# retries failed LLM requests and must load after log.ts, which prints its notices.
pi_args+=(-e /opt/review/log.ts -e /opt/review/retry.ts)
# Build the review request passed to pi. The reviewer role and rules live in
# main.md; this message only names the concrete pull request.
message="Review pull request #${PR_NUMBER} in repository \
${GITHUB_REPOSITORY_OWNER}/${GITHUB_REPOSITORY_NAME}. Connect the github MCP server \
through the mcp tool, read the pull request diff and existing comments and publish \
your findings."
# Secrets are baked into the pi configs, so only the proxy variables are forwarded
# into the container. Redirect stderr to stdout ("2>&1") so container error output
# shows up in the CI log alongside stdout.
podman run --rm --network=host -v "$(pwd):/workspace/repo" -w /workspace/repo \
  -e all_proxy -e ALL_PROXY -e HTTP_PROXY -e HTTPS_PROXY -e http_proxy -e https_proxy \
  -e SOCKS_PROXY -e socks_proxy -e NO_PROXY -e no_proxy \
  -v "${TMP}/settings.json:/home/coder/.pi/agent/settings.json:ro" \
  -v "${TMP}/models.json:/home/coder/.pi/agent/models.json:ro" \
  -v "${TMP}/mcp.json:/home/coder/.pi/agent/mcp.json:ro" \
  -v "${action_dir}/run.sh:/opt/review/run.sh:ro" "${podman_args[@]}" \
  --name "review-pi_dev-${GITHUB_RUN_ID:-$$}-${RANDOM}" "${IMAGE}" \
  bash /opt/review/run.sh "${pi_args[@]}" -p "${message}" 2>&1
