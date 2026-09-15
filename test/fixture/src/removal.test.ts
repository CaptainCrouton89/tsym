import { greet } from './greet.js';

export function testCaller(): string {
  return greet('test');
}
