// Lint fixture (owner-lint.spec.ts, FU-77R-1 H2): storage reached through an
// alias of the browser global instead of the global itself. Linted as if it
// lived in src/, every numbered line must FAIL.
declare const view: Window;

export function throughAliases(): unknown[] {
  const browser = window;
  const everything = globalThis;
  const { sessionStorage: store } = everything; // 1 destructuring from an alias
  const { localStorage } = window.window; // 2 destructuring from a chain
  const key = 'indexedDB'; // 3 the name as a string, to be used as a key
  return [
    browser.localStorage.getItem('a'), // 4 alias of window
    window.window.localStorage, // 5 window.window
    self.self.indexedDB, // 6 self chain
    globalThis.self.sessionStorage, // 7 globalThis.self
    document.defaultView?.localStorage, // 8 document.defaultView
    view.sessionStorage, // 9 any object typed as a window
    browser['localStorage'], // 10 computed key on an alias
    browser[`sessionStorage`], // 11 template key
    Reflect.get(window, 'indexedDB'), // 12 reflective read
    (everything as unknown as Record<string, unknown>)[key],
    parent.localStorage, // 13 another browsing context
    store,
    localStorage,
  ];
}

export function throughParameters({ indexedDB: databases }: Window): IDBFactory { // 14 destructured parameter
  return databases;
}
