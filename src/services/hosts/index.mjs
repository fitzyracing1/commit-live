import { createMockHost } from './mock.mjs';
import { createRailwayHost } from './railway.mjs';

// Pick a host from the environment. Railway only runs for real when COMMIT_LIVE_REAL=true; otherwise it is a dry run.
export function hostFromEnv(name, env = process.env) {
  if (name === 'mock') return createMockHost();
  if (name === 'railway')
    return createRailwayHost({
      token: env.RAILWAY_TOKEN,
      tokenType: env.RAILWAY_TOKEN_TYPE || 'workspace',
      projectId: env.RAILWAY_PROJECT_ID,
      serviceId: env.RAILWAY_SERVICE_ID,
      liveEnvironmentId: env.RAILWAY_LIVE_ENVIRONMENT_ID,
      liveUrl: env.RAILWAY_LIVE_URL,
      dryRun: env.COMMIT_LIVE_REAL !== 'true',
      log: (line) => console.log(line),
    });
  throw new Error(`unknown service host ${JSON.stringify(name)} (mock or railway)`);
}
