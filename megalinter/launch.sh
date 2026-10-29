#!/usr/bin/env bash
set -euo pipefail
# Install shared configs into the checked-out repository, run MegaLinter in a podman
# container against it and always remove the container and the installed configs.
# cspell:ignore abrt epochseconds gomodcache megalipase shlvl
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
# Names the action always passes itself, ignored in MEGALIPASE.
auto_vars=(DEFAULT_WORKSPACE GITHUB_WORKSPACE GITHUB_ACTIONS MEGALINTER_CONFIG
  GITHUB_OUTPUT GITHUB_STEP_SUMMARY GITHUB_EVENT_PATH
  "${proxy_vars[@]}" "${github_vars[@]}")
# Variables bash sets itself, a shell of the step and launch.sh replace their
# values, so MEGALIPASE cannot pass them.
bash_vars=(BASH BASHOPTS BASHPID BASH_ALIASES BASH_ARGC BASH_ARGV BASH_ARGV0
  BASH_CMDS BASH_COMMAND BASH_LINENO BASH_REMATCH BASH_SOURCE BASH_SUBSHELL
  BASH_VERSINFO BASH_VERSION COMP_WORDBREAKS DIRSTACK EPOCHREALTIME EPOCHSECONDS
  EUID FUNCNAME GROUPS HISTCMD IFS LINENO OPTERR OPTIND PIPESTATUS PPID PWD
  RANDOM SECONDS SHELLOPTS SHLVL SRANDOM UID)
# Variables named in MEGALIPASE, filled by check_pass_env.
pass_vars=()
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
# Collect the variables named in MEGALIPASE into pass_vars and log every bad
# name; a variable counts as set only when it is exported and not empty.
check_pass_env() {
  local name list rc=0
  local -a names
  local -A seen=()
  # turn Unicode spaces like U+2003 into plain ones, also the non-breaking
  # U+00A0, U+2007, U+202F and NEL U+0085 that the locale does not count as
  # space; sed falls back to ASCII when the locale is missing
  # shellcheck disable=SC2001
  if ! list="$(LC_ALL=C.UTF-8 sed -e 's/[[:space:]]/ /g' \
    -e $'s/\xc2\xa0/ /g; s/\xe2\x80\x87/ /g; s/\xe2\x80\xaf/ /g; s/\xc2\x85/ /g' \
    <<<"${MEGALIPASE:-}")"; then
    log 'MEGALIPASE: cannot split the list'
    return 2
  fi
  # split on any whitespace, also on the CR of CRLF; read stops at the end of
  # the input with status 1
  local IFS=$' \t\n\r\v\f'
  read -r -d '' -a names <<<"${list}" || true
  for name in "${names[@]}"; do
    if [[ ! "${name}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      log "MEGALIPASE: invalid variable name ${name}"
      rc=2
      continue
    fi
    if [[ -n "${seen[${name}]:-}" ]] || in_list "${name}" "${auto_vars[@]}"; then
      continue
    fi
    seen["${name}"]=1
    if in_list "${name}" "${bash_vars[@]}"; then
      log "MEGALIPASE: ${name} is set by bash and cannot be passed"
      rc=2
      continue
    fi
    if [[ -z "${!name:-}" || "${!name@a}" != *x* ]]; then
      log "MEGALIPASE: ${name} is not set or empty"
      rc=2
      continue
    fi
    pass_vars+=("${name}")
  done
  return "${rc}"
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
  local name rc=0
  local -a args extra
  args=(run --rm --network=host --http-proxy=false "--name=${container}"
    -v "${workspace}:${lint_dir}" -w "${lint_dir}" -e "DEFAULT_WORKSPACE=${lint_dir}"
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
  # only the variables named in MEGALIPASE, podman takes the values from its env
  for name in "${pass_vars[@]}"; do
    args+=(-e "${name}")
  done
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
# A bad MEGALIPASE fails the step before any config is installed or container run.
check_pass_env || exit 2
# Always remove the container and the installed configs; a signal exits through
# the EXIT trap, so the cleanup runs once and the rest of the script is skipped.
trap cleanup EXIT
trap 'exit 1' INT QUIT ABRT TERM
prepare
run_megalinter
