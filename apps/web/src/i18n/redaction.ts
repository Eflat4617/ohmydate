import { t, type PlainKey } from './index';

/**
 * What the AI request path masks before anything is sent (05 §12, FU-91).
 *
 * This mirrors `RedactionKind` in packages/llm/src/privacy.ts, which the web
 * app does not depend on. test/fu-91-consent-copy.spec.ts pins the two
 * together and runs the real redactor on one sample per kind, so the consent
 * and notes copy (built from this list) can never claim a kind that is not
 * masked. Account numbers, names and addresses are NOT masked: privacy.ts
 * lists them as outside its guarantees.
 */
export const MASKED_KINDS = ['email', 'phone', 'rrn', 'api_key'] as const;

export type MaskedKind = (typeof MASKED_KINDS)[number];

const KIND_LABELS: Readonly<Record<MaskedKind, PlainKey>> = {
  email: 'llm.disclosure.kinds.email',
  phone: 'llm.disclosure.kinds.phone',
  rrn: 'llm.disclosure.kinds.rrn',
  api_key: 'llm.disclosure.kinds.api_key',
};

export function maskedKindLabel(kind: MaskedKind): string {
  return t(KIND_LABELS[kind]);
}

/** `이메일·전화번호·주민등록번호·API 키`, in redactor report order. */
export function maskedKindsText(): string {
  return MASKED_KINDS.map(maskedKindLabel).join('·');
}
