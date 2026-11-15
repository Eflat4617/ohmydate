<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

defineOptions({ inheritAttrs: false });

/**
 * Modal dialog / sheet (FU-09). Render it with v-if; while mounted it:
 * - moves focus inside (`[data-autofocus]`, else the first control, else the panel),
 * - traps Tab / Shift+Tab and reclaims focus that escapes (focusin),
 * - makes the rest of the page `inert` so editors underneath cannot change,
 * - keeps key presses from reaching global single-key shortcuts,
 * - treats Escape (and optionally a backdrop click) as `close` when dismissible,
 * - returns focus to the element that opened it.
 * The panel receives the caller's class / data-* / aria-* attributes.
 */
const props = withDefaults(
  defineProps<{
    labelledby: string;
    describedby?: string;
    role?: 'dialog' | 'alertdialog';
    variant?: 'dialog' | 'sheet';
    size?: 'sm' | 'md' | 'lg';
    dismissible?: boolean;
    closeOnBackdrop?: boolean;
    as?: string;
  }>(),
  {
    role: 'dialog',
    variant: 'dialog',
    size: 'md',
    dismissible: true,
    closeOnBackdrop: false,
    as: 'div',
  },
);

const emit = defineEmits<{ close: [] }>();

const panel = ref<HTMLElement | null>(null);
let opener: HTMLElement | null = null;
const madeInert: HTMLElement[] = [];

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(): HTMLElement[] {
  const root = panel.value;
  if (root === null) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => !element.hasAttribute('inert') && element.getAttribute('aria-hidden') !== 'true',
  );
}

function preferredTarget(): HTMLElement | null {
  const root = panel.value;
  if (root === null) return null;
  const marked = root.querySelector<HTMLElement>('[data-autofocus]');
  if (marked !== null && !(marked as HTMLButtonElement).disabled) return marked;
  return focusables()[0] ?? root;
}

function focusInitial(): void {
  const root = panel.value;
  if (root === null) return;
  if (root.contains(document.activeElement)) return;
  preferredTarget()?.focus();
}

function onFocusIn(event: FocusEvent): void {
  const root = panel.value;
  if (root === null) return;
  const target = event.target;
  if (target instanceof Node && root.contains(target)) return;
  // A later dialog stacked on top of this one owns focus.
  if (target instanceof Element && target.closest('[aria-modal="true"]') !== null) return;
  preferredTarget()?.focus();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    if (props.dismissible) emit('close');
    return;
  }
  // Keep single-key global shortcuts (n, t, /, ?, f, space…) out of the page underneath.
  event.stopPropagation();
  if (event.key !== 'Tab') return;

  const items = focusables();
  if (items.length === 0) {
    event.preventDefault();
    panel.value?.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (first === undefined || last === undefined) return;
  const active = document.activeElement;
  const inside = panel.value?.contains(active ?? null) === true;

  if (event.shiftKey) {
    if (!inside || active === first || active === panel.value) {
      event.preventDefault();
      last.focus();
    }
  } else if (!inside || active === last) {
    event.preventDefault();
    first.focus();
  }
}

function onBackdrop(): void {
  if (props.closeOnBackdrop && props.dismissible) emit('close');
}

function setBackgroundInert(): void {
  const root = panel.value?.parentElement;
  if (root === null || root === undefined) return;
  let node: HTMLElement | null = root;
  while (node !== null && node !== document.body && node.parentElement !== null) {
    for (const sibling of Array.from(node.parentElement.children)) {
      if (sibling === node || !(sibling instanceof HTMLElement)) continue;
      if (sibling.hasAttribute('inert') || sibling.tagName === 'SCRIPT') continue;
      // Never hide another open modal, nor regions that opt out (the toast
      // live region keeps announcing; focus is still pulled back by focusin).
      if (sibling.hasAttribute('data-modal-exempt')) continue;
      if (sibling.querySelector('[aria-modal="true"]') !== null) continue;
      sibling.setAttribute('inert', '');
      madeInert.push(sibling);
    }
    node = node.parentElement;
  }
}

function restoreBackground(): void {
  for (const element of madeInert.splice(0)) element.removeAttribute('inert');
}

onMounted(() => {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  setBackgroundInert();
  document.addEventListener('focusin', onFocusIn, true);
  void nextTick().then(focusInitial);
});

onBeforeUnmount(() => {
  document.removeEventListener('focusin', onFocusIn, true);
  const active = document.activeElement;
  const focusWasInside =
    active === null || active === document.body || panel.value?.contains(active) === true;
  restoreBackground();
  if (focusWasInside && opener !== null && opener.isConnected) opener.focus({ preventScroll: true });
});
</script>

<template>
  <div
    class="dialog-backdrop"
    :class="{ 'dialog-backdrop--sheet': variant === 'sheet' }"
    role="presentation"
    @click.self="onBackdrop"
  >
    <component
      :is="as"
      ref="panel"
      v-bind="$attrs"
      class="dialog glass"
      :class="[`dialog--${variant}`, size === 'md' ? null : `dialog--${size}`]"
      :role="role"
      aria-modal="true"
      :aria-labelledby="labelledby"
      :aria-describedby="describedby"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <slot />
    </component>
  </div>
</template>
