#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const candidateRoot = path.resolve(process.argv[2] ?? '.');
const srcRoot = path.join(candidateRoot, 'src');

if (!fs.existsSync(srcRoot)) {
  console.error(`Patchwork invariant audit: src directory not found at ${srcRoot}`);
  process.exit(1);
}

const violations = [];

function toRepoPath(filePath) {
  return path.relative(candidateRoot, filePath).split(path.sep).join('/');
}

function isTestFile(repoPath) {
  return repoPath.includes('/__tests__/') || repoPath.endsWith('.test.ts');
}

function isAllowedPrCreationEntrypoint(repoPath) {
  return repoPath === 'src/github/createPR.ts';
}

function isGithubSource(repoPath) {
  return repoPath.startsWith('src/github/');
}

function collectTsFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

function report(repoPath, sourceFile, node, message) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  violations.push(`${repoPath}:${line + 1}:${character + 1} ${message}`);
}

function reportFile(repoPath, message) {
  violations.push(`${repoPath}: ${message}`);
}

function accessName(node, sourceFile, stringConstants) {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }

  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression
  ) {
    return nodeStringValue(node.argumentExpression, sourceFile, stringConstants);
  }

  return undefined;
}

function accessExpression(node) {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return node.expression;
  }

  return undefined;
}

function isAccessNamed(node, name, sourceFile, stringConstants) {
  return accessName(node, sourceFile, stringConstants) === name;
}

function isFalseLiteral(node) {
  return node.kind === ts.SyntaxKind.FalseKeyword;
}

function isTrueLiteral(node) {
  return node.kind === ts.SyntaxKind.TrueKeyword;
}

function isLiteralFalseType(node) {
  return Boolean(
    node &&
      ts.isLiteralTypeNode(node) &&
      node.literal.kind === ts.SyntaxKind.FalseKeyword,
  );
}

function nodeStringValue(node, sourceFile, stringConstants) {
  if (!node) {
    return undefined;
  }

  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }

  if (ts.isIdentifier(node) && stringConstants?.has(node.text)) {
    return stringConstants.get(node.text);
  }

  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return nodeStringValue(node.expression, sourceFile, stringConstants);
  }

  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = nodeStringValue(node.left, sourceFile, stringConstants);
    const right = nodeStringValue(node.right, sourceFile, stringConstants);
    return left !== undefined && right !== undefined ? `${left}${right}` : undefined;
  }

  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expressionValue = nodeStringValue(span.expression, sourceFile, stringConstants);
      if (expressionValue === undefined) {
        return undefined;
      }
      value += expressionValue + span.literal.text;
    }
    return value;
  }

  return undefined;
}

function propertyNameText(name, sourceFile, stringConstants) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  if (ts.isComputedPropertyName(name)) {
    return nodeStringValue(name.expression, sourceFile, stringConstants);
  }

  return undefined;
}

function objectStringProperty(objectLiteral, propertyName, sourceFile, stringConstants) {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }

    if (propertyNameText(property.name, sourceFile, stringConstants) !== propertyName) {
      continue;
    }

    return nodeStringValue(property.initializer, sourceFile, stringConstants);
  }

  return undefined;
}

function isCreatePullRequestRoute(route) {
  if (!route) {
    return false;
  }

  const normalized = route.replace(/\s+/g, ' ');
  return /\bPOST\b/i.test(normalized) && /\/repos\//.test(normalized) && /\/pulls\b/.test(normalized);
}

function isCreatePullRequestGraphql(query) {
  return Boolean(query && /\bmutation\b/i.test(query) && /\bcreatePullRequest\b/.test(query));
}

function isGitHubGraphqlRoute(route) {
  if (!route) {
    return false;
  }

  const normalized = route.replace(/\s+/g, ' ');
  return /\bPOST\b/i.test(normalized) && /\/graphql\b/.test(normalized);
}

function isCreatePullRequestOptions(node, sourceFile, stringConstants) {
  if (!ts.isObjectLiteralExpression(node)) {
    return false;
  }

  const method = objectStringProperty(node, 'method', sourceFile, stringConstants);
  const url =
    objectStringProperty(node, 'url', sourceFile, stringConstants) ??
    objectStringProperty(node, 'path', sourceFile, stringConstants);

  return Boolean(method && /^POST$/i.test(method) && url && /\/repos\//.test(url) && /\/pulls\b/.test(url));
}

function bindingNameText(name) {
  return ts.isIdentifier(name) ? name.text : undefined;
}

function isConstVariableDeclaration(node) {
  return Boolean(
    node.parent &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0,
  );
}

function collectStringConstants(sourceFile) {
  const stringConstants = new Map();
  const ambiguousNames = new Set();
  let changed = true;

  while (changed) {
    changed = false;

    function visit(node) {
      if (ts.isVariableDeclaration(node) && isConstVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const value = nodeStringValue(node.initializer, sourceFile, stringConstants);
        if (value !== undefined && !ambiguousNames.has(node.name.text)) {
          if (!stringConstants.has(node.name.text)) {
            stringConstants.set(node.name.text, value);
            changed = true;
          } else if (stringConstants.get(node.name.text) !== value) {
            stringConstants.delete(node.name.text);
            ambiguousNames.add(node.name.text);
            changed = true;
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return stringConstants;
}

function collectAliases(sourceFile, stringConstants) {
  const pullsAliases = new Set(['pulls']);
  const requestAliases = new Set(['request']);
  const graphqlAliases = new Set(['graphql']);
  const pullCreateAliases = new Set();
  let changed = true;

  function expressionAliasesPulls(expression) {
    return Boolean(
      expression &&
        (isAccessNamed(expression, 'pulls', sourceFile, stringConstants) ||
          (ts.isIdentifier(expression) && pullsAliases.has(expression.text))),
    );
  }

  function expressionAliasesRequest(expression) {
    return Boolean(
      expression &&
        (isAccessNamed(expression, 'request', sourceFile, stringConstants) ||
          (ts.isIdentifier(expression) && requestAliases.has(expression.text))),
    );
  }

  function expressionAliasesGraphql(expression) {
    return Boolean(
      expression &&
        (isAccessNamed(expression, 'graphql', sourceFile, stringConstants) ||
          (ts.isIdentifier(expression) && graphqlAliases.has(expression.text))),
    );
  }

  function expressionAliasesPullCreate(expression) {
    if (!expression) {
      return false;
    }

    if (ts.isIdentifier(expression) && pullCreateAliases.has(expression.text)) {
      return true;
    }

    return Boolean(
      isAccessNamed(expression, 'create', sourceFile, stringConstants) &&
        expressionAliasesPulls(accessExpression(expression)),
    );
  }

  function isBoundAliasOf(expression, predicate) {
    return Boolean(
      ts.isCallExpression(expression) &&
        isAccessNamed(expression.expression, 'bind', sourceFile, stringConstants) &&
        predicate(accessExpression(expression.expression)),
    );
  }

  function initializerAliasesPulls(initializer) {
    return expressionAliasesPulls(initializer);
  }

  function initializerAliasesRequest(initializer) {
    return Boolean(
      initializer &&
        (expressionAliasesRequest(initializer) || isBoundAliasOf(initializer, expressionAliasesRequest)),
    );
  }

  function initializerAliasesGraphql(initializer) {
    return Boolean(
      initializer &&
        (expressionAliasesGraphql(initializer) || isBoundAliasOf(initializer, expressionAliasesGraphql)),
    );
  }

  function initializerAliasesPullCreate(initializer) {
    return Boolean(
      initializer &&
        (expressionAliasesPullCreate(initializer) ||
          isBoundAliasOf(initializer, expressionAliasesPullCreate)),
    );
  }

  function maybeAdd(set, name) {
    if (name && !set.has(name)) {
      set.add(name);
      changed = true;
    }
  }

  while (changed) {
    changed = false;

    function visit(node) {
      if (ts.isVariableDeclaration(node)) {
        if (ts.isIdentifier(node.name)) {
          if (initializerAliasesPulls(node.initializer)) {
            maybeAdd(pullsAliases, node.name.text);
          }
          if (initializerAliasesRequest(node.initializer)) {
            maybeAdd(requestAliases, node.name.text);
          }
          if (initializerAliasesGraphql(node.initializer)) {
            maybeAdd(graphqlAliases, node.name.text);
          }
          if (initializerAliasesPullCreate(node.initializer)) {
            maybeAdd(pullCreateAliases, node.name.text);
          }
        }

        if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const propertyName = element.propertyName
              ? propertyNameText(element.propertyName, sourceFile, stringConstants)
              : bindingNameText(element.name);
            const boundName = bindingNameText(element.name);
            if (propertyName === 'pulls') {
              maybeAdd(pullsAliases, boundName);
            }
            if (propertyName === 'request') {
              maybeAdd(requestAliases, boundName);
            }
            if (propertyName === 'graphql') {
              maybeAdd(graphqlAliases, boundName);
            }
            if (propertyName === 'create' && initializerAliasesPulls(node.initializer)) {
              maybeAdd(pullCreateAliases, boundName);
            }
          }
        }
      }

      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (ts.isIdentifier(node.left)) {
          if (initializerAliasesPulls(node.right)) {
            maybeAdd(pullsAliases, node.left.text);
          }
          if (initializerAliasesRequest(node.right)) {
            maybeAdd(requestAliases, node.left.text);
          }
          if (initializerAliasesGraphql(node.right)) {
            maybeAdd(graphqlAliases, node.left.text);
          }
          if (initializerAliasesPullCreate(node.right)) {
            maybeAdd(pullCreateAliases, node.left.text);
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return {
    pullsAliases,
    requestAliases,
    graphqlAliases,
    pullCreateAliases,
    initializerAliasesPulls,
    expressionAliasesPullCreate,
    expressionAliasesRequest,
    expressionAliasesGraphql,
    initializerAliasesPullCreate,
  };
}

function isStaticRequestRoute(node, sourceFile, stringConstants) {
  if (!node) {
    return false;
  }

  if (nodeStringValue(node, sourceFile, stringConstants) !== undefined) {
    return true;
  }

  if (ts.isObjectLiteralExpression(node)) {
    const method = objectStringProperty(node, 'method', sourceFile, stringConstants);
    const url =
      objectStringProperty(node, 'url', sourceFile, stringConstants) ??
      objectStringProperty(node, 'path', sourceFile, stringConstants);
    return method !== undefined && url !== undefined;
  }

  return false;
}

function auditPrCreationEntrypoints(repoPath, sourceFile, stringConstants) {
  if (isAllowedPrCreationEntrypoint(repoPath) || isTestFile(repoPath)) {
    return;
  }

  const {
    pullsAliases,
    requestAliases,
    graphqlAliases,
    pullCreateAliases,
    initializerAliasesPulls,
    expressionAliasesPullCreate,
    expressionAliasesRequest,
    expressionAliasesGraphql,
    initializerAliasesPullCreate,
  } = collectAliases(sourceFile, stringConstants);

  function isPullsCreateCallee(callee) {
    if (ts.isIdentifier(callee) && pullCreateAliases.has(callee.text)) {
      return true;
    }

    if (!isAccessNamed(callee, 'create', sourceFile, stringConstants)) {
      return false;
    }

    const receiver = accessExpression(callee);
    return Boolean(
      receiver &&
        (isAccessNamed(receiver, 'pulls', sourceFile, stringConstants) ||
          (ts.isIdentifier(receiver) && pullsAliases.has(receiver.text))),
    );
  }

  function isRequestCallee(callee) {
    return Boolean(
      isAccessNamed(callee, 'request', sourceFile, stringConstants) ||
        (ts.isIdentifier(callee) && requestAliases.has(callee.text)),
    );
  }

  function isGraphqlCallee(callee) {
    return Boolean(
      isAccessNamed(callee, 'graphql', sourceFile, stringConstants) ||
        (ts.isIdentifier(callee) && graphqlAliases.has(callee.text)),
    );
  }

  function isRequestDefaultsCallee(callee) {
    return Boolean(
      isAccessNamed(callee, 'defaults', sourceFile, stringConstants) &&
        expressionAliasesRequest(accessExpression(callee)),
    );
  }

  function isGraphqlDefaultsCallee(callee) {
    return Boolean(
      isAccessNamed(callee, 'defaults', sourceFile, stringConstants) &&
        expressionAliasesGraphql(accessExpression(callee)),
    );
  }

  function isPullCreateMethodMetaCallee(callee) {
    const method = accessName(callee, sourceFile, stringConstants);
    return Boolean(
      (method === 'bind' || method === 'call' || method === 'apply') &&
        expressionAliasesPullCreate(accessExpression(callee)),
    );
  }

  function variableDeclarationAliasesPullCreate(node) {
    if (initializerAliasesPullCreate(node.initializer)) {
      return true;
    }

    if (!ts.isObjectBindingPattern(node.name) || !initializerAliasesPulls(node.initializer)) {
      return false;
    }

    return node.name.elements.some((element) => {
      const propertyName = element.propertyName
        ? propertyNameText(element.propertyName, sourceFile, stringConstants)
        : bindingNameText(element.name);
      return propertyName === 'create';
    });
  }

  function visit(node) {
    if (ts.isVariableDeclaration(node) && variableDeclarationAliasesPullCreate(node)) {
      report(repoPath, sourceFile, node, 'INVARIANT #1: pull request create method alias outside src/github/createPR.ts');
    }

    if (ts.isCallExpression(node)) {
      if (isPullCreateMethodMetaCallee(node.expression)) {
        report(repoPath, sourceFile, node, 'INVARIANT #1: pull request create method alias outside src/github/createPR.ts');
      }

      if (isPullsCreateCallee(node.expression)) {
        report(repoPath, sourceFile, node, 'INVARIANT #1: pull request creation outside src/github/createPR.ts');
      }

      if (isRequestDefaultsCallee(node.expression) || isGraphqlDefaultsCallee(node.expression)) {
        report(repoPath, sourceFile, node, 'INVARIANT #1: GitHub request defaults outside src/github/createPR.ts can hide pull request creation');
      }

      if (isRequestCallee(node.expression)) {
        const firstArg = node.arguments[0];
        const route = nodeStringValue(firstArg, sourceFile, stringConstants);
        if (
          isCreatePullRequestRoute(route) ||
          isGitHubGraphqlRoute(route) ||
          (firstArg && isCreatePullRequestOptions(firstArg, sourceFile, stringConstants))
        ) {
          report(repoPath, sourceFile, node, 'INVARIANT #1: GitHub pull request REST create route outside src/github/createPR.ts');
        } else if (!isStaticRequestRoute(firstArg, sourceFile, stringConstants)) {
          report(repoPath, sourceFile, node, 'INVARIANT #1: GitHub REST request routes outside src/github/createPR.ts must be static');
        }
      }

      if (isGraphqlCallee(node.expression)) {
        const firstArg = node.arguments[0];
        const query = nodeStringValue(firstArg, sourceFile, stringConstants);
        if (isCreatePullRequestGraphql(query)) {
          report(repoPath, sourceFile, node, 'INVARIANT #1: GitHub GraphQL createPullRequest outside src/github/createPR.ts');
        } else if (query === undefined) {
          report(repoPath, sourceFile, node, 'INVARIANT #1: GitHub GraphQL operations outside src/github/createPR.ts must be static');
        }
      }
    }

    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      expressionAliasesPullCreate(node)
    ) {
      report(repoPath, sourceFile, node, 'INVARIANT #1: pull request create method reference outside src/github/createPR.ts');
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

function auditAutoCreatePr(repoPath, sourceFile, stringConstants) {
  let sawStartRunInput = false;
  let sawAutoCreatePrMember = false;

  function auditPropertySignature(node) {
    if (propertyNameText(node.name, sourceFile, stringConstants) !== 'autoCreatePR') {
      return;
    }

    sawAutoCreatePrMember = true;
    if (node.questionToken || !isLiteralFalseType(node.type)) {
      report(repoPath, sourceFile, node, 'INVARIANT #2: StartRunInput.autoCreatePR must be the literal false type');
    }
  }

  function auditAutoCreatePrValue(node) {
    if (
      ts.isPropertyAssignment(node) &&
      propertyNameText(node.name, sourceFile, stringConstants) === 'autoCreatePR' &&
      !isFalseLiteral(node.initializer)
    ) {
      report(repoPath, sourceFile, node, 'INVARIANT #2: autoCreatePR values must be the literal false');
    }

    if (
      ts.isPropertyAssignment(node) &&
      ts.isComputedPropertyName(node.name) &&
      propertyNameText(node.name, sourceFile, stringConstants) === undefined &&
      !isFalseLiteral(node.initializer)
    ) {
      report(repoPath, sourceFile, node, 'INVARIANT #2: computed autoCreatePR keys must resolve statically or use the literal false');
    }

    if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'autoCreatePR') {
      report(repoPath, sourceFile, node, 'INVARIANT #2: autoCreatePR must not be passed through a variable');
    }

    if (
      ts.isBinaryExpression(node) &&
      isAccessNamed(node.left, 'autoCreatePR', sourceFile, stringConstants) &&
      !isFalseLiteral(node.right)
    ) {
      report(repoPath, sourceFile, node, 'INVARIANT #2: autoCreatePR assignments must be the literal false');
    }

    if (
      ts.isBinaryExpression(node) &&
      ts.isElementAccessExpression(node.left) &&
      accessName(node.left, sourceFile, stringConstants) === undefined &&
      isTrueLiteral(node.right)
    ) {
      report(repoPath, sourceFile, node, 'INVARIANT #2: computed autoCreatePR assignment keys must resolve statically');
    }
  }

  function visit(node) {
    if (repoPath === 'src/agent/cursorClient.ts' && ts.isInterfaceDeclaration(node) && node.name.text === 'StartRunInput') {
      sawStartRunInput = true;
      for (const member of node.members) {
        if (ts.isPropertySignature(member)) {
          auditPropertySignature(member);
        }
      }
    }

    auditAutoCreatePrValue(node);
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (repoPath === 'src/agent/cursorClient.ts') {
    if (!sawStartRunInput) {
      reportFile(repoPath, 'INVARIANT #2: StartRunInput interface is missing');
    } else if (!sawAutoCreatePrMember) {
      reportFile(repoPath, 'INVARIANT #2: StartRunInput.autoCreatePR is missing');
    }
  }
}

function auditOctokitImports(repoPath, sourceFile, stringConstants) {
  if (isGithubSource(repoPath) || isTestFile(repoPath)) {
    return;
  }

  function isOctokitRestSpecifier(node) {
    return nodeStringValue(node, sourceFile, stringConstants) === '@octokit/rest';
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) && isOctokitRestSpecifier(node.moduleSpecifier)) {
      report(repoPath, sourceFile, node, 'INVARIANT #3: @octokit/rest import outside src/github/**');
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && isOctokitRestSpecifier(node.moduleSpecifier)) {
      report(repoPath, sourceFile, node, 'INVARIANT #3: @octokit/rest export outside src/github/**');
    }

    if (ts.isCallExpression(node) && node.arguments[0]) {
      const isDynamicImport =
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require');

      if (isDynamicImport) {
        const specifier = nodeStringValue(node.arguments[0], sourceFile, stringConstants);
        if (specifier === '@octokit/rest') {
          report(repoPath, sourceFile, node, 'INVARIANT #3: @octokit/rest dynamic import outside src/github/**');
        } else if (specifier === undefined) {
          report(repoPath, sourceFile, node, 'INVARIANT #3: dynamic import specifiers outside src/github/** must be static');
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

const sourceFiles = collectTsFiles(srcRoot).map((filePath) => {
  const text = fs.readFileSync(filePath, 'utf8');
  return {
    filePath,
    repoPath: toRepoPath(filePath),
    sourceFile: ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
  };
});

for (const { repoPath, sourceFile } of sourceFiles) {
  const stringConstants = collectStringConstants(sourceFile);
  auditPrCreationEntrypoints(repoPath, sourceFile, stringConstants);
  auditAutoCreatePr(repoPath, sourceFile, stringConstants);
  auditOctokitImports(repoPath, sourceFile, stringConstants);
}

if (violations.length > 0) {
  console.error(`Patchwork invariant violations: ${violations.length}.`);
  for (const violation of violations) {
    console.error(`  ${violation}`);
  }
  console.error("See CLAUDE.md section 'Non-negotiable invariants'.");
  process.exit(1);
}

console.log('Patchwork invariant audit passed.');
