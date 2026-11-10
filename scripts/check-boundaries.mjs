#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoots = ['apps', 'services', 'packages'];
const ignoredDirs = new Set(['node_modules', 'dist', 'coverage', '.git', '.turbo']);
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

const workspacePackages = new Map();
for (const root of sourceRoots) {
  for (const entry of safeReadDir(join(repoRoot, root))) {
    const manifestPath = join(repoRoot, root, entry, 'package.json');
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (typeof manifest.name === 'string') {
        workspacePackages.set(manifest.name, `${root}/${entry}`);
      }
    } catch {
      // Not a workspace package directory.
    }
  }
}

const violations = [];
let checkedFiles = 0;

for (const root of sourceRoots) {
  for (const file of collectSourceFiles(join(repoRoot, root))) {
    checkedFiles += 1;
    checkFile(file);
  }
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(
      `${violation.file}:${violation.line} [${violation.rule}] ${violation.message}`,
    );
  }
  console.error(`\nBoundary check failed: ${violations.length} violation(s) in ${checkedFiles} file(s).`);
  process.exit(1);
}

console.log(`Boundary check passed: ${checkedFiles} file(s), 0 violations.`);

function safeReadDir(dir) {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function collectSourceFiles(dir) {
  const files = [];
  for (const entry of safeReadDir(dir)) {
    if (ignoredDirs.has(entry)) continue;
    const absolute = join(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      files.push(...collectSourceFiles(absolute));
    } else if (/\.(?:ts|tsx|mts|cts)$/.test(entry) && !entry.endsWith('.d.ts')) {
      files.push(absolute);
    }
  }
  return files;
}

function toPosix(value) {
  return value.split(sep).join('/');
}

function checkFile(absoluteFile) {
  const fileRel = toPosix(relative(repoRoot, absoluteFile));
  const text = readFileSync(absoluteFile, 'utf8');
  const sourceFile = ts.createSourceFile(
    absoluteFile,
    text,
    ts.ScriptTarget.Latest,
    true,
    absoluteFile.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node)
    ) {
      const specifier = specifierOf(node);
      if (specifier !== undefined) {
        inspect(fileRel, absoluteFile, sourceFile, node, specifier, isTypeOnly(node));
      }
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        const first = node.arguments[0];
        if (first !== undefined && ts.isStringLiteralLike(first)) {
          inspect(fileRel, absoluteFile, sourceFile, node, first.text, false);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

function specifierOf(node) {
  if (ts.isImportEqualsDeclaration(node)) {
    const reference = node.moduleReference;
    return ts.isExternalModuleReference(reference) &&
      reference.expression !== undefined &&
      ts.isStringLiteralLike(reference.expression)
      ? reference.expression.text
      : undefined;
  }
  const specifier = node.moduleSpecifier;
  return specifier !== undefined && ts.isStringLiteralLike(specifier)
    ? specifier.text
    : undefined;
}

function isTypeOnly(node) {
  if (ts.isImportEqualsDeclaration(node)) {
    return node.isTypeOnly;
  }
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (clause === undefined) return false;
    if (clause.isTypeOnly) return true;
    const bindings = clause.namedBindings;
    if (bindings === undefined) return false;
    if (ts.isNamespaceImport(bindings)) return false;
    return (
      bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly)
    );
  }
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return true;
    const clause = node.exportClause;
    if (clause === undefined) return false;
    if (ts.isNamespaceExport(clause)) return false;
    return clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly);
  }
  return false;
}

function classifySpecifier(fileAbs, specifier) {
  if (specifier.startsWith('node:') || builtins.has(specifier)) {
    return { kind: 'builtin' };
  }
  if (specifier.startsWith('.')) {
    const absolute = resolve(dirname(fileAbs), specifier);
    const rel = toPosix(relative(repoRoot, absolute));
    return { kind: 'path', rel };
  }
  if (
    specifier.startsWith('/') ||
    /^(?:apps|services|packages|upstream)(?:\/|$)/.test(specifier)
  ) {
    return { kind: 'path', rel: specifier.replace(/^\//, '') };
  }
  for (const [name, rel] of workspacePackages) {
    if (specifier === name || specifier.startsWith(`${name}/`)) {
      return { kind: 'workspace', rel, packageName: name };
    }
  }
  const packageName = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : (specifier.split('/')[0] ?? specifier);
  return { kind: 'external', packageName };
}

function inspect(fileRel, fileAbs, sourceFile, node, specifier, typeOnly) {
  const resolved = classifySpecifier(fileAbs, specifier);
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const report = (rule, message) => {
    violations.push({ file: fileRel, line, rule, message: `${message} (${specifier})` });
  };

  if (resolved.kind === 'path' && (resolved.rel === '..' || resolved.rel.startsWith('../'))) {
    report('imports-outside-repo', 'import resolves outside the repository');
  }

  if (
    resolved.kind === 'path' &&
    (resolved.rel === 'upstream' || resolved.rel.startsWith('upstream/'))
  ) {
    report('no-upstream-imports', 'imports from the AGPL upstream/ zone are forbidden');
  }

  if (fileRel.startsWith('packages/domain/')) {
    if (resolved.kind === 'builtin') {
      report('domain/no-node-builtins', 'domain must not import Node built-ins');
    } else if (resolved.kind === 'external' && !typeOnly) {
      report(
        'domain/no-runtime-external-import',
        `domain may only import non-workspace package "${resolved.packageName}" as type-only`,
      );
    }
  }

  if (
    fileRel.startsWith('apps/web/') &&
    resolved.kind !== 'external' &&
    resolved.kind !== 'builtin' &&
    (resolved.rel === 'services' || resolved.rel.startsWith('services/'))
  ) {
    report('web/no-service-imports', 'apps/web must not import from services/*');
  }

  if (
    fileRel.startsWith('packages/') &&
    resolved.kind !== 'external' &&
    resolved.kind !== 'builtin' &&
    (resolved.rel === 'apps' ||
      resolved.rel.startsWith('apps/') ||
      resolved.rel === 'services' ||
      resolved.rel.startsWith('services/'))
  ) {
    report('packages/no-app-or-service-imports', 'packages/* must not import apps/* or services/*');
  }
}
