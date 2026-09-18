export interface Sink { send(): void }
export class FirstSink implements Sink { send() { firstLeaf(); } }
export class SecondSink implements Sink { send() { secondLeaf(); } }
export function deliver(sink: Sink) { sink.send(); }
export class DispatchingSink { send(sink: Sink) { sink.send(); } }
export function deliverConcrete(sink: FirstSink) { sink.send(); }
function firstLeaf() {}
function secondLeaf() {}
export interface MissingSink { send(): void }
export function missing(sink: MissingSink) { sink.send(); }
