export enum Mode { Fast = 1, Slow = 2 }
export namespace Shell { export const NAME = "a"; export function run() { return 1; } }
export function Shell2() {}
export namespace Shell2 { export const meta = 1; }
export interface Grow { a: string }
export interface Grow { b: string }
export default class { method() {} }
declare global { interface GlobalThing { fromA: string } }
const K = "k";
export const table = { [K]: 1, [`${K}2`]: 2 };
export type Big = { kind: "x"; v: 1 } | { kind: "y"; v: 2 };
export function over(a: string): void;
export function over(a: number): void;
export function over(a: unknown): void {}
