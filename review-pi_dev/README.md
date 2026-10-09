# review-pi_dev

In GitHub Actions, `review-pi_dev` refuses pull requests from forks, and any pull request whose origin cannot be checked, to keep fork code away from the review secrets. Pull requests from forks are reviewed from a workstation through chat apps instead.

A reviewed repository may provide its own `.github/review-pi_dev.yaml` with the `settings`, `models` and `mcp` sections. Each section given there replaces the `defaults` part of the same section in [config.yaml](config.yaml), and a missing or null section keeps those defaults. The `mandatory` part is merged recursively under the result and only adds keys left unset, so a config without `settings.retry` still gets `retry.enabled: false`, `retry.provider.maxRetries: 0` and the `llmRetries` budget from the `LLM_RETRIES` environment variable, which the LLM retry wrapper of `retry.ts` needs.

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
