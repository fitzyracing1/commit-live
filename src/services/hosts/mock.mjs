// A host that launches nothing: it hands back made-up .invalid URLs, so CI can run the whole flow with no secrets.
export function createMockHost({ fail = {} } = {}) {
  const running = new Map();
  let live = null;
  return {
    name: 'mock',
    async launch({ sha }) {
      if (fail.launch) throw new Error('mock host: launch error (simulated)');
      const ref = `mock-${sha.slice(0, 7)}`;
      const url = `https://${sha.slice(0, 7)}.preview.mock.invalid/`;
      running.set(ref, { sha, url });
      return { ref, url };
    },
    async promote({ sha }) {
      if (fail.promote) throw new Error('mock host: promote error (simulated)');
      live = sha;
      return { ref: 'mock-live', url: 'https://live.mock.invalid/' };
    },
    async destroy({ ref }) {
      running.delete(ref);
    },
    get running() {
      return [...running.values()];
    },
    get live() {
      return live;
    },
  };
}
