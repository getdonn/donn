# Contributing to donn

Thanks for helping. Read `CLAUDE.md` and `docs/planning/00-handoff.md` first; the planning docs in
`docs/planning/` are the source of truth for design decisions.

## Developer Certificate of Origin

donn uses the Developer Certificate of Origin (DCO) 1.1; the text is at
<https://developercertificate.org>. Sign off every commit:

```sh
git commit -s
```

This adds a `Signed-off-by: Your Name <you@example.com>` line, certifying that you have the right
to submit the change under the project's Apache-2.0 license.

## Git flow

- `main` is released code; `develop` is integration.
- All work happens on `feature/<topic>` branched from `develop` and merged back into it. Never
  commit directly to `main` or `develop`. `release/*` and `hotfix/*` follow standard gitflow.
- Merge style: feature to `develop` is always **squash**. `release/*` and sync PRs into `main` or
  `develop` use a **merge commit**, so the two branches keep shared history.
- Changesets `baseBranch` is `develop`; add a changeset (`pnpm changeset`) for user-visible changes.

## Before you commit

Run `pnpm format` (Prettier at width 80; `pnpm format:check` must pass), then
`pnpm turbo run build check-types lint test`.

## Release checklist

1. Run `changeset version` on `release/x.y.z`.
2. Rehearsal green: the Verdaccio `workflow_dispatch` run of `release.yml`.
3. Open a PR to `main` (merge commit).
4. Sync `main` to `develop` (merge commit; check `main` still exists).
5. Tag `vX.Y.Z` on `origin/main` and push the tag.
6. Approve the `npm` environment.
7. Verify: `npm view`, `npm audit signatures`, and a clean `npm i -g @getdonn/cli`.
