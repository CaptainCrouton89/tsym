export const STORE_SCHEMA_VERSION = 2;

export const NODE_TABLES = [
  'CREATE NODE TABLE Declaration(key STRING, at STRING, name STRING, qname STRING, kind STRING, exported BOOL, file STRING, dir STRING, top STRING, line INT64, col INT64, endLine INT64, lines INT64, declCount INT64, container STRING, PRIMARY KEY(key))',
  'CREATE NODE TABLE External(key STRING, module STRING, name STRING, PRIMARY KEY(key))',
  'CREATE NODE TABLE Commit(hash STRING, ts STRING, author STRING, subject STRING, PRIMARY KEY(hash))',
] as const;

export const RELATION_TABLES = [
  'CREATE REL TABLE CONTAINS(FROM Declaration TO Declaration)',
  'CREATE REL TABLE REFERENCES(FROM Declaration TO Declaration, FROM Declaration TO External, line INT64, col INT64, role STRING)',
  'CREATE REL TABLE CALLS(FROM Declaration TO Declaration, FROM Declaration TO External, line INT64, col INT64, dispatch BOOL)',
  'CREATE REL TABLE IMPLEMENTS(FROM Declaration TO Declaration)',
  'CREATE REL TABLE EXTENDS(FROM Declaration TO Declaration)',
  'CREATE REL TABLE TYPE_MENTION(FROM Declaration TO Declaration, FROM Declaration TO External, line INT64, col INT64, position STRING)',
  'CREATE REL TABLE IMPORTS(FROM Declaration TO Declaration, FROM Declaration TO External, line INT64, names STRING)',
  'CREATE REL TABLE EXPORTS(FROM Declaration TO Declaration, name STRING, line INT64, col INT64)',
  'CREATE REL TABLE CHANGED(FROM Commit TO Declaration, added INT64, removed INT64)',
  'CREATE REL TABLE RENAMED_FROM(FROM Declaration TO Commit, oldKey STRING, basis STRING)',
] as const;

export const SCHEMA_STATEMENTS = [...NODE_TABLES, ...RELATION_TABLES] as const;
