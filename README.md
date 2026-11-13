# commit-live

Live on a commit. Every push gets a **lit / dark** light from your tests, every lit commit gets a GitHub Pages
preview at `/c/<sha>/`, and **go-live** points your site at a lit commit. Nothing is merged, and there's no
service to sign up for. The standard is in [SPEC.md](SPEC.md); the light rule is
[light-core](https://github.com/fitzyracing1/light-core) v0.1.0 (exit 0 is lit, anything else is dark).

## Quickstart

```yaml
on: { push: {}, pull_request: {}, workflow_dispatch: { inputs: { sha: { required: true } } } }
permissions: { contents: write, statuses: write, pull-requests: write }
jobs: { live: { runs-on: ubuntu-latest, steps: [ uses: actions/checkout@v4, { uses: fitzyracing1/commit-live@v1, with: {
  mode: "${{ github.event_name == 'workflow_dispatch' && 'go-live' || 'check' }}", sha: "${{ inputs.sha }}",
  test-command: npm test, build-command: npm run build, build-dir: dist } } ] } }
```

Save it as `.github/workflows/live.yml`. After the first lit push, turn on Pages once: **Settings → Pages →
Deploy from a branch → `gh-pages` / root**.

- **Push or PR**: runs `test-command`. You get a `commit-live` commit status (● lit / ○ dark) and, on PRs, one comment
  that's updated on each push. A lit commit also gets a preview at `https://<owner>.github.io/<repo>/c/<sha>/`.
- **Go live**: Actions → your workflow → *Run workflow* with a sha. It's refused unless that commit is lit; when it is,
  the site root serves that commit's build. Roll back by going live with an older lit sha.

## Inputs

| input | default | |
|---|---|---|
| `mode` | `check` | `check` or `go-live` |
| `test-command` | `npm test` | its exit code is the light |
| `build-command` | | runs only when a preview will be deployed |
| `build-dir` | | static build to preview; empty = no previews |
| `preview` | `lit` | `lit`, `always`, `never` |
| `sha` | | go-live: the commit to make live |
| `pages-branch` | `gh-pages` | |
| `pages-url` | `https://<owner>.github.io/<repo>/` | |
| `comment` | `true` | PR comment |
| `fail-on-dark` | `true` | a dark light makes the job dark |
| `token` | `github.token` | |

Outputs: `light`, `bit`, `sha`, `preview-url`, `live-url`.

The runner needs Node 18+ on `PATH` (GitHub-hosted runners have it). Builds should use relative links so they work
under `/c/<sha>/` and at the root. PRs from forks get a light but no preview or comment.

Demo: [fitzyracing1/commit-live-demo](https://github.com/fitzyracing1/commit-live-demo).

MIT © 2026 Joshua Almeida

## Plans

This project is free, and its license stays as is. Support it through [GitHub Sponsors](https://github.com/sponsors/fitzyracing1):

- **Free**: use the code, community support.
- **Free (followers)**: follow me on X or GitHub and get free consulting on my products.
- **Pro ($49/month)**: priority issues and support.
- **Team ($199/month)**: priority support for your team plus early access.
