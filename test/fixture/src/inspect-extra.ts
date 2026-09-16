export function invokeDynamic(fn: () => void): void { fn(); }

export function overloaded(value: string): string;
export function overloaded(value: number): number;
export function overloaded(value: string | number): string | number { return value; }
export const overloadUsage = overloaded('text');

export function nestedArrowTarget(): void {}
[1].forEach(() => {
  const nestedArrow = () => nestedArrowTarget();
  nestedArrow();
});

export abstract class AbstractSink { abstract send(): void; }
export class ConcreteSink extends AbstractSink { send(): void { abstractLeaf(); } }
export function deliverAbstract(sink: AbstractSink): void { sink.send(); }
function abstractLeaf(): void {}

export declare class AmbientSink { send(): void; }
export class ConcreteAmbientSink implements AmbientSink { send(): void { ambientLeaf(); } }
export function deliverAmbient(sink: AmbientSink): void { sink.send(); }
function ambientLeaf(): void {}
