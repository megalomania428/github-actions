<!-- markdownlint-disable MD013 -->

# review-pi_dev

In GitHub Actions, `review-pi_dev` refuses pull requests from forks, and any pull request whose origin cannot be checked, to keep fork code away from the review secrets. Pull requests from forks are reviewed from a workstation through chat apps instead.

A reviewed repository may provide its own `.github/review-pi_dev.yaml` with the `settings`, `models` and `mcp` sections. Each section given there replaces the `defaults` part of the same section in [config.yaml](config.yaml), and a missing or null section keeps those defaults. The `mandatory` part is merged recursively under the result and only adds keys left unset, so a config without `settings.retry` still gets `retry.enabled: false`, `retry.provider.maxRetries: 0` and the `llmRetries` budget from the `LLM_RETRIES` environment variable, which the LLM retry wrapper of `retry.ts` needs.

## Retries in interactive pi

`retry.ts` serves an interactive pi as well and needs no `log.ts`, which only prints the CI log. Load it for one run with `pi -e /path/to/review-pi_dev/retry.ts`, or for every run list the path of the file in `extensions` of `~/.pi/agent/settings.json` or copy the file to `~/.pi/agent/extensions/`, which also lets `/reload` load it again. Point at the file itself, since the directory also holds `log.ts` and the tests.

The extension reads only `settings.json` of the agent directory, `~/.pi/agent` or the one set by `PI_CODING_AGENT_DIR`, and fails to load unless the retries of pi are off there, so that the attempts do not multiply: `"retry": { "enabled": false, "provider": { "maxRetries": 0 } }`, where `maxRetries` may also be left out. `"llmRetries"` sets the budget in seconds for the sum of the delays between the attempts of one request, 111 by default, and `0` turns the extension off in this load, though under PI WEB the retries of other active sessions still cover its requests, since all sessions share one model runtime, and multiply the retries of pi or of its providers if those are on in its settings, until this session ends, or reloads with those retries turned off in all its settings, or no session with a budget is left. Project settings in `.pi/settings.json` are not checked. The AWS SDK retries Bedrock requests on its own, 3 attempts by default, and the settings of pi do not turn that off: set `AWS_MAX_ATTEMPTS=1` or `max_attempts = 1` in the AWS config. Retries made inside providers of other extensions are not detected either.

When a session starts, the extension replaces `stream` and `streamSimple` of the model runtime of pi, so the requests of every model of every provider get the retries, whether the provider comes from the catalog of pi, `models.json` or another extension: the requests of the agent, compaction and branch summary, the session names of PI WEB and the requests extensions send through `ctx.modelRegistry.complete`. Pi keeps the runtime in a field of the model registry that is private to TypeScript only, so if a release of pi drops that field, the extension fails at the start of each session with an error that pi shows, and the session goes on without retries. The runtime outlives `/reload`, and PI WEB shares one runtime among all its sessions and ignores the provider registrations of extensions after its start, so the first load replaces the methods once and every later load joins that replacement: a request takes the budget and `pi.events` of the last load whose session is still active, the previous one takes over when that session ends, and with no active session the requests go to pi without retries. Errors before a request is sent are retried as well, such as an unknown provider, a provider without configured auth or a failed OAuth refresh. Requests that extensions send through the `pi-ai` package or a provider directly bypass the runtime and get no retries of this extension. The retries show nothing in the interface: the extension only emits `review:retry` on `pi.events`, and pi gets the error once the budget is spent.

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
