import { InMemoryRepository } from '../repository/memory.js';
import { describeStoreContract } from './support/store-contract.js';

describeStoreContract('in-memory', async () => {
  const harness = {
    store: new InMemoryRepository(),
    reset: async () => {
      harness.store = new InMemoryRepository();
    },
    close: async () => undefined,
  };
  return harness;
});
