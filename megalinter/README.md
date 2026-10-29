<!-- markdownlint-disable MD013 -->
<!-- cspell:ignore gomodcache golangci megalipase shlvl tengri -->

# MegaLinter action

Composite action that runs [MegaLinter](https://megalinter.io) v9 in a podman container with shared default configs from [configs](configs) and per-repo overrides.

## Usage

```yaml
- name: Run MegaLinter
  env:
    OVERRIDE_DIR: .megalinter/configs
  uses: megalomania428/github-actions/megalinter@master
```

The action has no inputs, it reads environment variables of the step, the job or the workflow:

- `OVERRIDE_DIR` – directory with per-repo config files relative to the repository root, `.megalinter` by default;
- `MEGALINTER_CONFIG` – explicit MegaLinter config, the action passes it to MegaLinter, an absolute path inside the repository becomes its path under `/tmp/lint`, a file outside the repository, for example under `runner.temp`, is not available in the container, and skips its own config selection;
- `MEGALINTER_IMAGE` – MegaLinter image, `ghcr.io/oxsecurity/megalinter:v9` by default;
- `PODMAN_ARGS` – extra `podman run` arguments, split into words by whitespace without quote processing, for example `--tls-verify=false` or `--pull=always`;
- `MEGALINTER_GOMODCACHE` – existing host directory mounted to `/go/pkg/mod`, for example the Go module cache from `go env GOMODCACHE` warmed up by `go mod download`;
- `MEGALIPASE` – names of other variables to pass to the container, separated by whitespace, see [Passed variables](#passed-variables);
- `HTTP_PROXY`, `HTTPS_PROXY`, `SOCKS_PROXY`, `ALL_PROXY`, `NO_PROXY` in upper or lower case – proxies passed to the container, see [Container](#container).

The former `override_dir` and `megalinter_image` inputs are removed. GitHub only warns about unknown inputs, so replace `with: override_dir: <dir>` by `env: OVERRIDE_DIR: <dir>`, otherwise the overrides are silently ignored.

## Container

The runner needs `podman`, GitHub-hosted Ubuntu runners have it preinstalled. The action runs `podman run --rm --network=host --http-proxy=false` with the container name `megalinter-<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>`, then `PODMAN_ARGS` and the image. The exit code of MegaLinter becomes the exit code of the step, an error of podman itself such as a failed pull gives its own code from 125 to 127, a cancelled step exits with 1, a bad `MEGALIPASE` exits with 2 before anything is installed. podman pulls the image only when it is missing, add `--pull=always` to `PODMAN_ARGS` to refresh a moving tag such as `v9`.

The repository is mounted to `/tmp/lint`, which is also the working directory, `DEFAULT_WORKSPACE` and `GITHUB_WORKSPACE` in the container. The files of `GITHUB_OUTPUT` and `GITHUB_STEP_SUMMARY` are mounted read-write under `/github/file_commands`, the file of `GITHUB_EVENT_PATH` is mounted read-only to `/github/workflow/event.json`, and the variables point to these paths. The Docker socket is not mounted. The container gets:

- `GITHUB_ACTIONS=true` and `GITHUB_REPOSITORY`, `GITHUB_SHA`, `GITHUB_REF`, `GITHUB_HEAD_REF`, `GITHUB_REF_NAME`, `GITHUB_EVENT_NAME`, `GITHUB_RUN_ID`, `GITHUB_SERVER_URL`, `GITHUB_API_URL`, `GITHUB_WORKFLOW`, `GITHUB_JOB` from the runner;
- `GITHUB_JOB_URL` and `GITHUB_TARGET_URL`, which the runner does not set, when they are set in the workflow, job or step `env`;
- `MEGALINTER_CONFIG` selected by the action;
- proxies normalized like in the review actions: each name is taken in either case, `HTTPS_PROXY` falls back to `HTTP_PROXY`, `ALL_PROXY` to `SOCKS_PROXY`, empty values are not passed;
- the variables named in `MEGALIPASE`, see [Passed variables](#passed-variables).

Unlike a Docker action, the container gets no other variables of the workflow, the job, the step or the runner, such as `GITHUB_TOKEN`, `CI` or MegaLinter settings like `VALIDATE_ALL_CODEBASE`, unless they are named in `MEGALIPASE`, and podman does not add the proxies of the host on its own. Values are passed as is: a host path in a variable other than `MEGALINTER_CONFIG` is not translated to the container. The container and the installed configs are removed when the step ends, fails or is cancelled, only a step killed with `SIGKILL` leaves them behind.

### Passed variables

`MEGALIPASE` lists the names of other environment variables of the step to pass to the container, separated by any whitespace including newlines, carriage returns and Unicode spaces, also non-breaking ones, usually variables set in the `env` of the step, the job or the workflow. Unicode spaces other than U+00A0, U+2007, U+202F and U+0085 need the `C.UTF-8` locale on the runner, which current Ubuntu has:

```yaml
- name: Run MegaLinter
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    VALIDATE_ALL_CODEBASE: false
    MEGALIPASE: GITHUB_TOKEN VALIDATE_ALL_CODEBASE
  uses: megalomania428/github-actions/megalinter@master
```

Each name is passed as `-e NAME`, so podman takes the value from the environment of the step and multiline values stay intact. A repeated name and a name the action passes itself, listed above, are ignored. Any other name is passed, even `PATH` or `HOME`, which may break the container. Variables that bash sets itself, such as `RANDOM`, `LINENO`, `SECONDS` or `SHLVL`, cannot be passed, the shell of the step replaces their values. The step fails with exit code 2 before the configs are installed when a name is not a valid variable name, is such a bash variable or the variable is not set or empty, the log lists every such name. `${{ secrets.NAME }}` of a missing secret gives an empty value, so it fails the step too. Without `MEGALIPASE` the container gets only the variables listed above. Write the names in upper case: `launch.sh` uses lower-case shell variables such as `name` or `image`, and a listed variable with the same name is not supported, it may be reported as not set or passed with a wrong value.

Earlier versions passed every variable of the workflow, job and step `env`, so a workflow that relies on it, for example on `GITHUB_TOKEN` for the GitHub reporters or for `EXTENDS` from a GitHub URL, has to name them in `MEGALIPASE` now. Options in `PODMAN_ARGS` such as `-e`, `--env-file` or `--env-host` are passed to podman as is and add variables beside `MEGALIPASE`.

### Self-hosted runners

Runners without Docker and without direct internet access take the image from an own registry and reach the network through proxies:

```yaml
- name: Run MegaLinter
  env:
    MEGALINTER_IMAGE: nexus01.in.tengri-data.ru/cont-ghcr/oxsecurity/megalinter:v9
    PODMAN_ARGS: --tls-verify=false
    HTTP_PROXY: ${{ secrets.PROXY_HTTP }}
    SOCKS_PROXY: ${{ secrets.PROXY_SOCKS }}
  uses: megalomania428/github-actions/megalinter@master
```

`HTTPS_PROXY` and `ALL_PROXY` are derived from `HTTP_PROXY` and `SOCKS_PROXY`. podman itself also pulls the image through `HTTP_PROXY` and `HTTPS_PROXY`, add the registry host to `NO_PROXY` when the proxy cannot reach it. When golangci-lint cannot download Go modules through the proxy, warm up the cache on the host with `go mod download` and pass its directory in `MEGALINTER_GOMODCACHE`.

The podman configuration of the runner still applies: with `env_host = true` in `containers.conf` podman passes its whole environment to the container, including variables not named in `MEGALIPASE`, and the entries of the `env` list there can reach the container too: `NAME=value` as is, a bare `NAME` with the value from the environment of podman and a pattern such as `NAME*` or `*` with every matching variable of that environment. With a remote podman, for example through `CONTAINER_HOST`, these are the `containers.conf` and the environment of the podman service, not of the step. Keep `env_host` off and the `env` list empty on runners that run this action.

## Config files

Before MegaLinter starts, the action copies config files to the repository root and removes exactly these files after the run, even when MegaLinter fails. The set of names is the union of top-level files from [configs](configs) and from `OVERRIDE_DIR`. For every name:

1. an entry already present in the repository root is kept untouched (`keep repo file`), this includes directories and dangling symlinks;
2. otherwise the file from `OVERRIDE_DIR` is copied;
3. otherwise the action default is copied.

Subdirectories of `OVERRIDE_DIR` are skipped with a log message, symlinks to files are copied as regular files. Without `OVERRIDE_DIR` only the defaults are used. MegaLinter config files from `OVERRIDE_DIR` are not copied, see [MegaLinter config](#megalinter-config).

### ESLint configs

ESLint 10 uses the first config found in a directory in the order `eslint.config.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, so a default `eslint.config.mjs` next to a repo `eslint.config.ts` would silently replace the repo rules. Therefore:

- if the repository root contains any `eslint.config.*` or a legacy `.eslintrc`, `.eslintrc.json`, `.eslintrc.yml`, `.eslintrc.yaml`, `.eslintrc.js`, `.eslintrc.cjs`, no `eslint.config.*` is installed at all, neither the default nor from `OVERRIDE_DIR`;
- if `OVERRIDE_DIR` contains any of these files, they are installed and the default `eslint.config.*` is skipped.

Legacy configs are taken into account so that MegaLinter reports the migration error to flat config instead of linting with the action rules.

## MegaLinter config

The action default [.megalinter.yml](configs/.megalinter.yml) is installed to the repository root as `.megalinter-action.yml` by the rules above, so a `.megalinter-action.yml` in the root or in `OVERRIDE_DIR` replaces it. Unless `MEGALINTER_CONFIG` is preset, the action passes to MegaLinter `MEGALINTER_CONFIG` with the first existing file of:

1. `.mega-linter.yml`, `.megalinter.yml`, `.mega-linter.yaml`, `.megalinter.yaml` in the repository root;
2. the same names in `OVERRIDE_DIR`, used in place without copying;
3. `.megalinter-action.yml`.

Other found MegaLinter configs are listed in the log as ignored. A repo config replaces the action default completely unless it extends it explicitly:

```yaml
---
EXTENDS: .megalinter-action.yml
CONFIG_PROPERTIES_TO_APPEND:
  - DISABLE_LINTERS
  - EXCLUDED_DIRECTORIES
DISABLE_LINTERS:
  - SPELL_LYCHEE
```

`EXTENDS` with a local path is always resolved from the repository root, so the line is the same for a config in the root and in `OVERRIDE_DIR`. Merging is shallow: scalars, dictionaries and lists are replaced by the repo values, except lists named in `CONFIG_PROPERTIES_TO_APPEND`, which are appended to the action values without removing duplicates.

A config with `EXTENDS: .megalinter-action.yml` works only through this action, a local MegaLinter run needs the file copied manually. Repo configs with a full copy of the defaults or with `EXTENDS` to a `raw.githubusercontent.com` URL keep working unchanged when the URL is public, a URL of a private repository needs a token with access to it, set in `GITHUB_TOKEN` and named in `MEGALIPASE`.

Why the extension is explicit:

- automatic wrapping into `EXTENDS: [.megalinter-action.yml, <repo config>]` was rejected: MegaLinter merges an extended config that has its own `EXTENDS` twice, the second time under its own `CONFIG_PROPERTIES_TO_APPEND`, so repos with `EXTENDS` would lose or duplicate list values;
- extension by URL only was rejected, because the URL ref drifts away from the action ref in `uses:`;
- the explicit `MEGALINTER_CONFIG` also removes the name collision when the repo has `.mega-linter.yml` and the action default lies next to it.
