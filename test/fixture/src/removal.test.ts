import { greet } from './greet.js';

export function testCaller(): string {
  return greet('test');
}

import { bridgeToUnrelated } from './main.js';

bridgeToUnrelated();
