import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRailwayHost, RAILWAY_API } from '../src/services/hosts/railway.mjs';
import { hostFromEnv } from '../src/services/hosts/index.mjs';

const SHA = 'f'.repeat(40);
const config = { projectId: 'p1', serviceId: 's1', liveEnvironmentId: 'env-live', liveUrl: 'https://api.example.com/' };

test('railway host is a dry run by default: no fetch, but the planned operations are recorded', async () => {
  const host = createRailwayHost({ ...config, fetch: () => assert.fail('dry run must not fetch') });
  const r = await host.launch({ sha: SHA });
  assert.match(r.url, /^https:\/\/dry-.*\.up\.railway\.app\/$/);
  assert.deepEqual(
    host.sent.map((s) => s.query),
    ['mutation', 'mutation', 'query', 'mutation'],
  );
  assert.deepEqual(host.sent[0].variables.input, {
    projectId: 'p1',
    name: 'c-ffffffffffff',
    sourceEnvironmentId: 'env-live',
  });
  assert.deepEqual(host.sent[1].variables, { serviceId: 's1', environmentId: r.ref, commitSha: SHA });
  const live = await host.promote({ sha: SHA });
  assert.equal(live.url, 'https://api.example.com/');
  assert.equal(host.sent.at(-2).variables.environmentId, 'env-live');
});

test('railway host refuses to run for real without a token, or with a project token', () => {
  assert.throws(() => createRailwayHost({ ...config, dryRun: false }), /needs a token/);
  assert.throws(
    () => createRailwayHost({ ...config, dryRun: false, token: 't', tokenType: 'project' }),
    /project token/,
  );
  assert.throws(() => createRailwayHost({ token: 't' }), /needs projectId/);
});

test('railway host refuses to delete the live environment', async () => {
  const host = createRailwayHost(config);
  await assert.rejects(host.destroy({ ref: 'env-live' }), /live Railway environment/);
});

function fakeRailway(statuses) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const q = JSON.parse(init.body).query;
    let data;
    if (q.includes('environmentCreate')) data = { environmentCreate: { id: 'env-new' } };
    else if (q.includes('serviceInstanceDeployV2')) data = { serviceInstanceDeployV2: 'dep-1' };
    else if (q.includes('deployment(')) data = { deployment: { id: 'dep-1', status: statuses.shift() } };
    else if (q.includes('serviceDomainCreate')) data = { serviceDomainCreate: { domain: 'c-fff.up.railway.app' } };
    else if (q.includes('environmentDelete')) data = { environmentDelete: true };
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  return { fetch, requests };
}

test('railway host (fake API): polls the deployment until SUCCESS and sends a Bearer token', async () => {
  const api = fakeRailway(['BUILDING', 'DEPLOYING', 'SUCCESS']);
  const host = createRailwayHost({
    ...config,
    dryRun: false,
    token: 'secret-token',
    fetch: api.fetch,
    sleep: async () => {},
  });
  const r = await host.launch({ sha: SHA });
  assert.deepEqual(r, { ref: 'env-new', url: 'https://c-fff.up.railway.app/' });
  assert.equal(api.requests[0].url, RAILWAY_API);
  assert.equal(api.requests[0].headers.Authorization, 'Bearer secret-token');
  assert.equal(api.requests.filter((q) => q.body.query.includes('deployment(')).length, 3);
});

test('railway host (fake API): a crashed deployment deletes the new environment and reports an error', async () => {
  const api = fakeRailway(['CRASHED']);
  const host = createRailwayHost({
    ...config,
    dryRun: false,
    token: 'secret-token',
    fetch: api.fetch,
    sleep: async () => {},
  });
  await assert.rejects(host.launch({ sha: SHA }), /ended CRASHED/);
  const last = api.requests.at(-1).body;
  assert.match(last.query, /environmentDelete/);
  assert.deepEqual(last.variables, { id: 'env-new' });
});

test('railway API errors never include the token', async () => {
  const fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ errors: [{ message: 'Not Authorized' }] }),
  });
  const host = createRailwayHost({ ...config, dryRun: false, token: 'secret-token', fetch });
  await assert.rejects(
    host.promote({ sha: SHA }),
    (e) => /401 Not Authorized/.test(e.message) && !e.message.includes('secret-token'),
  );
});

test('hostFromEnv: railway stays a dry run unless COMMIT_LIVE_REAL=true', () => {
  const env = {
    RAILWAY_PROJECT_ID: 'p',
    RAILWAY_SERVICE_ID: 's',
    RAILWAY_LIVE_ENVIRONMENT_ID: 'e',
    RAILWAY_LIVE_URL: 'https://x/',
  };
  assert.equal(hostFromEnv('railway', env).dryRun, true);
  assert.throws(() => hostFromEnv('railway', { ...env, COMMIT_LIVE_REAL: 'true' }), /needs a token/);
  assert.equal(hostFromEnv('mock', {}).name, 'mock');
  assert.throws(() => hostFromEnv('heroku', {}), /unknown service host/);
});
