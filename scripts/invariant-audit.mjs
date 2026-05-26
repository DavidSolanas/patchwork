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

function accessName(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }

  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    return node.argumentExpression.text;
  }

  return undefined;
}

function accessExpression(node) {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return node.expression;
  }

  return undefined;
}

function isAccessNamed(node, name) {
  return accessName(node) === name;
}

function isFalseLiteral(node) {
  return node.kind === ts.SyntaxKind.FalseKeyword;
}

function isLiteralFalseType(node) {
  return Boolean(
    node &&
      ts.isLiteralTypeNode(node) &&
      node.literal.kind === ts.SyntaxKind.FalseKeyword,
  );
}

function nodeStringValue(node, sourceFile) {
  if (!node) {
    return undefined;
  }

  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }

  if (ts.isTemplateExpression(node)) {
    return node.getText(sourceFile);
  }

  return undefined;
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }

  return undefined;
}

function objectStringProperty(objectLiteral, propertyName, sourceFile) {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }

    if (propertyNameText(property.name) !== propertyName) {
      continue;
    }

    return nodeStringValue(property.initializer, sourceFile);
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

function isCreatePullRequestOptions(node, sourceFile) {
  if (!ts.isObjectLiteralExpression(node)) {
    return false;
  }

  const method = objectStringProperty(node, 'method', sourceFile);
  const url = objectStringProperty(node, 'url', sourceFile) ?? objectStringProperty(node, 'path', sourceFile);

  return Boolean(method && /^POST$/i.test(method) && url && /\/repos\//.test(url) && /\/pulls\b/.test(url));
}

function bindingNameText(name) {
  return ts.isIdentifier(name) ? name.text : undefined;
}

function collectAliases(sourceFile) {
  const pullsAliases = new Set(['pulls']);
  const requestAliases = new Set(['request']);
  let changed = true;

  function initializerAliasesPulls(initializer) {
    return Boolean(
      initializer &&
        (isAccessNamed(initializer, 'pulls') ||
          (ts.isIdentifier(initializer) && pullsAliases.has(initializer.text))),
    );
  }

  function initializerAliasesRequest(initializer) {
    return Boolean(
      initializer &&
        (isAccessNamed(initializer, 'request') ||
          (ts.isIdentifier(initializer) && requestAliases.has(initializer.text))),
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
        }

        if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const propertyName = element.propertyName ? propertyNameText(element.propertyName) : bindingNameText(element.name);
            const boundName = bindingNameText(element.name);
            if (propertyName === 'pulls') {
              maybeAdd(pullsAliases, boundName);
            }
            if (propertyName === 'request') {
              maybeAdd(requestAliases, boundName);
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return { pullsAliases, requestAliases };
}

function auditPrCreationEntrypoints(repoPath, sourceFile) {
  if (isAllowedPrCreationEntrypoint(repoPath) || isTestFile(repoPath)) {
    return;
  }

  const { pullsAliases, requestAliases } = collectAliases(sourceFile);

  function isPullsCreateCallee(callee) {
    if (!isAccessNamed(callee, 'create')) {
      return false;
    }

    const receiver = accessExpression(callee);
    return Boolean(
      receiver &&
        (isAccessNamed(receiver, 'pulls') ||
          (ts.isIdentifier(receiver) && pullsAliases.has(receiver.text))),
    );
  }

  function isRequestCallee(callee) {
    return Boolean(
      isAccessNamed(callee, 'request') ||
        (ts.isIdentifier(callee) && requestAliases.has(callee.text)),
    );
  }

  function visit(node) {
    if (ts.isCallExpression(node)) {
      if (isPullsCreateCallee(node.expression)) {
        report(repoPath, sourceFile, node, 'INVARIANT #1: pull request creation outside src/github/createPR.ts');
      }

      if (isRequestCallee(node.expression)) {
        const firstArg = node.arguments[0];
        const route = nodeStringValue(firstArg, sourceFile);
        if (isCreatePullRequestRoute(route) || (firstArg && isCreatePullRequestOptions(firstArg, sourceFile))) {
          report(repoPath, sourceFile, node, 'INVARIANT #1: GitHub pull request REST create route outside src/github/createPR.ts');
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

function auditAutoCreatePr(repoPath, sourceFile) {
  let sawStartRunInput = false;
  let sawAutoCreatePrMember = false;

  function auditPropertySignature(node) {
    if (!ts.isIdentifier(node.name) || node.name.text !== 'autoCreatePR') {
      return;
    }

    sawAutoCreatePrMember = true;
    if (node.questionToken || !isLiteralFalseType(node.type)) {
      report(repoPath, sourceFile, node, 'INVARIANT #2: StartRunInput.autoCreatePR must be the literal false type');
    }
  }

  function auditAutoCreatePrValue(node) {
    if (ts.isPropertyAssignment(node) && propertyNameText(node.name) === 'autoCreatePR' && !isFalseLiteral(node.initializer)) {
      report(repoPath, sourceFile, node, 'INVARIANT #2: autoCreatePR values must be the literal false');
    }

    if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'autoCreatePR') {
      report(repoPath, sourceFile, node, 'INVARIANT #2: autoCreatePR must not be passed through a variable');
    }

    if (ts.isBinaryExpression(node) && isAccessNamed(node.left, 'autoCreatePR') && !isFalseLiteral(node.right)) {
      report(repoPath, sourceFile, node, 'INVARIANT #2: autoCreatePR assignments must be the literal false');
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

function auditOctokitImports(repoPath, sourceFile) {
  if (isGithubSource(repoPath) || isTestFile(repoPath)) {
    return;
  }

  function isOctokitRestSpecifier(node) {
    return nodeStringValue(node, sourceFile) === '@octokit/rest';
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) && isOctokitRestSpecifier(node.moduleSpecifier)) {
      report(repoPath, sourceFile, node, 'INVARIANT #3: @octokit/rest import outside src/github/**');
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && isOctokitRestSpecifier(node.moduleSpecifier)) {
      report(repoPath, sourceFile, node, 'INVARIANT #3: @octokit/rest export outside src/github/**');
    }

    if (
      ts.isCallExpression(node) &&
      node.arguments[0] &&
      ((node.expression.kind === ts.SyntaxKind.ImportKeyword && isOctokitRestSpecifier(node.arguments[0])) ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require' &&
          isOctokitRestSpecifier(node.arguments[0])))
    ) {
      report(repoPath, sourceFile, node, 'INVARIANT #3: @octokit/rest dynamic import outside src/github/**');
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
  auditPrCreationEntrypoints(repoPath, sourceFile);
  auditAutoCreatePr(repoPath, sourceFile);
  auditOctokitImports(repoPath, sourceFile);
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
