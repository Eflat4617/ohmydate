// Owner-isolation lint support (ADR-023 guardrail, FU-77). Plain ESLint, no
// extra dependency: a processor that hands the <script> blocks of a .vue file
// to the TypeScript parser, and one rule for owner-bound continuations.
import { parse } from 'vue/compiler-sfc';

/** Storage globals only session/ownerStorage.ts may touch. */
export const STORAGE_GLOBALS = ['localStorage', 'sessionStorage', 'indexedDB'];

const storageMessage = (name) =>
  `Do not use ${name} directly. Browser storage goes through src/session/ownerStorage.ts, ` +
  'which namespaces every key by owner and drops writes from a stale owner (ADR-023).';

/**
 * Rules that make direct browser storage a lint error: the bare global, the
 * same property on window/globalThis/self, bracket access and destructuring.
 */
export const storageRules = {
  'no-restricted-globals': [
    'error',
    {
      globals: STORAGE_GLOBALS.map((name) => ({ name, message: storageMessage(name) })),
      checkGlobalObject: true,
      globalObjects: ['window', 'globalThis', 'self'],
    },
  ],
  // Spelled out per object: the scope analysis behind checkGlobalObject does
  // not know `window` in TypeScript sources.
  'no-restricted-properties': [
    'error',
    ...['window', 'globalThis', 'self'].flatMap((object) =>
      STORAGE_GLOBALS.map((property) => ({ object, property, message: storageMessage(property) })),
    ),
  ],
  'no-restricted-syntax': [
    'error',
    ...STORAGE_GLOBALS.flatMap((name) => [
      {
        selector: `MemberExpression[computed=true][property.value='${name}']`,
        message: storageMessage(name),
      },
      {
        selector: `VariableDeclarator[init.name=/^(window|globalThis|self)$/] > ObjectPattern > Property[key.name='${name}']`,
        message: storageMessage(name),
      },
    ]),
  ],
};

/**
 * Lints the <script> and <script setup> blocks of a .vue file as TypeScript.
 * Templates cannot reach browser globals, so the script is what matters here.
 */
export const vueScriptProcessor = {
  meta: { name: 'ohmydate/vue-script', version: '1.0.0' },
  supportsAutofix: false,
  preprocess(text, filename) {
    const blocks = [];
    const offsets = [];
    try {
      const { descriptor } = parse(text, { filename, sourceMap: false });
      for (const block of [descriptor.script, descriptor.scriptSetup]) {
        if (block === null || block === undefined) continue;
        offsets.push(block.loc.start.line - 1);
        blocks.push({ text: block.content, filename: `${blocks.length}.ts` });
      }
    } catch {
      // An unparsable SFC is the compiler's error to report (vue-tsc, vite build).
    }
    offsetsByFile.set(filename, offsets);
    return blocks;
  },
  postprocess(messages, filename) {
    const offsets = offsetsByFile.get(filename) ?? [];
    offsetsByFile.delete(filename);
    return messages.flatMap((group, index) =>
      group.map((message) => ({
        ...message,
        line: message.line + (offsets[index] ?? 0),
        ...(message.endLine === undefined ? {} : { endLine: message.endLine + (offsets[index] ?? 0) }),
      })),
    );
  },
};

const offsetsByFile = new Map();

function isBoundTask(node) {
  const parent = node.parent;
  if (parent === undefined || parent === null || parent.type !== 'CallExpression') return false;
  if (parent.arguments[0] !== node) return false;
  const callee = parent.callee;
  if (callee.type === 'Identifier') return callee.name === 'runOwnerBound';
  return callee.type === 'MemberExpression' && !callee.computed && callee.property.name === 'runOwnerBound';
}

/**
 * Inside the task given to `runOwnerBound`, every `await` must go through the
 * owner scope (`owner.wait(…)`, `owner.pages(…)`). The scope refuses to resume
 * a continuation whose owner changed, so no line after an await can run for
 * the wrong user — the check a hand-written fence forgets.
 */
const boundAwait = {
  meta: {
    type: 'problem',
    docs: { description: 'await through the owner scope inside runOwnerBound' },
    schema: [],
    messages: {
      unbound:
        'Inside runOwnerBound, await through the owner scope: `await {{name}}.wait(…)`. A bare await resumes even after the signed-in user changed (ADR-023).',
      noScope:
        'This runOwnerBound task awaits but takes no owner scope. Declare it (`async (owner) => …`) and use `await owner.wait(…)`.',
    },
  },
  create(context) {
    // One entry per enclosing function: the scope parameter name of the
    // nearest runOwnerBound task ('' when it declared none), or null outside.
    const stack = [];
    const current = () => (stack.length === 0 ? null : stack[stack.length - 1]);

    function enter(node) {
      if (!isBoundTask(node)) {
        stack.push(current());
        return;
      }
      const first = node.params[0];
      stack.push(first !== undefined && first.type === 'Identifier' ? first.name : '');
    }

    function check(node, awaited) {
      const name = current();
      if (name === null) return;
      if (name === '') {
        context.report({ node, messageId: 'noScope' });
        return;
      }
      const viaScope =
        awaited !== null &&
        awaited.type === 'CallExpression' &&
        awaited.callee.type === 'MemberExpression' &&
        awaited.callee.object.type === 'Identifier' &&
        awaited.callee.object.name === name;
      if (!viaScope) context.report({ node, messageId: 'unbound', data: { name } });
    }

    return {
      FunctionDeclaration: enter,
      FunctionExpression: enter,
      ArrowFunctionExpression: enter,
      'FunctionDeclaration:exit': () => stack.pop(),
      'FunctionExpression:exit': () => stack.pop(),
      'ArrowFunctionExpression:exit': () => stack.pop(),
      AwaitExpression: (node) => check(node, node.argument),
      'ForOfStatement[await=true]': (node) => check(node, null),
    };
  },
};

export const ownerIsolationPlugin = {
  meta: { name: 'ohmydate-owner-isolation', version: '1.0.0' },
  rules: { 'bound-await': boundAwait },
};
