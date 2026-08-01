#!/usr/bin/env bash
set -ueo pipefail
# Prepare an opencode config from a YAML template and run the opencode review
# container against the checked-out repository. Placeholders "env<NAME>" in the
# template are replaced by the value of the "<NAME>" environment variable.
# cspell:ignore argjson subst abrt gsub
export LLM_API_MODEL="${LLM_API_MODEL:-dummy}"
export LLM_API_URL="${LLM_API_URL:-dummy}"
export LLM_API_KEY="${LLM_API_KEY:-dummy}"
export GITHUB_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-dummy}}"
export GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN}}"
export SEARCH_MCP_URL="${SEARCH_MCP_URL:-dummy}"
export SEARCH_MCP_KEY="${SEARCH_MCP_KEY:-dummy}"
export FETCH_MCP_URL="${FETCH_MCP_URL:-dummy}"
export FETCH_MCP_KEY="${FETCH_MCP_KEY:-dummy}"
export GITHUB_API_URL="${GITHUB_API_URL:-https://api.github.com}"
export GITHUB_REPOSITORY_OWNER="${GITHUB_REPOSITORY_OWNER:-dummy}"
export GITHUB_REPOSITORY_NAME="${GITHUB_REPOSITORY_NAME:-dummy}"
IMAGE="${IMAGE:-ghcr.io/raven428/container-images/opencode-debian13:latest}"
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
# Locate the template config and prompt: prefer files provided by the reviewed
# repository, otherwise fall back to the defaults shipped with this action.
action_dir="${GITHUB_ACTION_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
config_tpl='.github/review-opencode.yaml'
prompt_tpl='.github/review-opencode.md'
[[ -f "${config_tpl}" ]] || config_tpl="${action_dir}/config.yaml"
[[ -f "${prompt_tpl}" ]] || prompt_tpl="${action_dir}/main.md"
# Create a private workspace and always clean it up, even on signals.
TMP="$(mktemp -d -t review-opencode-XXXXXX)"
trap 'rm -rf "${TMP}"' INT QUIT ABRT TERM EXIT
# Convert the template to JSON and replace every "env<NAME>" placeholder with the
# value of the matching environment variable. Works for string values (keeping a
# "Bearer " prefix) and for object keys such as the model name.
yq -o=json -P '.' "${config_tpl}" | jq --argjson env "$(jq -n 'env')" 'def subst:
  if type == "string" then
    gsub("env(?<n>[A-Z_]+)"; ($env[.n] // ("env" + .n)))
  elif type == "object" then
    with_entries(.key |= subst | .value |= subst)
  elif type == "array" then
    map(subst)
  else . end;
subst' >"${TMP}/opencode.json"
cp "${prompt_tpl}" "${TMP}/CLAUDE.md"
# Build the review request passed to "opencode run". The reviewer role and rules
# live in CLAUDE.md; this message only names the concrete pull request.
message="Review pull request #${PR_NUMBER} in repository \
${GITHUB_REPOSITORY_OWNER}/${GITHUB_REPOSITORY_NAME}. Use the github MCP tools to \
read the pull request diff and existing comments and to publish your findings."
# Secrets are baked into opencode.json, so no environment is forwarded into the
# container. The repository is mounted so relative instruction paths resolve.
# Redirect stderr to stdout ("2>&1") so container error output shows up in the CI
# log alongside stdout.
podman run --rm --network=host -v "$(pwd):/workspace/repo" -w /workspace/repo \
  -v "${TMP}/CLAUDE.md:/home/coder/.claude/CLAUDE.md:ro" \
  -v "${TMP}/opencode.json:/home/coder/.config/opencode/opencode.json:ro" \
  --name "review-opencode-${GITHUB_RUN_ID:-$$}-${RANDOM}" "${IMAGE}" opencode run \
  --agent build --model "review/${LLM_API_MODEL}" "${message}" 2>&1
