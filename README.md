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
