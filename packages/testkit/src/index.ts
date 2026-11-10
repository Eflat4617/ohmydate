export const packageName = '@ohmydate/testkit' as const;

export { FakeClock } from './fake-clock.js';
export { createSeededIdGenerator, seededRandom } from './id-generator.js';
export {
  describeTaskRepositoryContract,
  type TaskRepositoryContractContext,
  type TaskRepositoryContractFactory,
} from './task-repository-contract.js';
