// Lint fixture (owner-guardrail.spec.ts): every way of reaching browser
// storage without session/ownerStorage.ts. Linted as if it lived in src/,
// each line must FAIL.
export function everyWayIn(): unknown[] {
  const { sessionStorage: session } = window;
  return [
    localStorage.getItem('a'),
    window.localStorage.getItem('b'),
    globalThis.sessionStorage.getItem('c'),
    self.indexedDB,
    window['localStorage'],
    indexedDB.open('d'),
    session,
  ];
}
