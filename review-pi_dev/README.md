# review-pi_dev

In GitHub Actions, `review-pi_dev` refuses pull requests from forks, and any pull request whose origin cannot be checked, to keep fork code away from the review secrets. Pull requests from forks are reviewed from a workstation through chat apps instead.

A reviewed repository may provide its own `.github/review-pi_dev.yaml` with the `settings`, `models` and `mcp` sections. Each section given there replaces the `defaults` part of the same section in [config.yaml](config.yaml), and a missing or null section keeps those defaults. The `mandatory` part is merged recursively under the result and only adds keys left unset, so a config without `settings.retry` still gets `retry.enabled: false`, `retry.provider.maxRetries: 0` and the `llmRetries` budget from the `LLM_RETRIES` environment variable, which the LLM retry wrapper of `retry.ts` needs.

## Retries in interactive pi

`retry.ts` serves an interactive pi as well and needs no `log.ts`, which only prints the CI log. Load it for one run with `pi -e /path/to/review-pi_dev/retry.ts`, or for every run list the path of the file in `extensions` of `~/.pi/agent/settings.json` or copy the file to `~/.pi/agent/extensions/`, which also lets `/reload` load it again. Point at the file itself, since the directory also holds `log.ts` and the tests.

The extension reads only `settings.json` of the agent directory, `~/.pi/agent` or the one set by `PI_CODING_AGENT_DIR`, and fails to load unless the retries of pi are off there, so that the attempts do not multiply: `"retry": { "enabled": false, "provider": { "maxRetries": 0 } }`, where `maxRetries` may also be left out. `"llmRetries"` sets the budget in seconds for the sum of the delays between the attempts of one request, 111 by default, and `0` turns the extension off. Project settings in `.pi/settings.json` are not checked. The AWS SDK retries Bedrock requests on its own, 3 attempts by default, and the settings of pi do not turn that off: set `AWS_MAX_ATTEMPTS=1` or `max_attempts = 1` in the AWS config. Retries made inside providers of other extensions are not detected either.

The extension wraps the provider of the current model and every provider with configured auth when a session starts, when the model changes and before each prompt, turn, compaction and branch summary, so a provider registered later, by another extension or after `/login`, gets a wrapper at the next of these points; the check before a turn is best effort. A wrapper is the provider pi built from its catalog, `models.json` and other extensions, registered again with only its streams replaced, so pi lists the wrapped providers as registered by an extension. Wrappers stay when the model changes and are removed when the session ends. Pi keeps one extension registration per provider id: a wrapper replaces the provider config another extension registered under the same id, while still serving that provider, and the removal of the wrappers at the end of a session removes such a registration too, so a provider that another extension registered outside of its loading comes back only once that extension registers it again. A registration of the same id by another extension after a check replaces the wrapper until the next check, which wraps that registration in turn; a wrapper that gets a request from another wrapper of this extension through such a registration passes it on without retries of its own, so the attempts do not multiply as long as that registration passes the options of the request on, as they are or copied by spread, instead of building them from named fields. A wrapper keeps the models and auth its provider had when it was wrapped, and pi lays `models.json` over it again each time it reads the file, as it does when a session starts, when the model selector opens and when an extension registers a provider. A model added there joins the catalog of pi then. A changed header of `models.json` reaches the requests then too, and so does a changed `apiKey` unless another key wins: one given with the request or with `--api-key`, or a stored key or login of the provider; while the wrapper is in place, removing an `apiKey` or header of the provider from `models.json` brings back the auth the provider had when it was wrapped, while the headers of a model follow `models.json` from its next read. A changed `baseUrl` or `api` of a model in `models.json` reaches the requests only once pi takes that model again after reading the file, as on a pick in the model selector after it has refreshed its list or in a new session, and a login that sets the address itself, as GitHub Copilot's does, overrides that `baseUrl` in every request. Pi sends the requests of an added model through the wrapper only if a model the wrapped provider had when it was wrapped used the same api: requests of a model with another api go around the wrapper, to the handler pi has for that api or to an error at once if there is none, without the retries of this extension, until `/reload` or a new session wraps the provider again. Requests that extensions send through the `pi-ai` package directly bypass the providers of pi and get no retries of this extension. The retries show nothing in the interface: the extension only emits `review:retry` on `pi.events`, and pi gets the error once the budget is spent.

Run the tests with `node --test review-pi_dev/retry.test.ts` on Node 23.6 or newer, which strips the types without extra packages.

## Permissions

The workflow that calls `review-pi_dev` must grant its `GITHUB_TOKEN` the permissions below, as in [review-pi_dev.yaml](../.github/workflows/review-pi_dev.yaml). The permissions belong to the calling workflow, not to the action, so every repository that runs the review needs them in its own workflow. GitHub sets permissions for a whole workflow or a job, never for a single step, and every step of a job shares one token. So the workflow drops all permissions with `permissions: {}`, and only the job that runs the review gets what it needs. Once permissions are listed explicitly, every permission left out drops to `none`, and the GitHub MCP server then answers the matching calls of the reviewer with 403.

```yaml
permissions: {}
jobs:
  review-pi_dev:
    permissions:
      contents: read
      pull-requests: write
      issues: write
      checks: read
      statuses: read
```

- `contents: read` – check out the repository and read its files and commits.
- `pull-requests: write` – read the pull request, its diff, commits, reviews and inline threads, find an open pull request for the branch and refuse forks in `launch.sh`, create and submit the pending review with inline comments, reply in threads and resolve them.
- `issues: write` – read the issue-level conversation of the pull request and post issue-level answers and the comment of a run that found nothing to report.
- `checks: read` – read the check runs of the head commit through `get_check_runs`, so the reviewer skips what CI already reports.
- `statuses: read` – read the combined commit status through `get_status`, for CI that reports statuses instead of check runs.
