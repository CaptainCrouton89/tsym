// This leading comment is outside every declaration.
function trace(..._args: unknown[]): any { return () => {}; }

export class Decorated {
  @trace()
  method(): number {
    return 1;
  }
}

export function outer(): number {
  void 0;
  const before = 1;
  function inner(): number {
    return before;
  }
  return inner();
}

export const first = 1; export const second = 2;
