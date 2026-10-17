#!/usr/bin/env node
// commit-live services: launch | go-live | teardown | demo. --dry-run uses an in-memory GitHub (no API calls).
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createGitHub, LightError } from '@fitzyracing1/light-core';
import { lightFromStatuses } from '../light.mjs';
import { createDeployments } from './deployments.mjs';
import { createMemoryGitHub } from './memory-github.mjs';
import { hostFromEnv } from './hosts/index.mjs';
import { createMockHost } from './hosts/mock.mjs';
import { launchPreview, goLiveService, teardown, readLiveService, Refused } from './launcher.mjs';

const OPTIONS = {
  sha: { type: 'string' },
  light: { type: 'string' },
  host: { type: 'string', default: 'mock' },
  keep: { type: 'string', default: '3' },
  'dry-run': { type: 'boolean', default: false },
};

const seedStatus = (sha, light) => ({
  [sha]: [
    { context: 'commit-live', state: light === 'lit' ? 'success' : 'failure', created_at: new Date(0).toISOString() },
  ],
});

export async function run(argv, env = process.env, log = console.log) {
  const { positionals, values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [command] = positionals;
  if (command === 'demo') return demo(log);
  const repo = env.GITHUB_REPOSITORY || 'owner/repo';
  const dryRun = values['dry-run'];
  const sha = values.sha;
  if (command !== 'teardown' && !/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('--sha must be a full 40-char sha');
  const gh = dryRun
    ? createMemoryGitHub({ statuses: sha && values.light ? seedStatus(sha, values.light) : {} })
    : createGitHub({ token: env.GITHUB_TOKEN, writeRepos: [repo], userAgent: 'commit-live-services' });
  const deployments = createDeployments(gh, repo);
  const host = hostFromEnv(values.host, env);
  const runUrl = env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`
    : undefined;
  const readLight = async () =>
    values.light || lightFromStatuses(await gh.get(`/repos/${repo}/commits/${sha}/statuses?per_page=100`)).light;

  if (command === 'launch') {
    const r = await launchPreview({ sha, light: await readLight(), host, deployments, runUrl });
    log(`commit-live: ● service preview for ${sha} at ${r.url}`);
    return 0;
  }
  if (command === 'go-live') {
    const light = await readLight();
    if (dryRun) await launchPreview({ sha, light, host, deployments }); // the in-memory GitHub starts empty
    const press = { eventName: env.GITHUB_EVENT_NAME, actor: env.GITHUB_ACTOR };
    const r = await goLiveService({ sha, light, host, deployments, press, runUrl });
    log(`commit-live: ● ${sha} is the live service at ${r.url}`);
    return 0;
  }
  if (command === 'teardown') {
    const r = await teardown({ host, deployments, keep: Number(values.keep), log });
    log(`commit-live: kept ${r.kept.length}, tore down ${r.removed.length}`);
    return 0;
  }
  throw new Error(`unknown command ${JSON.stringify(command)} (launch, go-live, teardown, demo)`);
}

// The whole flow end to end against the in-memory GitHub and the mock host.
async function demo(log) {
  const [a, b, c] = ['a', 'b', 'c'].map((ch) => ch.repeat(40));
  const gh = createMemoryGitHub({
    statuses: { ...seedStatus(a, 'lit'), ...seedStatus(b, 'lit'), ...seedStatus(c, 'dark') },
  });
  const deployments = createDeployments(gh, 'owner/repo');
  const host = createMockHost();
  for (const sha of [a, b]) {
    const r = await launchPreview({ sha, light: 'lit', host, deployments });
    log(`demo: ● ${sha.slice(0, 7)} lit → preview ${r.url}`);
  }
  try {
    await launchPreview({ sha: c, light: 'dark', host, deployments });
    throw new Error('demo: a dark commit launched');
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    log(`demo: ○ ${c.slice(0, 7)} dark → refused, nothing launched`);
  }
  try {
    await goLiveService({ sha: b, light: 'lit', host, deployments, press: { eventName: 'push', actor: 'ci' } });
    throw new Error('demo: go-live ran without a press');
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    log('demo: go-live without a person pressing → refused');
  }
  const press = { eventName: 'workflow_dispatch', actor: 'fitzyracing1' };
  const live = await goLiveService({ sha: b, light: 'lit', host, deployments, press });
  log(`demo: ● Go live pressed → ${b.slice(0, 7)} live at ${live.url}`);
  const down = await teardown({ host, deployments, keep: 1 });
  log(`demo: teardown kept ${down.kept.map((s) => s.slice(0, 7))}, removed ${down.removed.map((s) => s.slice(0, 7))}`);
  const pointer = await readLiveService(deployments);
  if (pointer?.sha !== b || host.running.length !== 1) throw new Error('demo: unexpected end state');
  log(`demo: live pointer = ${pointer.sha.slice(0, 7)}; ${gh.calls.length} GitHub calls (in memory)`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      const refused = e instanceof Refused || e instanceof LightError;
      console.error(`::error::commit-live services: ${e.message}`);
      process.exit(refused ? 1 : 2);
    },
  );
