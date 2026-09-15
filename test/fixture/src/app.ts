import { greet, Greeter, shout, type Named } from './greet.js';

let total = 0;

export function run(): void {
  const g = Greeter.make();
  total = 1;
  console.log(g.say('a'), shout('b'), greet('c'));
}

export function unrelated(): number {
  return total;
}

export function describe(named: Named): string {
  return named.describe();
}

export { greet as hello } from './greet.js';

declare function ambient(): void;

export function usesAmbient(): void {
  ambient();
}

class Counter {
  count = 0;
}

abstract class Base {
  abstract dispatch(): void;
}

export function useBase(base: Base): void {
  base.dispatch();
}

const first = (): void => {};
const second = (): void => {};

export function useBoth(): void {
  first();
  second();
}

export function chained(text: string): string[] {
  return text.trim().split(' ');
}
