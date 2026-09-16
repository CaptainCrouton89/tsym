declare function test(name: string, body: () => void): void;

export function callerOwnerTarget(): void {}

export class CallerOwner {
  #privateCaller(): void { callerOwnerTarget(); }
}

export function fieldOwnerTarget(): void {}

export class FieldOwner {
  handler = () => { fieldOwnerTarget(); };
}

export function fieldFunctionOwnerTarget(): void {}

export class FieldFunctionOwner {
  handler = function (): void { fieldFunctionOwnerTarget(); };
}

test('attributes module callbacks to the module', () => {
  callerOwnerTarget();
  callerOwnerTarget();
});
