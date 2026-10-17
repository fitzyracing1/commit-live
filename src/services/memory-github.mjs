// An in-memory GitHub for dry runs and tests: commit statuses plus the deployments endpoints, no network.
export function createMemoryGitHub({ statuses = {}, now = () => new Date().toISOString() } = {}) {
  const deployments = [];
  const deploymentStatuses = new Map();
  const calls = [];
  let nextId = 1;

  function route(method, path, body) {
    calls.push({ method, path, body });
    const url = new URL(path, 'https://api.github.invalid');
    const parts = url.pathname.split('/').filter(Boolean); // repos, owner, name, ...
    const rest = parts.slice(3);
    if (rest[0] === 'commits' && rest[2] === 'statuses' && method === 'GET') return statuses[rest[1]] ?? [];
    if (rest[0] !== 'deployments') throw new Error(`memory GitHub has no route for ${method} ${path}`);
    if (rest.length === 1 && method === 'POST') {
      for (const context of body.required_contexts ?? []) {
        const newest = (statuses[body.ref] ?? []).find((s) => s.context === context);
        if (newest?.state !== 'success') {
          const e = new Error(`POST ${path}: HTTP 409 Conflict: ${context} is not success on ${body.ref}`);
          e.status = 409;
          throw e;
        }
      }
      const deployment = {
        id: nextId++,
        sha: body.ref,
        ref: body.ref,
        environment: body.environment,
        transient_environment: Boolean(body.transient_environment),
        production_environment: Boolean(body.production_environment),
        description: body.description ?? null,
        payload: body.payload ?? {},
        created_at: now(),
      };
      deployments.unshift(deployment);
      deploymentStatuses.set(deployment.id, []);
      return deployment;
    }
    if (rest.length === 1 && method === 'GET') {
      const environment = url.searchParams.get('environment');
      const sha = url.searchParams.get('sha');
      return deployments.filter((d) => (!environment || d.environment === environment) && (!sha || d.sha === sha));
    }
    const id = Number(rest[1]);
    const list = deploymentStatuses.get(id);
    if (!list) throw new Error(`memory GitHub: no deployment ${id}`);
    if (rest[2] === 'statuses' && method === 'POST') {
      const status = { id: nextId++, ...body, created_at: now() };
      list.unshift(status);
      const deployment = deployments.find((d) => d.id === id);
      // GitHub's auto_inactive rule: only non-transient, non-production deployments in the same environment
      if (body.state === 'success' && body.auto_inactive !== false) {
        for (const other of deployments) {
          const otherList = deploymentStatuses.get(other.id);
          if (
            other.id !== id &&
            other.environment === deployment.environment &&
            !other.transient_environment &&
            !other.production_environment &&
            otherList[0]?.state === 'success'
          )
            otherList.unshift({ id: nextId++, state: 'inactive', created_at: now() });
        }
      }
      return status;
    }
    if (rest[2] === 'statuses' && method === 'GET')
      return list.slice(0, Number(url.searchParams.get('per_page') ?? 30));
    throw new Error(`memory GitHub has no route for ${method} ${path}`);
  }

  return {
    get: async (path) => route('GET', path),
    write: async (method, path, body) => route(method, path, body),
    calls,
    deployments,
    stateOf: (id) => deploymentStatuses.get(id)?.[0]?.state ?? null,
    statusesOf: (id) => deploymentStatuses.get(id) ?? [],
  };
}
