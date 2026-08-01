#!/usr/bin/env bash
set -euo pipefail
# cspell:ignore abrt
export LLM_API_URL="${LLM_API_URL:-dummy}"
export LLM_API_TYPE="${LLM_API_TYPE:-dummy}"
export LLM_API_KEY="${LLM_API_KEY:-dummy}"
export LLM_API_MODEL="${LLM_API_MODEL:-dummy}"
export GITHUB_API_URL="${GITHUB_API_URL:-dummy}"
export GITHUB_REPOSITORY_NAME="${GITHUB_REPOSITORY_NAME:-dummy}"
export GITHUB_REPOSITORY_OWNER="${GITHUB_REPOSITORY_OWNER:-dummy}"
export GH_TOKEN="${GH_TOKEN:-dummy}"
# Locate the review config: prefer the file provided by the reviewed repository,
# otherwise fall back to the default shipped with this action.
action_dir="${GITHUB_ACTION_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
config_tpl='.github/review-simple.yaml'
[[ -f "${config_tpl}" ]] || config_tpl="${action_dir}/config.yaml"
# Create a private workspace and always clean it up, even on signals.
TMP="$(mktemp -d -t review-simple-XXXXXX)"
trap 'rm -rf "${TMP}"' INT QUIT ABRT TERM EXIT
cp "${config_tpl}" "${TMP}/config.yaml"
config_dst=/tmp/review-simple.yaml
export AI_REVIEW_CONFIG_FILE_YAML="${config_dst}"
# Resolve pull request number when the event context does not provide one
# (e.g. workflow_dispatch triggered from a feature branch). Looks up an open PR
# whose head branch matches the current ref via the GitHub REST API.
if [[ -z "${PR_NUMBER:-}" && "${GITHUB_REF_TYPE:-}" == "branch" &&
  "${GITHUB_EVENT_NAME:-}" != "pull_request" ]]; then
  pr_number="$(curl -fsSL -H "Authorization: Bearer ${GH_TOKEN}" -H "Accept: application\
/vnd.github+json" "${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY_OWNER}/\
${GITHUB_REPOSITORY_NAME}/pulls?head=${GITHUB_REPOSITORY_OWNER}:${GITHUB_REF_NAME}\
&state=open" | jq -r '.[0].number // empty' 2>/dev/null)" || pr_number=""
  export PR_NUMBER="${pr_number}"
fi
launcher=(
  /usr/bin/env podman run --rm --network=host -e GITHUB_ACTIONS -e GH_TOKEN -e PR_NUMBER
  -e LLM_API_KEY -e LLM_API_MODEL -e GITHUB_API_URL -e LLM_API_URL -e LLM_API_TYPE
  -e GITHUB_REPOSITORY_NAME -e GITHUB_REPOSITORY_OWNER -e AI_REVIEW_CONFIG_FILE_YAML
  -v "$(pwd):/tmp/review" -v "${TMP}/config.yaml:${config_dst}:ro"
  --name="ai-review-${GITHUB_RUN_ID:-$$}-${RANDOM}" -w /tmp/review
  ghcr.io/raven428/container-images/ai-review:latest
)
# When called via workflow_call a single REVIEW_COMMAND is passed; otherwise
# build the list from the boolean flags selected in the workflow_dispatch UI.
commands=()
if [[ -n "${REVIEW_COMMAND:-}" ]]; then
  commands=("${REVIEW_COMMAND}")
else
  [[ "${CMD_CLEAR_SUMMARY:-false}" == true ]] && commands+=(clear-summary)
  [[ "${CMD_CLEAR_INLINE:-false}" == true ]] && commands+=(clear-inline)
  [[ "${CMD_RUN:-false}" == true ]] && commands+=(run)
  [[ "${CMD_RUN_INLINE:-false}" == true ]] && commands+=(run-inline)
  [[ "${CMD_RUN_CONTEXT:-false}" == true ]] && commands+=(run-context)
  [[ "${CMD_RUN_SUMMARY:-false}" == true ]] && commands+=(run-summary)
  [[ "${CMD_RUN_INLINE_REPLY:-false}" == true ]] && commands+=(run-inline-reply)
  [[ "${CMD_RUN_SUMMARY_REPLY:-false}" == true ]] && commands+=(run-summary-reply)
fi
if ((${#commands[@]} == 0)); then
  echo "No review commands selected" >&2
  exit 1
fi
# shellcheck disable=SC2016
inner_script='ai-review show-config && for cmd in "$@"; do ai-review "$cmd" || exit; done'
inner=(bash -c "${inner_script}" _)
for cmd in "${commands[@]}"; do
  inner+=("${cmd}")
done
"${launcher[@]}" "${inner[@]}"
