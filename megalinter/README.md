# MegaLinter action

Composite action that runs [MegaLinter](https://megalinter.io) v9 with shared default configs from [configs](configs) and per-repo overrides.

## Usage

```yaml
- name: Run MegaLinter
  env:
    OVERRIDE_DIR: .megalinter/configs
  uses: megalomania428/github-actions/megalinter@master
```

The action has no inputs, it reads environment variables of the step, the job or the workflow:

- `OVERRIDE_DIR` – directory with per-repo config files relative to the repository root, `.megalinter` by default;
- `MEGALINTER_CONFIG` – explicit MegaLinter config, the action passes it unchanged and skips its own config selection.

The former `override_dir` and `megalinter_image` inputs are removed. GitHub only warns about unknown inputs, so replace `with: override_dir: <dir>` by `env: OVERRIDE_DIR: <dir>`, otherwise the overrides are silently ignored.

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

A config with `EXTENDS: .megalinter-action.yml` works only through this action, a local MegaLinter run needs the file copied manually. Repo configs with a full copy of the defaults or with `EXTENDS` to a `raw.githubusercontent.com` URL keep working unchanged.

Why the extension is explicit:

- automatic wrapping into `EXTENDS: [.megalinter-action.yml, <repo config>]` was rejected: MegaLinter merges an extended config that has its own `EXTENDS` twice, the second time under its own `CONFIG_PROPERTIES_TO_APPEND`, so repos with `EXTENDS` would lose or duplicate list values;
- extension by URL only was rejected, because the URL ref drifts away from the action ref in `uses:`;
- the explicit `MEGALINTER_CONFIG` also removes the name collision when the repo has `.mega-linter.yml` and the action default lies next to it.
