#!/usr/bin/env bash
set -euo pipefail
# Install shared configs into the checked-out repository, run MegaLinter in a podman
# container against it and always remove the container and the installed configs.
# cspell:ignore abrt gomodcache
action_dir="${GITHUB_ACTION_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
workspace="${GITHUB_WORKSPACE:-${PWD}}"
defaults_dir="${action_dir}/configs"
manifest="${RUNNER_TEMP:-/tmp}/megalinter-installed-${GITHUB_RUN_ID:-local}.list"
override_rel="${OVERRIDE_DIR:-.megalinter}"
override_dir="${workspace}/${override_rel}"
action_config='.megalinter-action.yml'
megalinter_configs=(.mega-linter.yml .megalinter.yml .mega-linter.yaml .megalinter.yaml)
eslint_legacy=(
  .eslintrc .eslintrc.json .eslintrc.yml .eslintrc.yaml .eslintrc.js .eslintrc.cjs
)
image="${MEGALINTER_IMAGE:-ghcr.io/oxsecurity/megalinter:v9}"
container="megalinter-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
lint_dir='/tmp/lint'
# PID of the background podman client while it runs, empty otherwise.
pid=''
proxy_vars=(HTTP_PROXY http_proxy HTTPS_PROXY https_proxy SOCKS_PROXY socks_proxy
  ALL_PROXY all_proxy NO_PROXY no_proxy)
# GitHub variables read by MegaLinter, the runner exports all but the last two.
github_vars=(GITHUB_REPOSITORY GITHUB_SHA GITHUB_REF GITHUB_HEAD_REF GITHUB_REF_NAME
  GITHUB_EVENT_NAME GITHUB_RUN_ID GITHUB_SERVER_URL GITHUB_API_URL GITHUB_WORKFLOW
  GITHUB_JOB GITHUB_JOB_URL GITHUB_TARGET_URL)
# Step env names that are passed explicitly or must not reach the container.
skip_vars=(PATH HOME HOSTNAME PWD MEGALINTER_STEP_ENV MEGALINTER_IMAGE PODMAN_ARGS
  MEGALINTER_GOMODCACHE MEGALINTER_CONFIG DEFAULT_WORKSPACE GITHUB_WORKSPACE
  GITHUB_OUTPUT GITHUB_STEP_SUMMARY GITHUB_EVENT_PATH GITHUB_ACTIONS
  "${proxy_vars[@]}" "${github_vars[@]}")
# A top-level key line of toJSON(env): values are strings, so keys start the line.
env_key_re='^[[:space:],]*"([A-Za-z_][A-Za-z0-9_]*)":'
# jscpd:ignore-start
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
# jscpd:ignore-end
# An empty proxy set in the step env stays exported, drop it before "-e NAME".
for proxy in "${proxy_vars[@]}"; do
  [[ -n "${!proxy:-}" ]] || unset "${proxy}"
done
log() {
  printf 'megalinter: %s\n' "$*"
}
in_list() {
  local item="$1" entry
  shift
  for entry in "$@"; do
    if [[ "${entry}" == "${item}" ]]; then
      return 0
    fi
  done
  return 1
}
is_eslint_config() {
  [[ "$1" == eslint.config.* ]] || in_list "$1" "${eslint_legacy[@]}"
}
prepare() {
  local name src dst default_src override_src config='' override_path
  local -A seen=()
  local -a names=() root_eslint=() override_eslint=() ignored=()
  : >"${manifest}"
  shopt -s dotglob nullglob
  # any existing entry occupies the name, including dirs and dangling symlinks
  for src in "${workspace}"/eslint.config.*; do
    root_eslint+=("${src##*/}")
  done
  for name in "${eslint_legacy[@]}"; do
    if [[ -e "${workspace}/${name}" || -L "${workspace}/${name}" ]]; then
      root_eslint+=("${name}")
    fi
  done
  for src in "${defaults_dir}"/*; do
    name="${src##*/}"
    # the action default MegaLinter config is installed under its own name
    if [[ "${name}" == '.megalinter.yml' ]]; then
      name="${action_config}"
    fi
    if [[ -z "${seen[${name}]:-}" ]]; then
      seen["${name}"]=1
      names+=("${name}")
    fi
  done
  if [[ -d "${override_dir}" ]]; then
    for src in "${override_dir}"/*; do
      name="${src##*/}"
      if [[ ! -f "${src}" ]]; then
        log "skip non-file ${override_rel%/}/${name}"
        continue
      fi
      # repo MegaLinter configs are passed via MEGALINTER_CONFIG, not copied
      if in_list "${name}" "${megalinter_configs[@]}"; then
        continue
      fi
      if is_eslint_config "${name}"; then
        override_eslint+=("${name}")
      fi
      if [[ -z "${seen[${name}]:-}" ]]; then
        seen["${name}"]=1
        names+=("${name}")
      fi
    done
  else
    log "override dir ${override_rel} not found, using defaults only"
  fi
  for name in "${names[@]}"; do
    dst="${workspace}/${name}"
    override_src="${override_dir}/${name}"
    default_src="${defaults_dir}/${name}"
    if [[ "${name}" == "${action_config}" ]]; then
      default_src="${defaults_dir}/.megalinter.yml"
    fi
    if [[ -e "${dst}" || -L "${dst}" ]]; then
      log "keep repo file ${name}"
      continue
    fi
    if [[ "${name}" == eslint.config.* && ${#root_eslint[@]} -gt 0 ]]; then
      log "skip ${name}: repo ESLint config found: ${root_eslint[*]}"
      continue
    fi
    if [[ -f "${override_src}" ]]; then
      install -m 0644 -- "${override_src}" "${dst}"
      log "install override ${name}"
    elif [[ "${name}" == eslint.config.* && ${#override_eslint[@]} -gt 0 ]]; then
      log "skip default ${name}: ESLint config in ${override_rel}: ${override_eslint[*]}"
      continue
    elif [[ -f "${default_src}" ]]; then
      install -m 0644 -- "${default_src}" "${dst}"
      log "install default ${name}"
    else
      log "skip non-file configs/${default_src##*/}"
      continue
    fi
    printf '%s\0' "${name}" >>"${manifest}"
  done
  if [[ -n "${MEGALINTER_CONFIG:-}" ]]; then
    config="${MEGALINTER_CONFIG}"
    log "keep preset MEGALINTER_CONFIG ${config}"
  else
    for name in "${megalinter_configs[@]}"; do
      if [[ -f "${workspace}/${name}" ]]; then
        if [[ -z "${config}" ]]; then
          config="${name}"
        else
          ignored+=("${name}")
        fi
      fi
    done
    if [[ -d "${override_dir}" && ! "${override_dir}" -ef "${workspace}" ]]; then
      override_path="${override_rel%/}"
      override_path="${override_path#./}"
      for name in "${megalinter_configs[@]}"; do
        if [[ -f "${override_dir}/${name}" ]]; then
          if [[ -z "${config}" ]]; then
            config="${override_path}/${name}"
          else
            ignored+=("${override_path}/${name}")
          fi
        fi
      done
    fi
    for name in "${ignored[@]}"; do
      log "ignore MegaLinter config ${name}"
    done
    if [[ -z "${config}" ]]; then
      config="${action_config}"
    fi
    log "use MegaLinter config ${config}"
  fi
  # a host path in the repository must point into its mount in the container
  if [[ "${config}" == "${workspace}/"* ]]; then
    config="${lint_dir}/${config#"${workspace}/"}"
  fi
  export MEGALINTER_CONFIG="${config}"
}
remove_container() {
  # podman 3.4 has no "rm --time", kill first so that "rm -f" does not wait to stop
  podman kill "${container}" >/dev/null 2>&1 || true
  podman rm -f "${container}" >/dev/null 2>&1 || true
}
cleanup() {
  local name
  # a repeated signal of the runner must not interrupt the cleanup
  trap '' INT QUIT ABRT TERM
  # stop a podman client still pulling or starting, so it cannot create the
  # container after the cleanup, then remove the container it may have created;
  # "jobs -pr" lists running jobs only, so a reaped client PID is never signalled
  if [[ -n "${pid}" && -n "$(jobs -pr)" ]]; then
    kill "${pid}" 2>/dev/null || true
    remove_container
    wait "${pid}" 2>/dev/null || true
  fi
  remove_container
  [[ -f "${manifest}" ]] || return 0
  while IFS= read -r -d '' name; do
    [[ -z "${name}" ]] && continue
    rm -f -- "${workspace}/${name}"
    log "cleanup ${name}"
  done <"${manifest}"
  rm -f -- "${manifest}"
}
file_command() {
  local name="$1" path="$2" target="$3" mode="${4:-}"
  [[ -n "${path}" && -f "${path}" ]] || return 0
  # a target directory keeps the host file name, like the runner file commands
  [[ "${target}" == */ ]] && target+="${path##*/}"
  args+=(-v "${path}:${target}${mode}" -e "${name}=${target}")
}
run_megalinter() {
  local name line rc=0
  local -a args extra
  args=(run --rm --network=host "--name=${container}" -v "${workspace}:${lint_dir}"
    -w "${lint_dir}" -e "DEFAULT_WORKSPACE=${lint_dir}"
    -e "GITHUB_WORKSPACE=${lint_dir}" -e GITHUB_ACTIONS=true -e MEGALINTER_CONFIG)
  for name in "${github_vars[@]}" "${proxy_vars[@]}"; do
    args+=(-e "${name}")
  done
  # host files of the runner file commands, mounted like a docker action gets them
  file_command GITHUB_OUTPUT "${GITHUB_OUTPUT:-}" /github/file_commands/
  file_command GITHUB_STEP_SUMMARY "${GITHUB_STEP_SUMMARY:-}" /github/file_commands/
  file_command GITHUB_EVENT_PATH "${GITHUB_EVENT_PATH:-}" /github/workflow/event.json :ro
  if [[ -n "${MEGALINTER_GOMODCACHE:-}" ]]; then
    args+=(-v "${MEGALINTER_GOMODCACHE}:/go/pkg/mod")
  fi
  # the workflow, job and step env, as a docker action receives it
  while IFS= read -r line; do
    if [[ "${line}" =~ ${env_key_re} ]]; then
      name="${BASH_REMATCH[1]}"
      case "${name}" in
      RUNNER_* | ACTIONS_*) continue ;;
      esac
      in_list "${name}" "${skip_vars[@]}" || args+=(-e "${name}")
    fi
  done <<<"${MEGALINTER_STEP_ENV:-}"
  # split into words on any whitespace like check-dir.sh does, but without globbing;
  # read stops at the end of the input with status 1
  read -r -d '' -a extra <<<"${PODMAN_ARGS:-}" || true
  args+=("${extra[@]}" "${image}")
  log "run ${image} as ${container}"
  # in the background, so the traps fire while MegaLinter runs
  podman "${args[@]}" &
  pid=$!
  wait "${pid}" || rc=$?
  pid=''
  return "${rc}"
}
# Always remove the container and the installed configs; a signal exits through
# the EXIT trap, so the cleanup runs once and the rest of the script is skipped.
trap cleanup EXIT
trap 'exit 1' INT QUIT ABRT TERM
prepare
run_megalinter
