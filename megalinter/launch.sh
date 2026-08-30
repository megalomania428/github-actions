#!/usr/bin/env bash
set -euo pipefail
action_dir="${GITHUB_ACTION_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
workspace="${GITHUB_WORKSPACE:-${PWD}}"
defaults_dir="${action_dir}/configs"
manifest="${RUNNER_TEMP:-/tmp}/megalinter-installed-${GITHUB_RUN_ID:-local}.list"
mode="${1:-}"
override_dir="${workspace}/${OVERRIDE_DIR:-.megalinter}"
case "${mode}" in
prepare)
  : >"${manifest}"
  shopt -s dotglob nullglob
  for src in "${defaults_dir}"/*; do
    name=$(basename -- "${src}")
    dst="${workspace}/${name}"
    override_src="${override_dir}/${name}"
    if [[ -e "${dst}" ]]; then
      printf 'megalinter: keep repo override %s\n' "${name}"
      continue
    fi
    if [[ -e "${override_src}" ]]; then
      install -m 0644 -- "${override_src}" "${dst}"
      printf 'megalinter: install override %s\n' "${name}"
    else
      install -m 0644 -- "${src}" "${dst}"
      printf 'megalinter: install default %s\n' "${name}"
    fi
    printf '%s\n' "${name}" >>"${manifest}"
  done
  ;;
cleanup)
  [[ -f "${manifest}" ]] || exit 0
  while IFS= read -r name; do
    [[ -z "${name}" ]] && continue
    rm -f -- "${workspace}/${name}"
    printf 'megalinter: cleanup %s\n' "${name}"
  done <"${manifest}"
  rm -f -- "${manifest}"
  ;;
*)
  printf 'megalinter/launch.sh: unknown mode %q\n' "${mode}" >&2
  exit 2
  ;;
esac
