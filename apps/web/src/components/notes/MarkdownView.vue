<script setup lang="ts">
import { renderMarkdown } from './markdown';
import { t } from '../../i18n';

/**
 * Renders note Markdown as escaped Vue VNodes (see `markdown.ts`): no
 * `v-html`, no raw HTML, no loaded images, external links only through an
 * explicit "open" link with the address shown next to it.
 */
const props = defineProps<{ source: string }>();

// Rendered in this component's own render effect, so it only re-runs when
// `source` changes.
const Rendered = () => renderMarkdown(props.source);
</script>

<template>
  <div class="markdown-body" data-markdown>
    <Rendered v-if="props.source.trim().length > 0" />
    <p v-else class="muted markdown-empty">{{ t('notes.markdown.empty') }}</p>
  </div>
</template>
