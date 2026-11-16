import { computed, ref, watch, type Ref } from 'vue';
import { plannerClient, type CommitmentDraft, type TaskDraft } from '../api';
import {
  captureCreateInput,
  captureKindOf,
  captureNeedsReading,
  captureNextStep,
  captureTitle,
  fieldsOfCommitmentDraft,
  fieldsOfTaskDraft,
  flipCapture,
  withTypedStart,
  type CaptureAdded,
  type CaptureCreate,
  type CaptureFields,
  type CaptureKind,
} from '../domain/capture';
import { localInputValue } from '../domain/time';
import { t, tp } from '../i18n';
import { layoutClock } from '../layout/clock';
import { aiAvailable } from '../platform/mode';
import { captureOwnerBinding, isOwnerBindingCurrent, ownerState } from '../session/ownerEpoch';
import { useAuthStore } from '../stores/auth';
import { useLlmConsentStore } from '../stores/llmConsent';
import { useNlDraftRead, type NlDraftRow } from './useNlDraftRead';

/**
 * 담기 (HOLO-04, FLOW.md §2 ① and §4): the capture bar's flow. One line in
 * plain Korean; the app reads it into to-do or appointment drafts; confirming
 * adds them; and the ending is the next step of the loop — "계획에 넣을까요?".
 *
 * - **Which reader:** the two existing ones (`POST /tasks:parse`,
 *   `POST /commitments:parse`). The line's own look picks one
 *   (domain/capture.ts) and every draft can be flipped to the other kind.
 * - **No reading when none is needed:** one thing with no day or time in it
 *   is its own title and is added at once.
 * - **When the AI cannot be used** — no consent, the budget is spent, the
 *   provider is down, the read failed, or (desktop) there is no AI yet — the
 *   line becomes a to-do's title at once. Capture never asks for consent and
 *   never ends on an error.
 * - Reading, 취소, one idempotency key per draft, the refresh and the owner
 *   rules are the shared flow of composables/useNlDraftRead.ts: every request
 *   runs in an owner-bound task, drafts are added only for the owner who made
 *   them, and another owner signing in clears the line, the drafts and what
 *   was added.
 */
export type CaptureDraft =
  | { readonly source: 'task'; readonly draft: TaskDraft }
  | { readonly source: 'commitment'; readonly draft: CommitmentDraft }
  /** Not read: the line itself, as a to-do's title. */
  | { readonly source: 'text'; readonly title: string };

export interface CaptureRow extends NlDraftRow<CaptureDraft>, CaptureFields {
  /** The `datetime-local` value typed for an appointment that has no time yet. */
  startLocal: string;
}

/** Why the last line was not read by the AI (the bar says so in one quiet line). */
export type CaptureNotice = 'no-ai' | 'fallback' | 'unread' | null;

function fieldsOf(draft: CaptureDraft, timeZone: string): CaptureFields {
  if (draft.source === 'task') return fieldsOfTaskDraft(draft.draft, timeZone);
  if (draft.source === 'commitment') return fieldsOfCommitmentDraft(draft.draft);
  return { kind: 'task', title: draft.title, at: null, endAt: null, rrule: undefined, timeZone };
}

export function useCapture(options: { readonly timeZone: Ref<string> }) {
  const llmConsent = useLlmConsentStore();
  const auth = useAuthStore();
  /**
   * What has been added since the bar was opened (the hand-off reads it). It
   * grows line after line, so "계획에 넣기" carries everything just put down;
   * `reset` (계속 담기, closing a finished round, taking the next step) empties it.
   */
  const added = ref<CaptureAdded[]>([]);
  const notice = ref<CaptureNotice>(null);
  let readerKind: CaptureKind = 'task';

  async function createOne(input: CaptureCreate, key: string): Promise<void> {
    // Called from the shared flow's owner-bound task, in its own turn: this is
    // the owner the draft belongs to. A response that arrives after a switch
    // is not recorded for whoever is signed in then.
    const binding = captureOwnerBinding();
    if (input.kind === 'task') {
      const task = await plannerClient.createTask(input.body, key);
      if (isOwnerBindingCurrent(binding)) added.value = [...added.value, { kind: 'task', id: task.id, title: task.title, at: null }];
      return;
    }
    const commitment = await plannerClient.createCommitment(input.body, key);
    if (isOwnerBindingCurrent(binding)) {
      added.value = [...added.value, { kind: 'commitment', id: commitment.id, title: commitment.title, at: commitment.startAt }];
    }
  }

  const nl = useNlDraftRead<CaptureDraft, CaptureRow, CaptureCreate>({
    parseScope: 'capture:parse',
    draftScope: 'capture:draft',
    parse: async (text, key, signal) => {
      if (readerKind === 'commitment') {
        const result = await plannerClient.parseCommitments(text, key, { timeZone: options.timeZone.value, signal });
        return { drafts: result.drafts.map((draft) => ({ source: 'commitment' as const, draft })), leftover: result.leftover };
      }
      const result = await plannerClient.parseTasks(text, key, { timeZone: options.timeZone.value, signal });
      return { drafts: result.drafts.map((draft) => ({ source: 'task' as const, draft })), leftover: result.leftover };
    },
    toRow: (draft, key) => ({ key, draft, state: 'idle', error: null, startLocal: '', ...fieldsOf(draft, options.timeZone.value) }),
    createInput: (row) => captureCreateInput(row),
    create: createOne,
    rowTitle: (row) => row.title.trim(),
    inputTitle: (input) => input.body.title,
    // Everything that lists a task or a 약속.
    refresh: [['tasks'], ['projects'], ['commitments'], ['availability'], ['planner-range'], ['day-agenda'], ['overview-directory']],
    messages: {
      empty: () => t('capture.empty'),
      consentOff: () => t('capture.status.noAi'),
      resultNone: () => t('capture.status.unread'),
      resultCount: (count) => tp('capture.status.read', count),
      cancelled: () => t('capture.status.cancelled'),
      budget: () => t('capture.status.fallback'),
      unavailable: () => t('capture.status.fallback'),
      readError: () => t('capture.status.fallback'),
      addedOne: (title) => t('capture.status.addedOne', { title }),
      addedMany: (count) => tp('capture.status.addedMany', count),
      addError: (title) => t('capture.status.addError', { title }),
      removed: (title) => t('capture.status.removed', { title }),
    },
  });

  // ADR-023: another owner signed in — nothing of this round is theirs.
  watch(
    () => [ownerState.ownerId.value, ownerState.epoch.value],
    () => {
      added.value = [];
      notice.value = null;
    },
  );

  const pending = computed(() => nl.rows.value.filter((row) => row.state !== 'added'));
  /** Everything put in has been added: the bar shows the next step instead of rows. */
  const done = computed(() => added.value.length > 0 && pending.value.length === 0 && !nl.reading.value && !nl.adding.value);
  const next = computed(() => (done.value ? captureNextStep(added.value) : null));

  /** The line as a to-do's title, as one draft of its own. */
  function seedTitle(text: string): void {
    nl.seed([{ source: 'text', title: captureTitle(text) }]);
  }

  /**
   * Enter. With drafts waiting it adds them; otherwise it takes the line:
   * added as it is when nothing needs reading or the AI cannot be used, read
   * into drafts when it can.
   */
  async function submit(): Promise<void> {
    if (!nl.canAct.value || nl.reading.value || nl.adding.value) return;
    if (nl.readyRows.value.length > 0) {
      await nl.addAll();
      return;
    }
    const text = nl.note.value.trim();
    if (text.length === 0) return;
    notice.value = null;

    if (!captureNeedsReading(text)) {
      seedTitle(text);
      await nl.addAll();
      return;
    }
    if (llmConsent.needed || !aiAvailable(auth.user)) {
      // No consent — or, in the desktop bundle, no AI yet: capture does not ask
      // for it and sends nothing to be read. The line is its own title.
      notice.value = 'no-ai';
      seedTitle(text);
      await nl.addAll();
      return;
    }

    readerKind = captureKindOf(text);
    const binding = captureOwnerBinding();
    await nl.read();
    if (!isOwnerBindingCurrent(binding)) return;
    const failure = nl.failure.value;
    if (failure === 'budget' || failure === 'unavailable' || failure === 'error') {
      // The AI cannot be used right now: the line becomes a to-do's title at once.
      notice.value = 'fallback';
      seedTitle(text);
      await nl.addAll();
    } else if (failure === null && nl.readEmpty.value) {
      // Nothing was read out of it: offer the line as it is, for the owner to confirm.
      notice.value = 'unread';
      seedTitle(text);
    }
  }

  /** "제목 그대로 담기": skip the reading for this line. */
  async function addAsTitle(): Promise<void> {
    const text = nl.note.value.trim();
    if (text.length === 0 || !nl.canAct.value || nl.reading.value || nl.adding.value) return;
    notice.value = null;
    seedTitle(text);
    await nl.addAll();
  }

  function dayOf(row: CaptureRow): string | null {
    return row.draft.source === 'commitment' ? row.draft.draft.date : null;
  }

  /** 할 일 ↔ 약속. An appointment that gets no time from the flip asks for one. */
  function flip(row: CaptureRow): void {
    if (row.state !== 'idle') return;
    Object.assign(row, flipCapture(row, dayOf(row)));
    if (row.kind === 'commitment' && row.at === null) {
      // Start from the next full hour, for the owner to change.
      const now = layoutClock().now();
      const nextHour = new Date(now - (now % 3_600_000) + 3_600_000).toISOString();
      row.startLocal = localInputValue(nextHour, row.timeZone);
      Object.assign(row, withTypedStart(row, row.startLocal));
    }
    nl.status.value = t(row.kind === 'commitment' ? 'capture.status.nowCommitment' : 'capture.status.nowTask', {
      title: row.title.trim(),
    });
  }

  function setStart(row: CaptureRow, value: string): void {
    row.startLocal = value;
    Object.assign(row, withTypedStart(row, value));
  }

  /** Start over: the line and whatever was read or added are put away. */
  function reset(): void {
    if (nl.reading.value || nl.adding.value) return;
    nl.rows.value = [];
    nl.leftover.value = '';
    nl.hasResult.value = false;
    nl.readEmpty.value = false;
    nl.failure.value = null;
    nl.status.value = '';
    nl.note.value = '';
    added.value = [];
    notice.value = null;
  }

  return { ...nl, added, notice, pending, done, next, submit, addAsTitle, flip, setStart, reset };
}
