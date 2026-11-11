import type { DOMWrapper, VueWrapper } from '@vue/test-utils';
import { mockDb } from '../src/mocks/db';
import type { StoredNote } from '../src/mocks/notes-seed';
import { settle } from './m6-layout-utils';

export interface Captured {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly headers: Headers;
  readonly body: string;
}

/** Record every request the client sends (through MSW) without changing it. */
export function captureRequests(): Captured[] {
  const seen: Captured[] = [];
  const original = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = request.method === 'GET' ? '' : await request.clone().text();
    const url = new URL(request.url);
    seen.push({ method: request.method, path: url.pathname, search: url.search, headers: request.headers, body });
    return original(request);
  });
  return seen;
}

/** A promise the test releases by hand (holds a mock response in flight). */
export function gate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export async function setValue(field: Pick<DOMWrapper<Element>, 'setValue'>, value: string): Promise<void> {
  await field.setValue(value);
  await settle();
}

export function noteById(id: string): StoredNote {
  const note = mockDb.notes.documents.get(id);
  if (note === undefined) throw new Error(`note ${id} missing`);
  return note;
}

export function liveText(wrapper: VueWrapper): string {
  return wrapper.find('[data-note-live]').text();
}

export function buttonIn(root: { findAll(selector: string): DOMWrapper<Element>[] }, label: string): DOMWrapper<Element> {
  const found = root.findAll('button').find((item) => item.text().trim() === label || item.attributes('aria-label') === label);
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found;
}

export function dialogByTitle(title: string): HTMLElement {
  const dialog = [...document.body.querySelectorAll<HTMLElement>('[aria-modal="true"]')].find((element) => {
    const labelledby = element.getAttribute('aria-labelledby');
    return labelledby !== null && document.getElementById(labelledby)?.textContent?.trim() === title;
  });
  if (dialog === undefined) throw new Error(`dialog not found: ${title}`);
  return dialog;
}

export function buttonInElement(root: HTMLElement, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found;
}

export function seedManyNotes(count: number): void {
  for (let index = 0; index < count; index += 1) {
    const id = `01900000-0000-7000-8000-${(0x500 + index).toString(16).padStart(12, '0')}`;
    const minute = String(index % 60).padStart(2, '0');
    mockDb.notes.documents.set(id, {
      id,
      ownerId: mockDb.user.id,
      title: `메모 ${index + 1}`,
      bodyMd: `본문 ${index + 1}`,
      sensitivity: 'P2',
      llmAllowed: false,
      source: 'manual',
      links: [],
      version: 1,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: `2026-11-13T0${Math.floor(index / 60)}:${minute}:00.000Z`,
    });
  }
}
