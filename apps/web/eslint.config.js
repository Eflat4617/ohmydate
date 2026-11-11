// ESLint for apps/web: the repository rules plus the owner-isolation
// guardrail (docs/blueprint/13-ADR.md, ADR-023 amendment FU-77).
//
// ESLint resolves the config nearest to each linted file, so this file must
// carry the repository rules too; it re-exports them unchanged and adds:
//   1. browser storage only through src/session/ownerStorage.ts;
//   2. inside runOwnerBound, every await goes through the owner scope;
//   3. both for .vue <script> blocks as well as .ts files.
import tseslint from 'typescript-eslint';
import rootConfig from '../../eslint.config.js';
import { ownerIsolationPlugin, storageRules, vueScriptProcessor } from './eslint/owner-isolation.js';

const VUE_SCRIPT = '**/*.vue/*.ts';

// A .vue script block is linted for owner isolation only. The general rules
// were never applied to .vue files (and several misread <script setup>, where
// the template is what uses a binding), so they stay off for those blocks.
const generalRulesOff = Object.fromEntries(
  rootConfig.flatMap((entry) => Object.keys(entry.rules ?? {})).map((name) => [name, 'off']),
);

export default tseslint.config(
  ...rootConfig,
  {
    files: ['**/*.vue'],
    processor: vueScriptProcessor,
  },
  {
    files: [VUE_SCRIPT],
    languageOptions: { parser: tseslint.parser, sourceType: 'module' },
    rules: generalRulesOff,
  },
  {
    // The app's source. Tests and scripts may read raw storage to check it.
    files: ['src/**/*.ts', `src/${VUE_SCRIPT}`],
    // The one module that may touch browser storage.
    ignores: ['src/session/ownerStorage.ts'],
    rules: storageRules,
  },
  {
    files: ['src/**/*.ts', `src/${VUE_SCRIPT}`, 'test/**/*.ts'],
    plugins: { 'owner-isolation': ownerIsolationPlugin },
    rules: { 'owner-isolation/bound-await': 'error' },
  },
);
