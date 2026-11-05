# Releasing

`c402-protocol` is published to npm by `.github/workflows/release.yml`. The
workflow stores **no token**: it authenticates with npm Trusted Publishing over
OIDC, so the credential is a short-lived token minted for that workflow run and
usable nowhere else.

## Why not NPM_TOKEN

An `NPM_TOKEN` secret is a long-lived credential with write access to the
package. It can be read by anyone who can run a workflow in this repository, it
survives in logs and backups, and it is only as safe as its rotation schedule.
npm's own guidance is to replace it with OIDC wherever the registry supports it.

| Method | Secret at rest | Scope | Rotation |
|---|---|---|---|
| Trusted Publishing (OIDC) | none | one workflow in one repo | per run |
| Granular token, one package, expiry | yes | one package | manual |
| Granular token, all packages | yes | everything you own | manual |
| Legacy automation token | yes | everything you own, 2FA bypass | manual |

## One-time bootstrap

Trusted Publishing is configured in a package's settings, so the package must
exist first. That first publish is the only time a human credential is needed.

```bash
npm login                      # browser + 2FA; no token written to CI
git clone https://github.com/MCPVOT/c402.git && cd c402
npm ci
npm publish --access public
npm logout
```

Then, on npmjs.com → `c402-protocol` → **Settings → Trusted Publisher**:

| Field | Value |
|---|---|
| Provider | GitHub Actions |
| Organization or user | `MCPVOT` |
| Repository | `c402` |
| Workflow filename | `release.yml` |
| Environment | `npm-publish` (optional, recommended) |

## Optional: require a human approval

Create a GitHub environment named `npm-publish` with required reviewers, then
uncomment the `environment:` line in the workflow. From then on a publish run
waits for a human before it can mint its OIDC token. This is the closest thing
to "two-key" releasing without a paid plan.

## Cutting a release

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Commit, merge to `main`, tag `vX.Y.Z`.
3. Publish a GitHub release for that tag.

The workflow then checks that the tag equals `v<package.json version>`, runs
typecheck, the 101 TypeScript tests, the build and the 17 Rust tests, and
publishes with `--provenance --access public`.

Manual run for an existing tag:

```bash
gh workflow run release.yml -f tag=v2.2.0
```

## Verifying a publish

```bash
npm view c402-protocol version dist.integrity
npm view c402-protocol@2.2.0 --json | head
```

The provenance attestation is attached to the published version on npmjs.com
and can be checked with `npm audit signatures`.

## If you must use a token

Only for the bootstrap, or for a registry that does not support OIDC:

- create a **granular** token, not a legacy automation token;
- scope it to `c402-protocol` only;
- set an expiry, and an IP allow-list if the publisher has fixed egress;
- store it as a GitHub **environment** secret (not a repository secret) so it is
  only visible to a job that passed its protection rules;
- delete it as soon as Trusted Publishing is configured.
