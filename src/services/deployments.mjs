// GitHub Deployments API: the record of which service runs which commit, shown in the repo's Environments UI.
export const PREVIEW_ENV = 'service-preview';
export const LIVE_ENV = 'service-live';

export function createDeployments(gh, repo) {
  const base = `/repos/${repo}/deployments`;
  return {
    // required_contexts makes GitHub itself refuse (409) unless the commit-live status or check is success (lit)
    async create({ sha, environment, transient, production, requiredContexts, description, payload }) {
      const deployment = await gh.write('POST', base, {
        ref: sha,
        environment,
        auto_merge: false,
        required_contexts: requiredContexts,
        transient_environment: transient,
        production_environment: production,
        description: description?.slice(0, 140),
        payload: payload ?? {},
      });
      // a 202 with only a message means GitHub merged instead of deploying; never expected with auto_merge off
      if (!deployment?.id)
        throw new Error(`GitHub created no deployment for ${sha}: ${deployment?.message ?? 'no id'}`);
      return deployment;
    },
    status(id, { state, environmentUrl, logUrl, description, autoInactive }) {
      return gh.write('POST', `${base}/${id}/statuses`, {
        state,
        ...(environmentUrl ? { environment_url: environmentUrl } : {}),
        ...(logUrl ? { log_url: logUrl } : {}),
        ...(description ? { description: description.slice(0, 140) } : {}),
        ...(autoInactive === undefined ? {} : { auto_inactive: autoInactive }),
      });
    },
    list({ environment, sha } = {}) {
      const query = new URLSearchParams({ per_page: '100' });
      if (environment) query.set('environment', environment);
      if (sha) query.set('sha', sha);
      return gh.get(`${base}?${query}`);
    },
    statuses(id) {
      return gh.get(`${base}/${id}/statuses?per_page=100`);
    },
    async latestState(id) {
      const statuses = await gh.get(`${base}/${id}/statuses?per_page=1`);
      return statuses?.[0]?.state ?? null;
    },
  };
}
