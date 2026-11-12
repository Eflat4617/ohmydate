// Owner-isolation lint support (ADR-023 guardrail, FU-77). Plain ESLint, no
// extra dependency: a processor that hands the <script> blocks of a .vue file
// to the TypeScript parser, a rule for browser storage and a rule for
// owner-bound tasks.
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

function isRunOwnerBound(node) {
  if (node === null || node === undefined || node.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (callee.type === 'Identifier') return callee.name === 'runOwnerBound';
  return callee.type === 'MemberExpression' && !callee.computed && callee.property.name === 'runOwnerBound';
}

const isFunction = (node) =>
  node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';

/** The function or variable declaration a name resolves to, looking outwards from `scope` (a parameter is neither). */
function definitionOf(scope, name) {
  for (let current = scope; current !== null; current = current.upper) {
    const variable = current.set.get(name);
    if (variable === undefined) continue;
    const definition = variable.defs[0];
    if (definition === undefined) return null;
    return definition.type === 'FunctionName' || definition.type === 'Variable' ? definition.node : null;
  }
  return null;
}

/** `async function f` or `const f = async () => …` declared in this file. */
function isLocalAsyncFunction(definition) {
  if (definition === null) return false;
  if (definition.type === 'FunctionDeclaration') return definition.async === true;
  if (definition.type !== 'VariableDeclarator' || definition.init === null) return false;
  return isFunction(definition.init) && definition.init.async === true;
}

/** `function* f` or `const f = function* () …` declared in this file. */
function isLocalGenerator(definition) {
  if (definition === null) return false;
  if (definition.type === 'FunctionDeclaration') return definition.generator === true;
  if (definition.type !== 'VariableDeclarator' || definition.init === null) return false;
  return isFunction(definition.init) && definition.init.generator === true;
}

/** `yield* f()`, or handing the steps on: `return f()`, `() => f()`. */
function isDelegated(call) {
  const parent = call.parent;
  if (parent.type === 'YieldExpression') return parent.delegate === true;
  if (parent.type === 'ReturnStatement') return true;
  return parent.type === 'ArrowFunctionExpression' && parent.body === call;
}

/**
 * What the compiler cannot say about owner-bound tasks (session/ownerBound.ts).
 * A task is a generator: the runner checks the owner in the very turn that
 * resumes it, so no line of it runs for a stale owner, and `await` cannot be
 * written in it at all. Three mistakes remain possible:
 *
 * - `notGenerator`: an async function given to runOwnerBound (TypeScript
 *   rejects it too; this also covers untyped code).
 * - `asyncHelper`: a task or helper generator that calls an async function
 *   declared in the same file. The helper's own awaits are not fenced: what it
 *   does after them (announce, focus, cache) can run for the next user. Make
 *   it a generator and delegate with `yield*`.
 * - `notDelegated`: a helper generator called like a function. Calling a
 *   generator runs none of it; it has to be delegated with `yield*` (or its
 *   steps returned to runOwnerBound).
 * - `afterOutcome`: effects after `await runOwnerBound(…)` (or chained with
 *   `.then`) in the function that started the task. That function resumes a
 *   microtask after the task's last line, when the owner may have changed.
 *   What must follow belongs in the task, or in onError / onSettled.
 */
const boundTask = {
  meta: {
    type: 'problem',
    docs: { description: 'keep owner-bound tasks and their callers from acting for a stale owner' },
    schema: [],
    messages: {
      notGenerator:
        'An owner-bound task is a generator (`function* (owner) { … yield* owner.wait(…) … }`), not an async function: an await resumes without the owner being checked (ADR-023).',
      asyncHelper:
        '`{{name}}` is an async function: inside an owner-bound task its own awaits are not fenced. Make it a generator (`function* {{name}}(…)`) and delegate with `yield* {{name}}(…)` (ADR-023).',
      notDelegated:
        '`{{name}}` is a generator: calling it like a function runs none of it. Delegate with `yield* {{name}}(…)` inside an owner-bound task, or run it with `runOwnerBound(() => {{name}}(…))`.',
      afterOutcome:
        'Nothing may follow `await runOwnerBound(…)` but returning or mapping its outcome: this function resumes after the owner may have changed. Move it into the task, or into onError / onSettled (ADR-023).',
    },
  },
  create(context) {
    // One entry per enclosing function.
    const stack = [];
    const top = () => stack[stack.length - 1];

    function enter(node) {
      stack.push({ node, generator: node.generator === true, awaitedTaskEnd: null });
    }

    function isOutcomeAwait(node) {
      return node.type === 'AwaitExpression' && isRunOwnerBound(node.argument);
    }

    return {
      FunctionDeclaration: enter,
      FunctionExpression: enter,
      ArrowFunctionExpression: enter,
      'FunctionDeclaration:exit': () => stack.pop(),
      'FunctionExpression:exit': () => stack.pop(),
      'ArrowFunctionExpression:exit': () => stack.pop(),

      CallExpression(node) {
        if (isRunOwnerBound(node)) {
          const task = node.arguments[0];
          if (task !== undefined && isFunction(task) && task.async === true) {
            context.report({ node: task, messageId: 'notGenerator' });
          }
          const parent = node.parent;
          if (
            parent.type === 'MemberExpression' &&
            parent.object === node &&
            !parent.computed &&
            /^(then|finally|catch)$/.test(parent.property.name)
          ) {
            context.report({ node: parent.property, messageId: 'afterOutcome' });
          }
          return;
        }
        if (node.callee.type !== 'Identifier') return;
        const definition = definitionOf(context.sourceCode.getScope(node), node.callee.name);
        if (isLocalGenerator(definition) && !isDelegated(node)) {
          context.report({ node: node.callee, messageId: 'notDelegated', data: { name: node.callee.name } });
        }
        const current = top();
        if (current !== undefined && current.generator && isLocalAsyncFunction(definition)) {
          context.report({ node: node.callee, messageId: 'asyncHelper', data: { name: node.callee.name } });
        }
      },

      AwaitExpression(node) {
        const current = top();
        if (current !== undefined && isOutcomeAwait(node) && current.awaitedTaskEnd === null) {
          current.awaitedTaskEnd = node.range[1];
        }
      },

      ExpressionStatement(node) {
        const current = top();
        if (current === undefined || current.awaitedTaskEnd === null) return;
        if (node.range[0] < current.awaitedTaskEnd) return;
        if (isOutcomeAwait(node.expression)) return;
        context.report({ node, messageId: 'afterOutcome' });
      },
    };
  },
};

export const ownerIsolationPlugin = {
  meta: { name: 'ohmydate-owner-isolation', version: '1.0.0' },
  rules: { 'bound-task': boundTask, 'no-raw-storage': noRawStorage },
};
