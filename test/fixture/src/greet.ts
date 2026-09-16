/** Build a greeting. */
export function greet(name: string): string {
  return `hello ${name}`;
}

export const shout = (name: string): string => greet(name).toUpperCase();

export class Greeter {
  count = 0;
  constructor(private prefix: string, readonly label = 'greeting', plain: number = 0) { void plain; }
  say(name: string): string {
    this.count += 1;
    return this.prefix + this.label + greet(name);
  }
  static make(): Greeter {
    return new Greeter('> ');
  }
}

export interface Named {
  name: string;
  describe(): string;
}

export type Mood = 'happy' | 'sad';

export enum Level {
  Low,
  High = 5,
}
