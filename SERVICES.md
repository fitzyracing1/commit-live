# Live on a commit: running services (draft, `try/service-launch`)

[SPEC.md](SPEC.md) makes a **static** site live on a commit: Pages serves `c/<sha>/` and Go live copies it to the root.
This draft does the same for a **running service** (API, bot, webhook server): a lit commit launches its own
running copy, and Go live points the stable service at that exact commit. Everything is driven and recorded on
GitHub; the service itself runs on a pluggable host.

States are only **lit** (exit 0) and **dark** (anything else). No light is an error, never either.

## 1. Why this is needed

GitHub has no built-in way to start a long-running service from a commit:

- **Pages** serves static files only; it "does not support server-side languages"
  ([docs](https://docs.github.com/en/github/working-with-github-pages/creating-a-github-pages-site)).
- **Deployments / environments** are a record plus protection rules; GitHub runs nothing. External tools post
  statuses and an `environment_url`
  ([deployments](https://docs.github.com/en/rest/deployments/deployments),
  [statuses](https://docs.github.com/en/rest/deployments/statuses)).
- **Actions** jobs stop after 6 hours on GitHub-hosted runners
  ([limits](https://docs.github.com/en/actions/reference/limits)), so a service in a job is a demo, not a host.
- **Codespaces** can forward a public port, but a codespace is a per-user dev box that stops when idle, and public
  ports revert to private on restart
  ([ports](https://docs.github.com/en/codespaces/developing-in-codespaces/forwarding-ports-in-your-codespace),
  [security](https://docs.github.com/en/codespaces/reference/security-in-github-codespaces)).
- **Hosts** have previews per *pull request*, not per commit, and they don't wait for a lit light:
  Railway PR environments ([docs](https://docs.railway.com/guides/preview-deployments-with-pr-environments)),
  Render preview environments ([docs](https://render.com/docs/preview-environments)),
  Fly review apps through an Action ([docs](https://docs.fly.io/blueprints/review-apps-guide)).
  Production is usually whatever the branch head is, not a commit someone picked.

What's missing: **one preview per lit commit, dark commits never run, and a human picks the exact commit that is
live**, with GitHub as the place it all shows up.

## 2. Rules

1. **Only lit commits launch.** The launcher refuses a dark commit before touching GitHub or the host. No light is
   an error. As a second lock, the deployment is created with `required_contexts: ["commit-live"]`, so GitHub
   itself answers 409 unless the `commit-live` status or check on that sha is `success`.
2. **One preview per lit commit**, environment `service-preview`, `transient_environment: true`, with the
   preview's URL as `environment_url`. A launch error is recorded as deployment state `error`; it never changes
   the commit's light.
3. **Go live needs a person to press it.** Only `workflow_dispatch` (the Actions "Run workflow" button) or the App's
   `check_run` button count, and the actor must not be a bot. Pushes, schedules and `workflow_run` are refused.
   Add *required reviewers* to a separate `go-live-approval` environment on the Go live job for a second,
   GitHub-enforced press (free plans: public repos only). Don't name the job's environment `service-live`: a job
   with `environment:` makes its own deployment of the workflow's sha, which is not the commit being made live
   ([environments](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment)).
4. **Go live** takes a sha that is lit **and** has a running preview, creates a deployment in environment
   `service-live` (`production_environment: true`), asks the host to run that exact sha as the stable service,
   and posts `success` with the stable URL. Earlier live deployments are marked `inactive` (GitHub's
   `auto_inactive` skips production environments, so this is done by hand). A host error leaves the old live
   service and its pointer untouched. Rollback is Go live with an older lit sha.
5. **The live pointer** is the newest `service-live` deployment that commit-live created (`payload.commitLive`)
   whose latest status is `success` (its `sha`). Deployments from anything else in that environment are ignored.
   Optionally mirrored into `live.json` as `service: { sha, url, deployment }` so Pages and services agree.
6. **Teardown** keeps the newest *N* running previews (default 3) plus the live commit's preview. Each other one is
   destroyed on the host and its deployment set to `inactive`, which GitHub shows as *destroyed*. Run after
   every launch and on a schedule.
7. **No silent deploys.** The host's own auto-deploy-on-push must be off for the live service (Railway: disconnect
   the branch trigger or turn off auto deploys), or it would put dark commits live behind commit-live's back.

## 3. Flow

```
push → check (tests) ──○ dark──▶ status failure, nothing launched
                     └─● lit──▶ status success
                                  └▶ deployment service-preview(sha) → host.launch(sha) → success + environment_url
                                  └▶ teardown (keep N + live)
Go live (button, person) → light lit? preview running? → deployment service-live(sha)
                         → host.promote(sha) → success + stable URL → old live deployments inactive
```

## 4. Host interface

```js
{
  name,
  launch({ sha })  → { ref, url }   // start this sha as its own preview
  promote({ sha }) → { ref, url }   // run this exact sha as the stable service; url is the stable URL
  destroy({ sha, ref })             // stop a preview
}
```

The host `ref` is written near the start of the preview's success description (`● lit · ref <ref> · …`) so teardown
can find it later without extra storage.

| host | account | durable | per-commit URL | notes |
|---|---|---|---|---|
| `mock` | none | n/a | `https://<sha7>.preview.mock.invalid/` | in-memory; CI tests the whole flow with no secrets |
| Actions job + tunnel (not built) | none (quick tunnel) | **no**: ends with the job, max 6 h | random tunnel URL | fine for a 10-minute smoke check; the URL dies with the run, logs and secrets live on a shared runner, and a quick tunnel has no uptime promise |
| `railway` | Railway | yes | one Railway environment per commit | built as a dry-run-by-default adapter (section 5) |
| Render / Fly (later) | yes | yes | per service / app | Render's API can create services; Fly can do `fly deploy --image` per app |

There is no free, durable, no-account way to run a service per commit. The honest free tier is the mock (tests)
plus an Actions-job smoke run; anything people should click needs a real host.

## 5. Railway adapter

Railway public API, `https://backboard.railway.com/graphql/v2`
([API](https://docs.railway.com/integrations/api), [services](https://docs.railway.com/integrations/api/manage-services),
[environments](https://docs.railway.com/integrations/api/manage-environments)).

- **launch:** `environmentCreate { projectId, name: "c-<sha12>", sourceEnvironmentId: <live env> }` →
  `serviceInstanceDeployV2(serviceId, environmentId, commitSha)` → poll `deployment(id) { status }` until
  `SUCCESS` (`FAILED`, `CRASHED`, `REMOVED`, `SKIPPED` stop it) → `serviceDomainCreate` for the URL. If anything
  goes wrong the new environment is deleted, so nothing keeps billing.
- **promote:** `serviceInstanceDeployV2(serviceId, <live env>, commitSha)` and wait for `SUCCESS`. The stable URL
  is the live environment's domain.
- **destroy:** `environmentDelete(id)`; refuses the live environment id.
- **Dry run by default.** The adapter sends nothing unless `COMMIT_LIVE_REAL=true` *and* a token is present; in a dry
  run it records the operations it would send. Errors never include the request (the token is in its headers).
- **Token:** a workspace (or account) token, sent as `Authorization: Bearer`. A project token is scoped to one
  environment and can't create environments, so the adapter refuses it.
- **Caveat:** cloning the live environment copies its variables (secrets, database URLs) into every preview. Point
  previews at a staging environment as the source, or override variables, before using real data.

## 6. GitHub wiring (sketch)

```yaml
# .github/workflows/commit-live.yml (sketch, not installed anywhere)
on:
  push:
  workflow_dispatch:
    inputs: { sha: { required: true } }
permissions: { contents: write, statuses: write, deployments: write }
jobs:
  check:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - id: light
        uses: fitzyracing1/commit-live@<ref>
      - if: steps.light.outputs.light == 'lit'
        run: node "$CL/src/services/cli.mjs" launch --sha "$GITHUB_SHA" --light lit --host railway
        env: { GITHUB_TOKEN: '${{ github.token }}', RAILWAY_TOKEN: '${{ secrets.RAILWAY_TOKEN }}', COMMIT_LIVE_REAL: 'true', ... }
      - run: node "$CL/src/services/cli.mjs" teardown --keep 3 --host railway
  go-live:
    if: github.event_name == 'workflow_dispatch'
    environment: go-live-approval   # required reviewers here; NOT service-live (the job would deploy its own sha)
    runs-on: ubuntu-latest
    steps:
      - run: node "$CL/src/services/cli.mjs" go-live --sha "${{ inputs.sha }}" --host railway
```

`deployments: write` is the only new permission. The App would need **Deployments: read & write** added to its
permission set (SPEC.md section 7) to do the same from the check button.

## 7. Prototype on this branch

- `src/services/launcher.mjs`: `launchPreview`, `goLiveService`, `teardown`, `readLiveService`, `assertPressed`.
- `src/services/deployments.mjs`: the GitHub Deployments calls.
- `src/services/memory-github.mjs`: in-memory GitHub (statuses, deployments, `required_contexts` 409,
  `auto_inactive`), for `--dry-run` and tests.
- `src/services/hosts/{mock,railway,index}.mjs`.
- `src/services/cli.mjs`: `launch | go-live | teardown | demo`, `--dry-run`, `--host mock|railway`.
  Exit 0 done, 1 refused (dark, no light, no press), 2 error.
- Tests: `test/services.test.mjs`, `test/railway.test.mjs` (Railway against a fake API, never the real one).
- CI on this branch also runs `demo` and a Railway dry run.
