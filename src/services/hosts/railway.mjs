// Railway adapter (public GraphQL API). One Railway environment per lit commit, cloned from the live one; going
// live deploys the exact sha to the live environment. Dry-run unless dryRun is false, so nothing is sent by default.
export const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';

const CREATE_ENV = `mutation ($input: EnvironmentCreateInput!) { environmentCreate(input: $input) { id } }`;
const DEPLOY = `mutation ($serviceId: String!, $environmentId: String!, $commitSha: String) {
  serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha) }`;
const DOMAIN = `mutation ($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }`;
const DEPLOYMENT = `query ($id: String!) { deployment(id: $id) { id status } }`;
const DELETE_ENV = `mutation ($id: String!) { environmentDelete(id: $id) }`;

const DONE = new Set(['SUCCESS']);
const STOPPED = new Set(['FAILED', 'CRASHED', 'REMOVED', 'SKIPPED']);

export function createRailwayHost({
  token,
  tokenType = 'workspace', // account / workspace use Bearer; a project token is scoped to one environment
  projectId,
  serviceId,
  liveEnvironmentId,
  liveUrl,
  dryRun = true,
  fetch: fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollMs = 5000,
  timeoutMs = 15 * 60_000,
  log = () => {},
} = {}) {
  const sent = [];
  let fakeId = 0;

  for (const [name, value] of Object.entries({ projectId, serviceId, liveEnvironmentId, liveUrl }))
    if (!value) throw new Error(`railway host needs ${name}`);
  if (!dryRun && !token) throw new Error('railway host needs a token to run for real (RAILWAY_TOKEN)');
  if (!dryRun && tokenType === 'project')
    throw new Error('a Railway project token cannot create environments; use a workspace or account token');

  async function graphql(query, variables) {
    sent.push({ query: query.split(/[({]/)[0].trim(), variables });
    if (dryRun) return fakeAnswer(query, variables);
    const res = await fetchImpl(RAILWAY_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(tokenType === 'project' ? { 'Project-Access-Token': token } : { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json().catch(() => ({}));
    // never echo the request: its headers carry the token
    if (!res.ok || body.errors?.length)
      throw new Error(`railway: HTTP ${res.status} ${body.errors?.map((e) => e.message).join('; ') ?? ''}`.trim());
    return body.data;
  }

  function fakeAnswer(query, variables) {
    fakeId++;
    if (query.includes('environmentCreate')) return { environmentCreate: { id: `dry-env-${fakeId}` } };
    if (query.includes('serviceInstanceDeployV2')) return { serviceInstanceDeployV2: `dry-deploy-${fakeId}` };
    if (query.includes('serviceDomainCreate'))
      return { serviceDomainCreate: { domain: `dry-${variables.input.environmentId}.up.railway.app` } };
    if (query.includes('deployment(')) return { deployment: { id: variables.id, status: 'SUCCESS' } };
    if (query.includes('environmentDelete')) return { environmentDelete: true };
    throw new Error('railway dry run: unknown operation');
  }

  async function waitFor(deploymentId) {
    const started = Date.now();
    for (;;) {
      const { deployment } = await graphql(DEPLOYMENT, { id: deploymentId });
      if (DONE.has(deployment.status)) return;
      if (STOPPED.has(deployment.status))
        throw new Error(`railway deployment ${deploymentId} ended ${deployment.status}`);
      if (Date.now() - started > timeoutMs) throw new Error(`railway deployment ${deploymentId} timed out`);
      log(`railway: ${deploymentId} is ${deployment.status}`);
      await sleep(pollMs);
    }
  }

  async function deploy(environmentId, sha) {
    const data = await graphql(DEPLOY, { serviceId, environmentId, commitSha: sha });
    await waitFor(data.serviceInstanceDeployV2);
    return data.serviceInstanceDeployV2;
  }

  return {
    name: 'railway',
    dryRun,
    sent,
    async launch({ sha }) {
      const name = `c-${sha.slice(0, 12)}`;
      const { environmentCreate } = await graphql(CREATE_ENV, {
        input: { projectId, name, sourceEnvironmentId: liveEnvironmentId },
      });
      const environmentId = environmentCreate.id;
      try {
        await deploy(environmentId, sha);
        const { serviceDomainCreate } = await graphql(DOMAIN, { input: { serviceId, environmentId } });
        return { ref: environmentId, url: `https://${serviceDomainCreate.domain}/` };
      } catch (e) {
        // don't leave a half-made environment billing in the background
        await graphql(DELETE_ENV, { id: environmentId }).catch(() => {});
        throw e;
      }
    },
    async promote({ sha }) {
      const deploymentId = await deploy(liveEnvironmentId, sha);
      return { ref: deploymentId, url: liveUrl };
    },
    async destroy({ ref }) {
      if (ref === liveEnvironmentId) throw new Error('refusing to delete the live Railway environment');
      await graphql(DELETE_ENV, { id: ref });
    },
  };
}
