// Owner-isolation lint support (ADR-023 guardrail, FU-77). Plain ESLint, no
// extra dependency: a processor that hands the <script> blocks of a .vue file
// to the TypeScript parser, and one rule for owner-bound continuations.
import { parse } from 'vue/compiler-sfc';

/** Storage globals only session/ownerStorage.ts may touch. */
export const STORAGE_GLOBALS = ['localStorage', 'sessionStorage', 'indexedDB'];

const storageMessage = (name) =>
  `Do not use ${name} directly. Browser storage goes through src/session/ownerStorage.ts, ` +
  'which namespaces every key by owner and drops writes from a stale owner (ADR-023).';

const STORAGE_NAME = new RegExp(`^(${STORAGE_GLOBALS.join('|')})$`);

/**
 * Browser storage by any route other than the bare global (which
 * no-restricted-globals reports). The rule does not try to follow aliases of
 * `window`: it rejects the storage NAMES wherever they are used to reach a
 * value, whatever object they are read from —
 *
 *   const b = window; b.localStorage          a property of any object
 *   window.window.localStorage                any chain
 *   self.self.indexedDB, document.defaultView?.sessionStorage, parent.localStorage
 *   const { sessionStorage: s } = globalThis  any destructuring, parameters too
 *   b['localStorage'], b[`localStorage`]      a constant computed key
 *   Reflect.get(window, 'indexedDB')          the name as a string, in any position
 *
 * A key computed at run time (`'local' + 'Storage'`) is beyond a static rule;
 * the owner-switch sweep checks the keys that actually get stored.
 */
const noRawStorage = {
  meta: {
    type: 'problem',
    docs: { description: 'browser storage only through session/ownerStorage.ts' },
    schema: [],
    messages: { raw: storageMessage('{{name}}') },
  },
  create(context) {
    const report = (node, name) => context.report({ node, messageId: 'raw', data: { name } });
    return {
      MemberExpression(node) {
        const property = node.property;
        if (!node.computed && property.type === 'Identifier' && STORAGE_NAME.test(property.name)) {
          report(property, property.name);
        }
      },
      Property(node) {
        if (node.parent.type !== 'ObjectPattern' || node.computed) return;
        if (node.key.type === 'Identifier' && STORAGE_NAME.test(node.key.name)) report(node.key, node.key.name);
      },
      Literal(node) {
        if (typeof node.value === 'string' && STORAGE_NAME.test(node.value)) report(node, node.value);
      },
      TemplateLiteral(node) {
        const text = node.expressions.length === 0 ? node.quasis[0]?.value.cooked : undefined;
        if (typeof text === 'string' && STORAGE_NAME.test(text)) report(node, text);
      },
    };
  },
};

/**
 * Rules that make direct browser storage a lint error: the bare global
 * (scope-aware, so a shadowing local is not mistaken for it) and every other
 * way of naming it (owner-isolation/no-raw-storage).
 */
export const storageRules = {
  'no-restricted-globals': [
    'error',
    ...STORAGE_GLOBALS.map((name) => ({ name, message: storageMessage(name) })),
  ],
  'owner-isolation/no-raw-storage': 'error',
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

/** `(owner: OwnerScope, …) => …`: a helper that runs inside someone's bound task. */
function takesOwnerScope(node) {
  const annotation = node.params[0]?.typeAnnotation?.typeAnnotation;
  return (
    annotation !== undefined &&
    annotation.type === 'TSTypeReference' &&
    annotation.typeName.type === 'Identifier' &&
    annotation.typeName.name === 'OwnerScope'
  );
}

/** The function given to `runOwnerBound(…)`, or any function whose first parameter is an OwnerScope. */
function isBoundTask(node) {
  if (takesOwnerScope(node)) return true;
  const parent = node.parent;
  if (parent === undefined || parent === null || parent.type !== 'CallExpression') return false;
  if (parent.arguments[0] !== node) return false;
  const callee = parent.callee;
  if (callee.type === 'Identifier') return callee.name === 'runOwnerBound';
  return callee.type === 'MemberExpression' && !callee.computed && callee.property.name === 'runOwnerBound';
}

/**
 * Inside the task given to `runOwnerBound` (and inside any helper that takes
 * an `OwnerScope` as its first parameter):
 * - every `await` goes through the owner scope (`owner.wait(…)`,
 *   `owner.pages(…)`), which refuses to resume a continuation whose owner
 *   changed — so no line after an await can run for the wrong user;
 * - every `catch` starts with `owner.rethrowIfStale(cause)`, so the failure
 *   of a stale owner's request is not shown or retried as a real one;
 * - there is no `finally` (it would run for the stale owner too): cleanup
 *   goes in the `onSettled` option.
 * These are the checks a hand-written fence forgets.
 */
const boundAwait = {
  meta: {
    type: 'problem',
    docs: { description: 'keep a runOwnerBound task from acting for a stale owner' },
    schema: [],
    messages: {
      unbound:
        'Inside runOwnerBound, await through the owner scope: `await {{name}}.wait(…)`. A bare await resumes even after the signed-in user changed (ADR-023).',
      noScope:
        'This runOwnerBound task awaits but takes no owner scope. Declare it (`async (owner) => …`) and use `await owner.wait(…)`.',
      unguardedCatch:
        'Inside runOwnerBound, a catch must start with `{{name}}.rethrowIfStale({{param}})`: otherwise the failure of a request the owner change aborted is handled as a real error (ADR-023).',
      noFinally:
        'Inside runOwnerBound, do not use `finally`: it also runs after the signed-in user changed. Put the cleanup in the `onSettled` option.',
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

    function checkCatch(node) {
      const name = current();
      if (name === null) return;
      const param = node.param !== null && node.param.type === 'Identifier' ? node.param.name : null;
      const first = node.body.body[0];
      const guarded =
        name !== '' &&
        param !== null &&
        first !== undefined &&
        first.type === 'ExpressionStatement' &&
        first.expression.type === 'CallExpression' &&
        first.expression.callee.type === 'MemberExpression' &&
        first.expression.callee.object.type === 'Identifier' &&
        first.expression.callee.object.name === name &&
        first.expression.callee.property.name === 'rethrowIfStale' &&
        first.expression.arguments[0]?.type === 'Identifier' &&
        first.expression.arguments[0].name === param;
      if (!guarded) {
        context.report({
          node,
          messageId: 'unguardedCatch',
          data: { name: name === '' ? 'owner' : name, param: param ?? 'cause' },
        });
      }
    }

    return {
      CatchClause: checkCatch,
      'TryStatement[finalizer]': (node) => {
        if (current() !== null) context.report({ node: node.finalizer, messageId: 'noFinally' });
      },
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
  rules: { 'bound-await': boundAwait, 'no-raw-storage': noRawStorage },
};
