import { describeFile, type DescriptorScope, type KeyedDeclaration } from './descriptor.js';

export function isIndexedDeclaration(declaration: KeyedDeclaration): boolean {
  switch (declaration.scope) {
    case 'module':
    case 'top-level':
    case 'named-member':
    case 'function-local':
      return true;
    case 'anonymous-expression':
      return declaration.ownsCallSite;
    case 'excluded':
    case 'other':
      return false;
  }
}

export function indexedDeclarations(file: string, text: string): KeyedDeclaration[] {
  return describeFile(file, text).filter(isIndexedDeclaration);
}

export function scopeOf(declaration: KeyedDeclaration): DescriptorScope {
  return declaration.scope;
}
