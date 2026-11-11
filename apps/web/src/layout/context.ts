import { inject, type InjectionKey } from 'vue';
import type { ContextObserver } from './observer';

/** The frame's Context Observer, shared with the panels it renders. */
export const LAYOUT_CONTEXT: InjectionKey<ContextObserver> = Symbol('layout-context');

export function useLayoutContext(): ContextObserver {
  const context = inject(LAYOUT_CONTEXT, null);
  if (context === null) throw new Error('layout panels render inside AdaptiveFrame');
  return context;
}
