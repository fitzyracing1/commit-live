// Service previews: a lit commit launches a running service; Go live points the stable service at one lit commit.
// The host does the running; GitHub Deployments record it so the repo's Environments UI shows every service.
import { LightError, lamp } from '@fitzyracing1/light-core';
import { CONTEXT } from '../light.mjs';
import { PREVIEW_ENV, LIVE_ENV } from './deployments.mjs';

export class Refused extends Error {}

const PRESS_EVENTS = new Set(['workflow_dispatch', 'check_run']);

// Only a person pressing Go live counts: a manual dispatch or the App's check button, never a bot or a push.
export function assertPressed({ eventName, actor }) {
  if (!PRESS_EVENTS.has(eventName))
    throw new Refused(`Go live needs a person to press it (workflow_dispatch or the check button), not ${eventName}`);
  if (!actor || /\[bot\]$/i.test(actor)) throw new Refused(`Go live was not pressed by a person (actor ${actor})`);
}

function assertLit(light, sha) {
  if (light === undefined || light === null || light === '')
    throw new LightError('no-run', `${sha} has no light, so no service is launched`);
  if (light !== 'lit') throw new Refused(`${sha} is ${lamp('dark')} dark; dark commits never launch a service`);
}

export async function launchPreview({ sha, light, host, deployments, runUrl, requiredContexts = [CONTEXT] }) {
  assertLit(light, sha);
  const deployment = await deployments.create({
    sha,
    environment: PREVIEW_ENV,
    transient: true,
    production: false,
    requiredContexts,
    description: `● lit service preview on ${host.name}`,
    payload: { commitLive: 'service-preview', host: host.name },
  });
  await deployments.status(deployment.id, { state: 'in_progress', logUrl: runUrl, autoInactive: false });
  try {
    const { ref, url } = await host.launch({ sha });
    await deployments.status(deployment.id, {
      state: 'success',
      environmentUrl: url,
      logUrl: runUrl,
      description: `● lit · ref ${ref} · running on ${host.name}`,
      // keep older previews up until teardown decides
      autoInactive: false,
    });
    return { deploymentId: deployment.id, url, ref };
  } catch (e) {
    // a launch error is reported on the deployment; it never changes the commit's light
    await deployments.status(deployment.id, {
      state: 'error',
      logUrl: runUrl,
      description: `launch error on ${host.name}: ${e.message}`,
    });
    throw e;
  }
}

// The newest preview of this sha that is still running, so Go live only promotes something that was launched.
async function runningPreview(deployments, sha) {
  for (const d of await deployments.list({ environment: PREVIEW_ENV, sha }))
    if (ours(d, 'service-preview') && (await deployments.latestState(d.id)) === 'success') return d;
  return null;
}

export async function goLiveService({ sha, light, host, deployments, press, runUrl, requiredContexts = [CONTEXT] }) {
  assertPressed(press);
  assertLit(light, sha);
  const preview = await runningPreview(deployments, sha);
  if (!preview) throw new Refused(`${sha} has no running service preview; launch one before Go live`);
  const previous = [];
  for (const d of await deployments.list({ environment: LIVE_ENV }))
    if (ours(d, 'service-live') && (await deployments.latestState(d.id)) === 'success') previous.push(d);

  const deployment = await deployments.create({
    sha,
    environment: LIVE_ENV,
    transient: false,
    production: true,
    requiredContexts,
    description: `● Go live pressed by ${press.actor}`,
    payload: { commitLive: 'service-live', host: host.name, previewDeployment: preview.id, pressedBy: press.actor },
  });
  await deployments.status(deployment.id, { state: 'in_progress', logUrl: runUrl });
  let url;
  try {
    ({ url } = await host.promote({ sha }));
  } catch (e) {
    await deployments.status(deployment.id, {
      state: 'error',
      logUrl: runUrl,
      description: `go-live error: ${e.message}`,
    });
    throw e;
  }
  await deployments.status(deployment.id, {
    state: 'success',
    environmentUrl: url,
    logUrl: runUrl,
    description: `● lit and live on ${host.name}`,
  });
  // auto_inactive skips production environments, so the old live pointers are retired by hand
  for (const d of previous)
    if (d.id !== deployment.id)
      await deployments.status(d.id, { state: 'inactive', description: `replaced by ${sha.slice(0, 7)}` });
  return { deploymentId: deployment.id, url, previous: previous.map((d) => d.sha) };
}

// An Actions job with `environment: <name>` makes its own deployment (of the workflow's sha, not ours), so only
// deployments commit-live created, tagged in their payload, count.
const ours = (d, kind) => d.payload?.commitLive === kind;

// The live pointer: the sha of the newest service-live deployment whose latest status is success.
export async function readLiveService(deployments) {
  for (const d of await deployments.list({ environment: LIVE_ENV }))
    if (ours(d, 'service-live') && (await deployments.latestState(d.id)) === 'success')
      return { sha: d.sha, deploymentId: d.id };
  return null;
}

// Keep the newest `keep` running previews plus the live commit's; destroy the rest and mark them inactive.
export async function teardown({ host, deployments, keep = 3, log = () => {} }) {
  const live = await readLiveService(deployments);
  const running = [];
  for (const d of await deployments.list({ environment: PREVIEW_ENV }))
    if (ours(d, 'service-preview') && (await deployments.latestState(d.id)) === 'success') running.push(d);
  running.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  const kept = new Set();
  const removed = [];
  for (const d of running) {
    if (kept.size < keep || d.sha === live?.sha) {
      kept.add(d.sha);
      continue;
    }
    const ref = refFromStatuses(await deployments.statuses(d.id));
    await host.destroy({ sha: d.sha, ref });
    await deployments.status(d.id, { state: 'inactive', description: 'torn down by commit-live' });
    removed.push(d.sha);
    log(`commit-live: tore down the service preview for ${d.sha}`);
  }
  return { kept: [...kept], removed };
}

// launchPreview writes the host ref near the start of the success description, so truncation can't cut it
function refFromStatuses(statuses = []) {
  const ok = statuses.find((s) => s.state === 'success');
  return ok?.description?.match(/ref (\S+)/)?.[1];
}
