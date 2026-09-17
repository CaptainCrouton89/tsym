import * as ts from 'ts5';

export type DescriptorScope = 'module' | 'top-level' | 'named-member' | 'function-local' | 'anonymous-expression' | 'excluded' | 'other';

export interface KeyedDeclaration {
  key: string;
  file: string;
  name: string;
  path: string;
  containerPath: string;
  kind: string;
  start: number;
  end: number;
  nameStart: number;
  nameEnd: number;
  scope: DescriptorScope;
  ownsCallSite: boolean;
}

const ANON = '<anon:';
const COMPUTED = '<computed>';

export function parseDescriptorSource(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, scriptKind(file));
}

export function describeFile(file: string, text: string): KeyedDeclaration[] {
  return describeSourceFile(parseDescriptorSource(file, text), file);
}

export function describeSourceFile(source: ts.SourceFile, file = source.fileName): KeyedDeclaration[] {
  const descriptors: KeyedDeclaration[] = [{
    key: `${file}#<module>`,
    file,
    name: '<module>',
    path: '<module>',
    containerPath: '',
    kind: 'module',
    start: 0,
    end: source.end,
    nameStart: 0,
    nameEnd: 0,
    scope: 'module',
    ownsCallSite: false,
  }];
  const anonymousCounts = new Map<string, number>();
  const roleCounts = new Map<string, number>();
  const anchorCounts = new Map<string, number>();
  const literalRoleCounts = new Map<string, number>();

  const nextRole = (container: readonly string[], role: string): number => {
    const key = `${container.join('.')}|${role}`;
    const count = (roleCounts.get(key) ?? 0) + 1;
    roleCounts.set(key, count);
    return count;
  };

  const anchorFor = (node: ts.Node, container: readonly string[]): string | undefined => {
    const parent = node.parent;
    if (!parent || !ts.isCallExpression(parent)) return undefined;
    const argument = parent.arguments.indexOf(node as ts.Expression);
    const callee = callName(parent.expression);
    if (argument < 0 || !callee) return undefined;
    const first = parent.arguments[0];
    const base = first && first !== node && ts.isStringLiteralLike(first)
      ? `<${callee}(${JSON.stringify(first.text)})>`
      : `<${callee}#arg${argument + 1}:${nextRole(container, `${callee}${argument}`)}>`;
    const key = `${container.join('.')}|${base}`;
    const count = (anchorCounts.get(key) ?? 0) + 1;
    anchorCounts.set(key, count);
    return count === 1 ? base : `${base.slice(0, -1)}#${count}>`;
  };

  const anonymousName = (node: ts.Node, container: readonly string[]): string => {
    const anchor = anchorFor(node, container);
    if (anchor) return anchor;
    const key = container.join('.');
    const count = (anonymousCounts.get(key) ?? 0) + 1;
    anonymousCounts.set(key, count);
    return `${ANON}${count}>`;
  };

  const nextLiteralRole = (path: readonly string[], label: string, role: string): number => {
    const key = `${path.join('.')}|${label}|${role}`;
    const count = (literalRoleCounts.get(key) ?? 0) + 1;
    literalRoleCounts.set(key, count);
    return count;
  };

  const literalRole = (node: ts.Node, path: readonly string[]): string => {
    const parent = node.parent;
    const label = ts.isArrayLiteralExpression(node) ? 'arr' : ts.isObjectLiteralExpression(node) ? 'obj' : 'type';
    if (parent && ts.isReturnStatement(parent)) return `<${label}:return:${nextLiteralRole(path, label, 'return')}>`;
    if (parent && ts.isArrayLiteralExpression(parent)) return `<${label}:elem${parent.elements.indexOf(node as ts.Expression)}>`;
    return `<${label}:${nextLiteralRole(path, label, 'literal')}>`;
  };

  const blockSegment = (node: ts.Node, path: readonly string[]): string | undefined => {
    const parent = node.parent;
    if (ts.isBlock(node)) {
      if (parent && ts.isIfStatement(parent)) return parent.thenStatement === node ? `<then:${nextRole(path, 'then')}>` : `<else:${nextRole(path, 'else')}>`;
      if (parent && ts.isTryStatement(parent) && parent.tryBlock === node) return `<try:${nextRole(path, 'try')}>`;
      if (parent && ts.isTryStatement(parent) && parent.finallyBlock === node) return `<finally:${nextRole(path, 'finally')}>`;
      if (parent && (ts.isFunctionLike(parent) || ts.isModuleDeclaration(parent) || ts.isCatchClause(parent) || ts.isIterationStatement(parent, false) || ts.isLabeledStatement(parent))) return undefined;
      return `<block:${nextRole(path, 'block')}>`;
    }
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) return `<loop:${nextRole(path, 'loop')}>`;
    if (ts.isCatchClause(node)) return `<catch:${nextRole(path, 'catch')}>`;
    if (ts.isCaseClause(node) || ts.isDefaultClause(node)) return `<case:${nextRole(path, 'case')}>`;
    return undefined;
  };

  const record = (node: ts.Node, segment: string, path: readonly string[], scope: DescriptorScope): string[] => {
    const declarationPath = [...path, segment];
    const name = declarationNameNode(node) ?? node;
    descriptors.push({
      key: `${file}#${declarationPath.join('.')}`,
      file,
      name: segment,
      path: declarationPath.join('.'),
      containerPath: path.join('.'),
      kind: ts.SyntaxKind[node.kind],
      start: node.getStart(source),
      end: node.getEnd(),
      nameStart: name.getStart(source),
      nameEnd: name.getEnd(),
      scope,
      ownsCallSite: ownsCallSite(node),
    });
    return declarationPath;
  };

  const visit = (node: ts.Node, path: readonly string[], parentNamed: boolean, nameless: boolean): void => {
    let childPath = path;
    let pushed = false;
    let scope: DescriptorScope = 'other';
    const push = (segment: string, nextScope: DescriptorScope, containerPath = path): void => {
      childPath = record(node, segment, containerPath, nextScope);
      scope = nextScope;
      pushed = true;
    };

    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      push(node.name?.text ?? (isDefaultExport(node) ? 'default' : anonymousName(node, path)), topOrFunctionLocal(node));
    } else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) {
      push(node.name.getText(source), topOrNamedMember(node));
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      push(node.name.text, ts.isCatchClause(node.parent) ? 'excluded' : topOrFunctionLocal(node));
    } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      push(node.name.text, bindingElementScope(node));
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      if (ts.isParameterPropertyDeclaration(node, node.parent)) push(node.name.text, 'named-member', path.slice(0, -1));
      else push(node.name.text, 'excluded');
    } else if (ts.isTypeParameterDeclaration(node)) {
      push(node.name.text, 'excluded');
    } else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isEnumMember(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      const name = propertyName(node.name, source) ?? anonymousName(node, path);
      const isExcluded = ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || (ts.isPropertySignature(node) && inlineTypeLiteralMember(node));
      push(name, isExcluded ? 'excluded' : topOrNamedMember(node));
    } else if (ts.isConstructorDeclaration(node)) {
      push('constructor', topOrNamedMember(node));
    } else if (ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isClassExpression(node)) {
      if (!borrowsParentName(node)) push(anonymousName(node, path), 'anonymous-expression');
    } else if (ts.isExportAssignment(node) && isAnonymousExport(node.expression)) {
      push('default', 'top-level');
    }

    if (!pushed && isNamelessLiteral(node, parentNamed, nameless)) {
      const parent = node.parent;
      const arm = parent && (ts.isUnionTypeNode(parent) || ts.isIntersectionTypeNode(parent)) ? `<arm:${parent.types.indexOf(node as ts.TypeNode) + 1}>` : undefined;
      childPath = [...path, arm ?? anchorFor(node, path) ?? literalRole(node, path)];
    }
    if (parentNamed && node.parent && isTypeAnnotation(node.parent, node)) childPath = [...childPath, '<type>'];
    const block = blockSegment(node, childPath);
    if (block) childPath = [...childPath, block];
    ts.forEachChild(node, (child) => visit(child, childPath, pushed, nameless || (!parentNamed && (ts.isObjectLiteralExpression(node) || ts.isTypeLiteralNode(node) || ts.isMappedTypeNode(node)))));
  };

  ts.forEachChild(source, (node) => visit(node, [], false, false));
  return descriptors;
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function declarationNameNode(node: ts.Node): ts.Node | undefined {
  const name = (node as ts.NamedDeclaration).name;
  return name && typeof name !== 'string' ? name : undefined;
}

function propertyName(name: ts.PropertyName | undefined, source: ts.SourceFile): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return `[computed:${name.expression.getText(source).replace(/\s+/g, ' ').trim()}]`;
  return undefined;
}

function isDefaultExport(node: ts.Node): boolean {
  const modifiers = ts.getModifiers(node as ts.HasModifiers);
  return !!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) && !!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function callName(expression: ts.Expression): string | undefined {
  const text = expression.getText().replace(/\s+/g, ' ').trim();
  return text || undefined;
}

function borrowsParentName(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) return true;
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) return true;
  if (ts.isPropertyDeclaration(parent) && parent.initializer === node) return true;
  if (ts.isBindingElement(parent) && parent.initializer === node) return true;
  if (ts.isParameter(parent) && parent.initializer === node) return true;
  if (ts.isEnumMember(parent) && parent.initializer === node) return true;
  if (ts.isExportAssignment(parent)) return true;
  if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent) || ts.isTypeAssertionExpression(parent)) return borrowsParentName(parent);
  return false;
}

function isAnonymousExport(node: ts.Expression): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node) || ts.isObjectLiteralExpression(node);
}

function isNamelessLiteral(node: ts.Node, parentNamed: boolean, alreadyNameless: boolean): boolean {
  if (parentNamed || alreadyNameless) return false;
  return ts.isObjectLiteralExpression(node) || ts.isTypeLiteralNode(node) || ts.isMappedTypeNode(node) || ts.isArrayLiteralExpression(node);
}

function isTypeAnnotation(parent: ts.Node, node: ts.Node): boolean {
  return 'type' in parent && parent.type === node && !ts.isTypeAliasDeclaration(parent) && ts.isTypeNode(node);
}

function bindingElementScope(node: ts.BindingElement): DescriptorScope {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isVariableDeclaration(current)) return ts.isCatchClause(current.parent) ? 'excluded' : topOrFunctionLocal(current);
    if (ts.isParameter(current) || ts.isCatchClause(current)) return 'excluded';
  }
  return 'excluded';
}

function topOrFunctionLocal(node: ts.Node): DescriptorScope {
  if (isTopLevel(node)) return 'top-level';
  if (namedMemberContainer(node)) return 'named-member';
  return hasFunctionAncestor(node) ? 'function-local' : 'other';
}

function topOrNamedMember(node: ts.Node): DescriptorScope {
  if (isTopLevel(node)) return 'top-level';
  return namedMemberContainer(node) ? 'named-member' : 'other';
}

function isTopLevel(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isFunctionLike(current) || ts.isClassLike(current) || ts.isInterfaceDeclaration(current) || ts.isEnumDeclaration(current) || ts.isModuleDeclaration(current) || ts.isTypeAliasDeclaration(current) || ts.isModuleBlock(current) || ts.isTypeLiteralNode(current) || ts.isObjectLiteralExpression(current) || ts.isBlock(current)) return false;
    current = current.parent;
  }
  return !!current;
}

function hasFunctionAncestor(node: ts.Node): boolean {
  for (let current = node.parent; current && !ts.isSourceFile(current); current = current.parent) if (ts.isFunctionLike(current)) return true;
  return false;
}

function namedMemberContainer(node: ts.Node): boolean {
  for (let current = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
    if (ts.isClassDeclaration(current) || ts.isInterfaceDeclaration(current) || ts.isEnumDeclaration(current) || ts.isModuleDeclaration(current) || ts.isTypeAliasDeclaration(current)) return true;
    if (ts.isFunctionLike(current) || ts.isObjectLiteralExpression(current) || ts.isClassStaticBlockDeclaration(current) || ts.isBlock(current) || ts.isCaseBlock(current) || ts.isCaseClause(current) || ts.isDefaultClause(current) || ts.isCatchClause(current) || ts.isIterationStatement(current, false)) return false;
  }
  return false;
}

function inlineTypeLiteralMember(node: ts.PropertySignature): boolean {
  return ts.isTypeLiteralNode(node.parent) && !ts.isTypeAliasDeclaration(node.parent.parent);
}

function ownsCallSite(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child)) found = true;
    else ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}
