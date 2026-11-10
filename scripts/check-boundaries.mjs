#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const DEFAULT_SOURCE_ROOTS = ['apps', 'services', 'packages'];
const ALL_SOURCE = /\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts)$/;
const FIXTURE_EXCLUSION = 'scripts/__fixtures__/boundaries';
const ignoredDirs = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  '.turbo',
  'upstream',
]);
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

export function loadWorkspacePackages(repoRoot) {
  const packages = new Map();
  for (const root of DEFAULT_SOURCE_ROOTS) {
    for (const entry of safeReadDir(join(repoRoot, root))) {
      const manifestPath = join(repoRoot, root, entry, 'package.json');
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (typeof manifest.name === 'string') {
          packages.set(manifest.name, `${root}/${entry}`);
        }
      } catch {
        // Not a workspace package directory.
      }
    }
  }
  return packages;
}

export function collectDefaultFiles(repoRoot) {
  const files = [];
  for (const root of DEFAULT_SOURCE_ROOTS) {
    files.push(...collectSourceFiles(join(repoRoot, root), ALL_SOURCE, repoRoot));
  }
  for (const entry of safeReadDir(repoRoot)) {
    if (ignoredDirs.has(entry) || !ALL_SOURCE.test(entry)) continue;
    const absolute = join(repoRoot, entry);
    if (isExcludedPath(repoRoot, absolute)) continue;
    if (statSync(absolute, { throwIfNoEntry: false })?.isFile()) files.push(absolute);
  }
  files.push(...collectSourceFiles(join(repoRoot, 'scripts'), ALL_SOURCE, repoRoot));
  return [...new Set(files)].sort();
}

export function runBoundaryCheck({ repoRoot, files, workspacePackages } = {}) {
  const root = resolve(repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const packages = workspacePackages ?? loadWorkspacePackages(root);
  const scanned = (files ?? collectDefaultFiles(root)).map((file) => resolve(root, file));
  const violations = [];

  for (const file of scanned) {
    checkFile({ repoRoot: root, file, workspacePackages: packages, violations });
  }

  return { violations, checkedFiles: scanned.length };
}

function safeReadDir(dir) {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function collectSourceFiles(dir, pattern, repoRoot) {
  const files = [];
  for (const entry of safeReadDir(dir)) {
    if (ignoredDirs.has(entry)) continue;
    const absolute = join(dir, entry);
    if (isExcludedPath(repoRoot, absolute)) continue;
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      files.push(...collectSourceFiles(absolute, pattern, repoRoot));
    } else if (pattern.test(entry)) {
      files.push(absolute);
    }
  }
  return files;
}

function isExcludedPath(repoRoot, absolute) {
  const rel = toPosix(relative(repoRoot, absolute));
  return rel === FIXTURE_EXCLUSION || rel.startsWith(`${FIXTURE_EXCLUSION}/`);
}

function toPosix(value) {
  return value.split(sep).join('/');
}

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function checkFile({ repoRoot, file, workspacePackages, violations }) {
  const fileRel = toPosix(relative(repoRoot, file));
  const isDeclarationFile = file.endsWith('.d.ts');
  const text = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );

  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node)
    ) {
      const specifier = specifierOf(node);
      if (specifier !== undefined) {
        inspect(
          { repoRoot, fileRel, file, sourceFile, workspacePackages, violations },
          node,
          specifier,
          isTypeOnly(node) || isDeclarationFile,
        );
      }
    } else if (ts.isImportTypeNode(node)) {
      const specifier = importTypeSpecifier(node);
      if (specifier !== undefined) {
        inspect(
          { repoRoot, fileRel, file, sourceFile, workspacePackages, violations },
          node,
          specifier,
          true,
        );
      }
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        const first = node.arguments[0];
        if (first !== undefined && ts.isStringLiteralLike(first)) {
          inspect(
            { repoRoot, fileRel, file, sourceFile, workspacePackages, violations },
            node,
            first.text,
            false,
          );
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

function importTypeSpecifier(node) {
  const argument = node.argument;
  return argument !== undefined &&
    ts.isLiteralTypeNode(argument) &&
    ts.isStringLiteralLike(argument.literal)
    ? argument.literal.text
    : undefined;
}

function isTypeOnly(node) {
  if (ts.isImportEqualsDeclaration(node)) {
    return node.isTypeOnly;
  }
  if (ts.isImportDeclaration(node)) {
    return node.importClause?.isTypeOnly === true;
  }
  if (ts.isExportDeclaration(node)) {
    return node.isTypeOnly;
  }
  return false;
}

function classifySpecifier({ repoRoot, file, workspacePackages }, specifier) {
  if (specifier.startsWith('node:') || builtins.has(specifier)) {
    return { kind: 'builtin' };
  }
  if (specifier.startsWith('file:')) {
    let absolute;
    try {
      absolute = fileURLToPath(specifier);
    } catch {
      return { kind: 'external', packageName: specifier };
    }
    const rel = toPosix(relative(repoRoot, absolute));
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) {
      return { kind: 'external', packageName: specifier };
    }
    return { kind: 'path', rel };
  }
  if (specifier.startsWith('.')) {
    const absolute = resolve(dirname(file), specifier);
    const rel = toPosix(relative(repoRoot, absolute));
    return { kind: 'path', rel };
  }
  if (specifier.startsWith('/')) {
    const absolute = resolve(specifier);
    const rel = toPosix(relative(repoRoot, absolute));
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) {
      return { kind: 'external', packageName: specifier };
    }
    return { kind: 'path', rel };
  }
  if (/^(?:apps|services|packages|upstream)(?:\/|$)/.test(specifier)) {
    return { kind: 'path', rel: specifier };
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

function inspect(context, node, specifier, typeOnly) {
  const { fileRel, sourceFile, violations } = context;
  const resolved = classifySpecifier(context, specifier);
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
    if (resolved.kind === 'builtin' && !typeOnly) {
      report('domain/no-node-builtins', 'domain must not import Node built-ins at runtime');
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

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === modulePath) {
  const { violations, checkedFiles } = runBoundaryCheck();
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `${violation.file}:${violation.line} [${violation.rule}] ${violation.message}`,
      );
    }
    console.error(
      `\nBoundary check failed: ${violations.length} violation(s) in ${checkedFiles} file(s).`,
    );
    process.exit(1);
  }
  console.log(`Boundary check passed: ${checkedFiles} file(s), 0 violations.`);
}
