<script setup lang="ts">
import { t } from '../i18n';
import { maskedKindsText } from '../i18n/redaction';
import UiBanner from './ui/UiBanner.vue';

/**
 * What AI planning sends, to whom, the masking limits and how to revoke
 * (ADR-022 + amendments). Shared by the consent dialog and AI settings so the
 * two never drift apart.
 */
</script>

<template>
  <div class="llm-disclosure">
    <dl class="kv-list" :aria-label="t('llm.disclosure.label')">
      <dt>{{ t('llm.disclosure.provider') }}</dt>
      <dd>
        {{
          t('llm.disclosure.providerValue', {
            provider: t('llm.providerName'),
            model: t('llm.modelName'),
            modelId: t('llm.modelId'),
          })
        }}
      </dd>
      <dt>{{ t('llm.disclosure.data') }}</dt>
      <dd>{{ t('llm.disclosure.dataValue') }}</dd>
    </dl>
    <UiBanner tone="warn" :title="t('llm.disclosure.masking')">
      {{ t('llm.disclosure.maskingValue', { kinds: maskedKindsText() }) }}
    </UiBanner>
    <p class="muted">
      <strong>{{ t('llm.disclosure.revoke') }}</strong> · {{ t('llm.disclosure.revokeValue') }}
    </p>
  </div>
</template>
