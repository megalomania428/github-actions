#!/usr/bin/env bash
set -euo pipefail
# Check how launch.sh splits MEGALIPASE, a fake podman records its arguments
# instead of running MegaLinter.
# cspell:ignore epochseconds megalipase shlvl
launch="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/launch.sh"
tmp="$(mktemp -d)"
trap 'rm -rf -- "${tmp}"' EXIT
mkdir -p "${tmp}/bin" "${tmp}/ws"
cat >"${tmp}/bin/podman" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$1" >>"${PODMAN_LOG}.calls"
if [[ "$1" == run ]]; then
  printf '%s\n' "$@" >"${PODMAN_LOG}"
fi
exit 0
EOF
chmod +x "${tmp}/bin/podman"
# A sed that always fails, to check that launch.sh stops when it cannot split
# MEGALIPASE.
mkdir -p "${tmp}/bad-sed"
printf '#!/bin/sh\nexit 1\n' >"${tmp}/bad-sed/sed"
chmod +x "${tmp}/bad-sed/sed"
failed=0
# Remove what an earlier case left, also when it was killed: a FIFO would block
# the writes, installed configs would look like a changed workspace.
reset() {
  rm -rf -- "${tmp}/ws" "${tmp}/args" "${tmp}/args.calls" \
    "${tmp}/megalinter-installed-local.list"
  mkdir -p "${tmp}/ws"
}
# Run launch.sh with MEGALIPASE set to the list, every variable must pass the
# given number of times, once by default. A launch.sh that hangs fails after
# 10 seconds with exit 124, or 137 when it ignores the TERM signal.
check() {
  local title="$1" list="$2" want="${3:-1}" name count rc=0
  local manifest="${tmp}/megalinter-installed-local.list" left
  reset
  (cd "${tmp}/ws" && timeout -k 1 10 env -i PATH="${tmp}/bin:/usr/bin:/bin" \
    HOME="${HOME}" GITHUB_WORKSPACE="${tmp}/ws" RUNNER_TEMP="${tmp}" \
    PODMAN_LOG="${tmp}/args" \
    VAR_A=a VAR_B=b VAR_C=c VAR_D=d MEGALIPASE="${list}" bash "${launch}") \
    >"${tmp}/log" 2>&1 || rc=$?
  if [[ "${rc}" -ne 0 ]]; then
    printf 'FAIL %s: exit %s\n' "${title}" "${rc}"
    cat "${tmp}/log"
    failed=1
    return 0
  fi
  if [[ ! -f "${tmp}/args" ]]; then
    printf 'FAIL %s: podman run was not called\n' "${title}"
    cat "${tmp}/log"
    failed=1
    return 0
  fi
  # the cleanup removes the installed configs and their manifest, and keeps the
  # workspace directory
  if [[ ! -d "${tmp}/ws" || -L "${tmp}/ws" || -e "${manifest}" || -L "${manifest}" ]] ||
    [[ -n "$(find "${tmp}/ws" -mindepth 1 -print -quit)" ]]; then
    left="$(find "${tmp}/ws" "${manifest}" -maxdepth 1 2>/dev/null | tr '\n' ' ' || true)"
    [[ -d "${tmp}/ws" && ! -L "${tmp}/ws" ]] || left="no workspace directory ${left}"
    printf 'FAIL %s: cleanup left %s\n' "${title}" "${left}"
    cat "${tmp}/log"
    failed=1
    return 0
  fi
  for name in VAR_A VAR_B VAR_C VAR_D; do
    count="$(grep -cx -- "${name}" "${tmp}/args" || true)"
    if [[ "${count}" -ne "${want}" ]]; then
      printf 'FAIL %s: %s passed %s times\n' "${title}" "${name}" "${count}"
      failed=1
      return 0
    fi
  done
  printf 'ok %s\n' "${title}"
}
# Run launch.sh with MEGALIPASE set to the list and extra variables in the
# environment, it must fail with exit code 2 and log the message before it
# installs configs, calls podman or cleans up the files of an earlier run.
check_error() {
  local title="$1" list="$2" message="$3" rc=0 bad=''
  local manifest="${tmp}/megalinter-installed-local.list"
  shift 3
  reset
  # a file of an earlier run and its manifest, a cleanup would remove both
  printf 'keep\n' >"${tmp}/ws/keep.txt"
  printf 'keep.txt\0' >"${manifest}"
  (cd "${tmp}/ws" && timeout -k 1 10 env -i PATH="${tmp}/bin:/usr/bin:/bin" \
    HOME="${HOME}" GITHUB_WORKSPACE="${tmp}/ws" RUNNER_TEMP="${tmp}" \
    PODMAN_LOG="${tmp}/args" \
    VAR_A=a "$@" MEGALIPASE="${list}" bash "${launch}") >"${tmp}/log" 2>&1 ||
    rc=$?
  if [[ "${rc}" -ne 2 ]] || ! grep -qF -- "${message}" "${tmp}/log"; then
    bad="exit ${rc}"
  elif [[ -f "${tmp}/args.calls" ]]; then
    bad="podman called: $(tr '\n' ' ' <"${tmp}/args.calls")"
  elif [[ ! -f "${manifest}" || -L "${manifest}" ]] ||
    ! printf 'keep.txt\0' | cmp -s - "${manifest}" ||
    [[ ! -f "${tmp}/ws/keep.txt" || -L "${tmp}/ws/keep.txt" ]] ||
    ! printf 'keep\n' | cmp -s - "${tmp}/ws/keep.txt" ||
    [[ "$(ls -A "${tmp}/ws")" != keep.txt ]]; then
    # shellcheck disable=SC2012
    bad="workspace changed: $(ls -A "${tmp}/ws" | tr '\n' ' ')"
  fi
  rm -rf -- "${tmp}/ws" "${manifest}"
  mkdir -p "${tmp}/ws"
  if [[ -n "${bad}" ]]; then
    printf 'FAIL %s: %s\n' "${title}" "${bad}"
    cat "${tmp}/log"
    failed=1
    return 0
  fi
  printf 'ok %s\n' "${title}"
}
# Run check on a copy of launch.sh with a broken cleanup: the line replaces the
# removal of the manifest. Check must fail and its first line tells what is left.
check_cleanup() {
  local title="$1" line="$2" want="$3" out rc=0
  rm -rf -- "${tmp}/broken" "${tmp}/ws.moved"
  mkdir -p "${tmp}/broken"
  ln -s -- "$(dirname "${launch}")/configs" "${tmp}/broken/configs"
  if ! awk -v line="${line}" '
    $0 == "  rm -f -- \"${manifest}\"" { print line; n++; next }
    { print }
    END { exit n != 1 }' "${launch}" >"${tmp}/broken/launch.sh"; then
    printf 'FAIL %s: cannot break the cleanup of launch.sh\n' "${title}"
    failed=1
    return 0
  fi
  # bash turns errexit off in a command substitution and ignores a set -e there when
  # the substitution is in a list with ||, so run it alone: check gets errexit as in
  # a direct call and must set failed, the marker starts on a new line
  set +e
  out="$(
    set -e
    launch="${tmp}/broken/launch.sh"
    failed=0
    check "${title}" 'VAR_A VAR_B VAR_C VAR_D'
    printf '\nfailed=%s errexit=%s\n' "${failed}" "${-//[!e]/}"
  )"
  rc=$?
  set -e
  rm -rf -- "${tmp}/broken" "${tmp}/ws.moved"
  if [[ "${rc}" -ne 0 || "${out%%$'\n'*}" != "FAIL ${title}: cleanup left ${want}" ||
    "${out##*$'\n'}" != 'failed=1 errexit=e' ]]; then
    printf 'FAIL %s: check exit %s, printed %s\n' "${title}" "${rc}" \
      "$(printf '%s' "${out}" | tr '\n' '|')"
    failed=1
    return 0
  fi
  printf 'ok %s\n' "${title}"
}
check 'spaces' 'VAR_A VAR_B VAR_C VAR_D'
check 'tab and newline' $'VAR_A\tVAR_B\nVAR_C VAR_D'
check 'CRLF' $'VAR_A\r\nVAR_B\r\nVAR_C\r\nVAR_D\r\n'
check 'carriage return' $'VAR_A\rVAR_B\rVAR_C\rVAR_D'
check 'vertical tab and form feed' $'VAR_A\vVAR_B\fVAR_C \v\f VAR_D'
check 'surrounding whitespace' $'\r\n\t VAR_A VAR_B VAR_C VAR_D \f\v\r\n'
check 'only whitespace' $'\r\n\t \v\f\r\n' 0
# U+2003 EM SPACE, U+3000 IDEOGRAPHIC SPACE, U+2028 LINE SEPARATOR, U+1680
# OGHAM SPACE MARK
check 'unicode spaces' \
  $'VAR_A\xe2\x80\x83VAR_B\xe3\x80\x80VAR_C\xe2\x80\xa8\xe1\x9a\x80VAR_D'
# U+00A0 NO-BREAK SPACE, U+2007 FIGURE SPACE, U+202F NARROW NO-BREAK SPACE,
# U+0085 NEXT LINE
check 'non-breaking spaces' \
  $'VAR_A\xc2\xa0VAR_B\xe2\x80\x87VAR_C\xe2\x80\xaf\xc2\x85VAR_D'
# every Unicode space above alone as the separator
for space in $'\xe2\x80\x83' $'\xe3\x80\x80' $'\xe2\x80\xa8' $'\xe1\x9a\x80' \
  $'\xc2\xa0' $'\xe2\x80\x87' $'\xe2\x80\xaf' $'\xc2\x85'; do
  check "unicode space $(LC_ALL=C printf '%q' "${space}")" \
    "VAR_A${space}VAR_B${space}VAR_C${space}VAR_D"
done
# every name of bash_vars in launch.sh
for name in BASH BASHOPTS BASHPID BASH_ALIASES BASH_ARGC BASH_ARGV BASH_ARGV0 \
  BASH_CMDS BASH_COMMAND BASH_LINENO BASH_REMATCH BASH_SOURCE BASH_SUBSHELL \
  BASH_VERSINFO BASH_VERSION COMP_WORDBREAKS DIRSTACK EPOCHREALTIME \
  EPOCHSECONDS EUID FUNCNAME GROUPS HISTCMD IFS LINENO OPTERR OPTIND \
  PIPESTATUS PPID PWD RANDOM SECONDS SHELLOPTS SHLVL SRANDOM UID; do
  check_error "bash variable ${name}" "VAR_A ${name}" \
    "MEGALIPASE: ${name} is set by bash and cannot be passed" "${name}=117"
done
check_error 'sed failure' 'VAR_A' 'MEGALIPASE: cannot split the list' \
  PATH="${tmp}/bad-sed:${tmp}/bin:/usr/bin:/bin"
check_error 'invalid name' 'VAR_A 1BAD' 'MEGALIPASE: invalid variable name 1BAD'
check_error 'variable not set' 'VAR_A MISSING' 'MEGALIPASE: MISSING is not set or empty'
# image is a variable of launch.sh, set but not exported
check_error 'not exported' 'VAR_A image' 'MEGALIPASE: image is not set or empty'
check_error 'empty variable' 'VAR_A EMPTY' 'MEGALIPASE: EMPTY is not set or empty' \
  EMPTY=
# check reports what a broken cleanup left
manifest="${tmp}/megalinter-installed-local.list"
# shellcheck disable=SC2016
check_cleanup 'cleanup removes the workspace' \
  '  rm -f -- "${manifest}"; rm -rf -- "${workspace}"' 'no workspace directory '
# shellcheck disable=SC2016
check_cleanup 'cleanup links the workspace' \
  '  rm -f -- "${manifest}"; mv -- "${workspace}" "${workspace}.moved"
  ln -s -- "${workspace}.moved" "${workspace}"' "no workspace directory ${tmp}/ws "
check_cleanup 'cleanup keeps the manifest' '  :' "${tmp}/ws ${manifest} "
# shellcheck disable=SC2016
check_cleanup 'cleanup links the manifest' \
  '  rm -f -- "${manifest}"; ln -s -- "${workspace}.missing" "${manifest}"' \
  "${tmp}/ws ${manifest} "
exit "${failed}"
