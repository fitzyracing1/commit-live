import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LightError } from '@fitzyracing1/light-core';
import { createDeployments, PREVIEW_ENV, LIVE_ENV } from '../src/services/deployments.mjs';
import { createMemoryGitHub } from '../src/services/memory-github.mjs';
import { createMockHost } from '../src/services/hosts/mock.mjs';
import {
  launchPreview,
  goLiveService,
  teardown,
  readLiveService,
  assertPressed,
  Refused,
} from '../src/services/launcher.mjs';
import { run } from '../src/services/cli.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const status = (state) => [{ context: 'commit-live', state, created_at: '2026-10-17T00:00:00Z' }];
const press = { eventName: 'workflow_dispatch', actor: 'fitzyracing1' };

function setup(statuses = { [A]: status('success'), [B]: status('success'), [C]: status('failure') }) {
  const gh = createMemoryGitHub({ statuses });
  return { gh, deployments: createDeployments(gh, 'owner/repo'), host: createMockHost() };
}

test('a lit commit launches a preview: transient deployment, in_progress then success with environment_url', async () => {
  const { gh, deployments, host } = setup();
  const r = await launchPreview({ sha: A, light: 'lit', host, deployments, runUrl: 'https://run' });
  assert.equal(r.url, 'https://aaaaaaa.preview.mock.invalid/');
  const [created] = gh.calls.filter((c) => c.method === 'POST' && c.path === '/repos/owner/repo/deployments');
  assert.deepEqual(
    {
      ref: created.body.ref,
      environment: created.body.environment,
      transient: created.body.transient_environment,
      production: created.body.production_environment,
      contexts: created.body.required_contexts,
      autoMerge: created.body.auto_merge,
    },
    {
      ref: A,
      environment: PREVIEW_ENV,
      transient: true,
      production: false,
      contexts: ['commit-live'],
      autoMerge: false,
    },
  );
  const states = gh.statusesOf(r.deploymentId).map((s) => s.state);
  assert.deepEqual(states, ['success', 'in_progress']);
  const ok = gh.statusesOf(r.deploymentId)[0];
  assert.equal(ok.environment_url, r.url);
  assert.equal(ok.auto_inactive, false);
  assert.equal(ok.log_url, 'https://run');
});

test('a dark commit never launches and creates no deployment', async () => {
  const { gh, deployments, host } = setup();
  await assert.rejects(launchPreview({ sha: C, light: 'dark', host, deployments }), Refused);
  assert.equal(gh.calls.length, 0);
  assert.equal(host.running.length, 0);
});

test('no light is an error, never dark and never a launch', async () => {
  const { gh, deployments, host } = setup();
  await assert.rejects(launchPreview({ sha: A, light: '', host, deployments }), LightError);
  assert.equal(gh.calls.length, 0);
});

test('GitHub refuses the deployment (409) when commit-live is not success, even if the caller says lit', async () => {
  const { deployments, host } = setup();
  await assert.rejects(launchPreview({ sha: C, light: 'lit', host, deployments }), /409/);
  assert.equal(host.running.length, 0);
});

test('a launch error marks the deployment error and leaves nothing running', async () => {
  const { gh, deployments } = setup();
  const host = createMockHost({ fail: { launch: true } });
  await assert.rejects(launchPreview({ sha: A, light: 'lit', host, deployments }), /launch error/);
  assert.equal(gh.stateOf(gh.deployments[0].id), 'error');
});

test('Go live needs a person pressing it', () => {
  assert.doesNotThrow(() => assertPressed(press));
  assert.doesNotThrow(() => assertPressed({ eventName: 'check_run', actor: 'fitzyracing1' }));
  assert.throws(() => assertPressed({ eventName: 'push', actor: 'fitzyracing1' }), Refused);
  assert.throws(() => assertPressed({ eventName: 'workflow_run', actor: 'fitzyracing1' }), Refused);
  assert.throws(() => assertPressed({ eventName: 'workflow_dispatch', actor: 'github-actions[bot]' }), Refused);
  assert.throws(() => assertPressed({ eventName: 'workflow_dispatch' }), Refused);
});

test('Go live refuses a dark commit and a commit with no running preview', async () => {
  const { deployments, host } = setup();
  await assert.rejects(goLiveService({ sha: C, light: 'dark', host, deployments, press }), Refused);
  await assert.rejects(goLiveService({ sha: A, light: 'lit', host, deployments, press }), /no running service preview/);
  assert.equal(host.live, null);
});

test('Go live points the stable service at that exact sha and retires the previous live deployment', async () => {
  const { gh, deployments, host } = setup();
  await launchPreview({ sha: A, light: 'lit', host, deployments });
  await launchPreview({ sha: B, light: 'lit', host, deployments });
  const first = await goLiveService({ sha: A, light: 'lit', host, deployments, press });
  assert.equal(host.live, A);
  assert.deepEqual(await readLiveService(deployments), { sha: A, deploymentId: first.deploymentId });

  const second = await goLiveService({ sha: B, light: 'lit', host, deployments, press });
  assert.equal(host.live, B);
  assert.deepEqual(second.previous, [A]);
  assert.equal(gh.stateOf(first.deploymentId), 'inactive');
  assert.equal(gh.stateOf(second.deploymentId), 'success');
  const live = gh.deployments.find((d) => d.id === second.deploymentId);
  assert.equal(live.environment, LIVE_ENV);
  assert.equal(live.production_environment, true);
  assert.equal(live.payload.pressedBy, 'fitzyracing1');
  assert.equal(gh.statusesOf(second.deploymentId)[0].environment_url, 'https://live.mock.invalid/');
  // rollback is Go live with the older lit sha
  await goLiveService({ sha: A, light: 'lit', host, deployments, press });
  assert.equal((await readLiveService(deployments)).sha, A);
});

test('a promote error leaves the old live pointer in place', async () => {
  const { deployments } = setup();
  const host = createMockHost();
  await launchPreview({ sha: A, light: 'lit', host, deployments });
  await launchPreview({ sha: B, light: 'lit', host, deployments });
  await goLiveService({ sha: A, light: 'lit', host, deployments, press });
  const broken = { ...host, name: 'mock', promote: async () => Promise.reject(new Error('boom')) };
  await assert.rejects(goLiveService({ sha: B, light: 'lit', host: broken, deployments, press }), /boom/);
  assert.equal((await readLiveService(deployments)).sha, A);
});

test('teardown keeps the newest previews and the live one, destroys the rest and marks them inactive', async () => {
  const statuses = { [A]: status('success'), [B]: status('success'), [D]: status('success') };
  const { gh, deployments, host } = setup(statuses);
  for (const sha of [A, B, D]) await launchPreview({ sha, light: 'lit', host, deployments });
  await goLiveService({ sha: A, light: 'lit', host, deployments, press });
  const r = await teardown({ host, deployments, keep: 1 });
  assert.deepEqual(r.kept.sort(), [A, D]);
  assert.deepEqual(r.removed, [B]);
  assert.deepEqual(host.running.map((p) => p.sha).sort(), [A, D]);
  const bPreview = gh.deployments.find((d) => d.sha === B && d.environment === PREVIEW_ENV);
  assert.equal(gh.stateOf(bPreview.id), 'inactive');
  // a second teardown has nothing left to do
  assert.deepEqual((await teardown({ host, deployments, keep: 1 })).removed, []);
});

test('cli: dry-run launch and refusals, never touching the network', async () => {
  const lines = [];
  const log = (l) => lines.push(l);
  const env = { GITHUB_REPOSITORY: 'owner/repo' };
  assert.equal(await run(['launch', '--sha', A, '--light', 'lit', '--dry-run'], env, log), 0);
  assert.match(lines.at(-1), /service preview .* at https:\/\/aaaaaaa\.preview\.mock\.invalid\//);
  await assert.rejects(run(['launch', '--sha', C, '--light', 'dark', '--dry-run'], env, log), Refused);
  await assert.rejects(
    run(
      ['go-live', '--sha', A, '--light', 'lit', '--dry-run'],
      { ...env, GITHUB_EVENT_NAME: 'push', GITHUB_ACTOR: 'x' },
      log,
    ),
    Refused,
  );
  const pressed = { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_ACTOR: 'fitzyracing1' };
  assert.equal(await run(['go-live', '--sha', A, '--light', 'lit', '--dry-run'], pressed, log), 0);
  await assert.rejects(run(['launch', '--sha', 'abc', '--dry-run'], env, log), /full 40-char sha/);
  assert.equal(await run(['demo'], env, log), 0);
});

test('a deployment made by an Actions job (environment: service-live) is not the live pointer', async () => {
  const { gh, deployments, host } = setup();
  await launchPreview({ sha: A, light: 'lit', host, deployments });
  await goLiveService({ sha: A, light: 'lit', host, deployments, press });
  // what GitHub does for `environment: service-live` on a job: a deployment of the workflow's own sha
  const job = await gh.write('POST', '/repos/owner/repo/deployments', { ref: B, environment: LIVE_ENV });
  await gh.write('POST', `/repos/owner/repo/deployments/${job.id}/statuses`, { state: 'success' });
  assert.equal((await readLiveService(deployments)).sha, A);
});
