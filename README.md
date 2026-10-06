# GitHub actions library

[![repo-test](https://github.com/megalomania428/github-actions/actions/workflows/repo-test.yaml/badge.svg)](https://github.com/megalomania428/github-actions/actions/workflows/repo-test.yaml)

## Make release

- clone me:

```bash
git clone --recursive git@github.com:megalomania428/github-actions.git github-actions
```

- make tag and send to release:

```bash
git checkout master && git pull
git tag -fm $(git branch --sho) v1.0.0 && git push --force origin $(git describe)
```

## review-pi_dev

In GitHub Actions, `review-pi_dev` refuses pull requests from forks, and any pull request whose origin cannot be checked, to keep fork code away from the review secrets. Pull requests from forks are reviewed from a workstation through chat apps instead.

A reviewed repository may provide its own `.github/review-pi_dev.yaml` with the `settings`, `models` and `mcp` sections. Each section given there replaces the `defaults` part of the same section in [review-pi_dev/config.yaml](review-pi_dev/config.yaml), and a missing or null section keeps those defaults. The `mandatory` part is merged recursively under the result and only adds keys left unset, so a config without `settings.retry` still gets `retry.enabled: false`, `retry.provider.maxRetries: 0` and the `llmRetries` budget from the `LLM_RETRIES` environment variable, which the LLM retry wrapper of `retry.ts` needs.
