/** dsh-typert-loader 读取的 Governor Host face。 */
import { GOVERNOR_REMOTE_DESCRIPTORS } from './remote-contract.js';

export const TYPERT = Object.freeze({
  package: 'dsh-llm-governor',
  face: 'host' as const,
  schemas: [],
  model: {
    services: [
      {
        key: 'governorRemote',
        exportName: 'GovernorRemoteService',
        members: GOVERNOR_REMOTE_DESCRIPTORS.map((item) => ({
          kind: 'method' as const,
          name: item.method,
          signature: `${item.method}(...)`,
        })),
        types: [],
        description: 'Capability-checked Governor Host Remote façade.',
        tags: [],
      },
    ],
    events: [],
    objects: [],
  },
  invocations: GOVERNOR_REMOTE_DESCRIPTORS,
});

export default TYPERT;
