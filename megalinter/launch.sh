#!/usr/bin/env bash
set -euo pipefail
action_dir="${GITHUB_ACTION_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
workspace="${GITHUB_WORKSPACE:-${PWD}}"
defaults_dir="${action_dir}/configs"
manifest="${RUNNER_TEMP:-/tmp}/megalinter-installed-${GITHUB_RUN_ID:-local}.list"
mode="${1:-}"
override_rel="${OVERRIDE_DIR:-.megalinter}"
override_dir="${workspace}/${override_rel}"
action_config='.megalinter-action.yml'
megalinter_configs=(.mega-linter.yml .megalinter.yml .mega-linter.yaml .megalinter.yaml)
eslint_legacy=(
  .eslintrc .eslintrc.json .eslintrc.yml .eslintrc.yaml .eslintrc.js .eslintrc.cjs
)
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
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf 'config=%s\n' "${config}" >>"${GITHUB_OUTPUT}"
  fi
}
cleanup() {
  local name
  [[ -f "${manifest}" ]] || return 0
  while IFS= read -r -d '' name; do
    [[ -z "${name}" ]] && continue
    rm -f -- "${workspace}/${name}"
    log "cleanup ${name}"
  done <"${manifest}"
  rm -f -- "${manifest}"
}
case "${mode}" in
prepare)
  prepare
  ;;
cleanup)
  cleanup
  ;;
*)
  printf 'megalinter/launch.sh: unknown mode %q\n' "${mode}" >&2
  exit 2
  ;;
esac
