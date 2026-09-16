export function constInitializerOwner(): void {
  const value = constInitializerLeaf();
  void value;
}

function constInitializerLeaf(): string { return 'const'; }

export async function awaitedInitializerOwner(): Promise<void> {
  const value = await awaitedInitializerLeaf();
  void value;
}

async function awaitedInitializerLeaf(): Promise<string> { return 'await'; }

export function argumentOwner(): void { consume(argumentLeaf()); }

function argumentLeaf(): string { return 'argument'; }
function consume(_value: string): void {}

export function conditionOwner(): void {
  if (conditionLeaf()) return;
}

function conditionLeaf(): boolean { return true; }

export function templateOwner(): string { return `template ${templateLeaf()}`; }

function templateLeaf(): string { return 'literal'; }
