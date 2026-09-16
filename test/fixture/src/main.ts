import { run } from './app.js';

run();

import { unrelated } from './app.js';

export function bridgeToUnrelated(): number {
  return unrelated();
}
