export type DeclarationKind = 'module' | 'function' | 'class' | 'interface' | 'type' | 'enum' | 'namespace' | 'const' | 'let' | 'var' | 'method' | 'property' | 'getter' | 'setter' | 'constructor';

export interface DeclarationNode {
  key: string;
  at: string;
  name: string;
  qname: string;
  kind: DeclarationKind;
  exported: boolean;
  file: string;
  dir: string;
  top: string;
  line: number;
  col: number;
  endLine: number;
  lines: number;
  declCount: number;
  container: string | null;
}

export interface ExternalNode { key: string; module: string; name: string; }

export type ReferenceRole = 'definition' | 'call' | 'import' | 'type' | 'write' | 'read';
export type TypePosition = 'parameter' | 'return' | 'property' | 'variable' | 'type';

export interface ContainsRelationship { type: 'CONTAINS'; from: string; to: string; }
export interface ReferenceRelationship { type: 'REFERENCES'; from: string; to: string; line: number; col: number; role: ReferenceRole; }
export interface CallRelationship { type: 'CALLS'; from: string; to: string; line: number; col: number; dispatch: boolean; }
export interface TypeMentionRelationship { type: 'TYPE_MENTION'; from: string; to: string; line: number; col: number; position: TypePosition; }
export interface ImportRelationship { type: 'IMPORTS'; from: string; to: string; line: number; names: string; }
export interface ExportRelationship { type: 'EXPORTS'; from: string; to: string; name: string; line: number; col: number; }

export type IndexRelationship = ContainsRelationship | ReferenceRelationship | CallRelationship | TypeMentionRelationship | ImportRelationship | ExportRelationship;

export interface FileGraph {
  declarations: readonly string[];
  relationships: readonly IndexRelationship[];
}

export interface IndexGraph {
  declarations: ReadonlyMap<string, DeclarationNode>;
  externals: ReadonlyMap<string, ExternalNode>;
  files: ReadonlyMap<string, FileGraph>;
  relationships: readonly IndexRelationship[];
  internalSites: number;
  unresolvedOccurrences: number;
}
