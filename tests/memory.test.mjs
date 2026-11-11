import test from 'node:test';
import { RelayCore } from '../app/core/relay-core.js';
import { directRelay } from '../app/core/connector-core.js';
import { scenarios } from './scenarios.mjs';

scenarios(test, async () => {
  const core = new RelayCore();
  const T = 't1';
  return {
    relay: directRelay(core, T),
    device: {
      masters: (s) => core.getMasters(T, s), push: (x) => core.pushTransactions(T, 'u1', structuredClone(x)),
      statuses: (ids) => core.getStatuses(T, ids), retry: (ids) => core.retry(T, ids),
      resolve: (id, c) => core.resolveConflict(T, id, c), log: () => core.getLog(T),
      vanStock: () => core.getVanStock(T), saveSettings: (st) => core.putSettings(T, st),
    },
    cleanup: () => {},
  };
});
