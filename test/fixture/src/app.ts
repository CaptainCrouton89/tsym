import { greet, Greeter, shout } from './greet.js';

let total = 0;

export function run(): void {
  const g = Greeter.make();
  total = 1;
  console.log(g.say('a'), shout('b'), greet('c'));
}

export function unrelated(): number {
  return total;
}

export { greet as hello } from './greet.js';

class Counter {
  count = 0;
}
