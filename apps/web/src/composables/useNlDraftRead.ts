import { computed, nextTick, onUnmounted, ref, watch, type Ref } from 'vue';
import { useQueryClient, type QueryKey } from '@tanstack/vue-query';
import { ActionStore, ApiError } from '../api';
import { errorMessage } from '../i18n/problem';
import { captureOwnerBinding, isOwnerBindingCurrent, ownerState, type OwnerBinding } from '../session/ownerEpoch';
import { runOwnerBound } from '../session/ownerBound';
import { useLlmConsentStore } from '../stores/llmConsent';
import { useOfflineStore } from '../stores/offline';

/**
 * "말로 적기", shared by 약속 (CAL-02, CommitmentParseSection) and the inbox
 * (CAL-05, TaskParseSection): the person writes in their own words, the AI
 * reads it into drafts (nothing saved), and each draft is added with the
 * ordinary create call.
 *
 * This composable is the state machine both screens share; each screen keeps
 * its own template, row fields and wording:
 *
 * - Consent: the wizard's rule (`askBeforeAi`, FU-91); with AI off the note
 *   stays and a failure line says so. No request is sent.
 * - Waiting: an elapsed-seconds ticker; 취소 aborts the fetch (the server
 *   cancels the model call) and keeps the note.
 * - Failures: budget / unavailable / other, one line each; the note stays.
 *   An answered error settles the read's idempotency key; a network drop
 *   keeps it, so a retry replays the stored answer.
 * - Adding: one idempotency key per draft, rows turn `added`, the given
 *   queries refresh; the note clears once every row is in.
 * - Owner isolation (ADR-023): every request runs in an owner-bound task;
 *   drafts are added only for the owner who read them; another owner signing
 *   in clears everything.
 *
 * HOLO-04: the capture bar (composables/useCapture.ts) is the third user. It
 * reads one line with whichever of the two readers the line looks like, and
 * `seed` lets it put in a draft it made itself.
 */

export type NlRowState = 'idle' | 'adding' | 'added';

export interface NlDraftRow<TDraft> {
  readonly key: string;
  draft: TDraft;
  state: NlRowState;
  error: string | null;
}

export type NlReadFailure = 'empty' | 'consent' | 'unavailable' | 'budget' | 'error';

/** The screen's own wording for every line the shared flow writes. */
export interface NlReadMessages {
  readonly empty: () => string;
  readonly consentOff: () => string;
  readonly resultNone: () => string;
  readonly resultCount: (count: number) => string;
  readonly cancelled: () => string;
  readonly budget: () => string;
  readonly unavailable: () => string;
  readonly readError: () => string;
  readonly addedOne: (title: string) => string;
  readonly addedMany: (count: number) => string;
  readonly addError: (title: string) => string;
  readonly removed: (title: string) => string;
}

export interface NlDraftReadOptions<TDraft, TRow extends NlDraftRow<TDraft>, TInput> {
  /** ActionStore scope of the read (`commitment:parse`). */
  readonly parseScope: string;
  /** ActionStore scope prefix of one draft's create (`commitment:draft`). */
  readonly draftScope: string;
  readonly parse: (
    text: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ) => Promise<{ readonly drafts: readonly TDraft[]; readonly leftover: string }>;
  readonly toRow: (draft: TDraft, key: string) => TRow;
  /** The create body of a row, or null while it cannot be added yet. */
  readonly createInput: (row: TRow) => TInput | null;
  readonly create: (input: TInput, idempotencyKey: string) => Promise<unknown>;
  /** The title the messages name for a row / a create body. */
  readonly rowTitle: (row: TRow) => string;
  readonly inputTitle: (input: TInput) => string;
  /** Query keys refreshed after drafts were added. */
  readonly refresh: readonly QueryKey[];
  readonly messages: NlReadMessages;
}

export function useNlDraftRead<TDraft, TRow extends NlDraftRow<TDraft>, TInput>(
  options: NlDraftReadOptions<TDraft, TRow, TInput>,
) {
  const llmConsent = useLlmConsentStore();
  const offline = useOfflineStore();
  const queryClient = useQueryClient();
  const actions = new ActionStore();
  const text = options.messages;

  const note = ref('');
  const reading = ref(false);
  const adding = ref(false);
  const elapsedSeconds = ref(0);
  const failure = ref<NlReadFailure | null>(null);
  const failureText = ref('');
  const status = ref('');
  const rows = ref([]) as Ref<TRow[]>;
  const leftover = ref('');
  const hasResult = ref(false);
  /** The last read found nothing (as opposed to rows the person added, edited or removed). */
  const readEmpty = ref(false);
  const resultHeading = ref<HTMLElement | null>(null);
  const noteField = ref<HTMLTextAreaElement | HTMLInputElement | null>(null);

  let readCount = 0;
  /** The owner the shown drafts were read for: adding them runs under this binding only. */
  let rowsBinding: OwnerBinding | null = null;
  let controller: AbortController | null = null;
  let cancelRequested = false;
  let ticker: ReturnType<typeof setInterval> | undefined;

  const canAct = computed(() => offline.mutationsEnabled);

  function isReady(row: TRow): boolean {
    return row.state === 'idle' && options.createInput(row) !== null;
  }

  const readyRows = computed(() => rows.value.filter((row) => isReady(row)));
  const showResult = computed(
    () => hasResult.value && (rows.value.length > 0 || leftover.value.length > 0 || readEmpty.value),
  );

  function stopTicker(): void {
    if (ticker !== undefined) clearInterval(ticker);
    ticker = undefined;
  }

  onUnmounted(() => {
    stopTicker();
    controller?.abort();
  });

  // ADR-023: another owner signed in — nothing of this note or its drafts survives.
  watch(
    () => [ownerState.ownerId.value, ownerState.epoch.value],
    () => {
      controller?.abort();
      controller = null;
      stopTicker();
      rowsBinding = null;
      note.value = '';
      rows.value = [];
      leftover.value = '';
      hasResult.value = false;
      readEmpty.value = false;
      failure.value = null;
      status.value = '';
      reading.value = false;
      adding.value = false;
    },
  );

  function failWith(kind: NlReadFailure, message: string): void {
    failure.value = kind;
    failureText.value = message;
  }

  async function read(): Promise<void> {
    if (reading.value || !canAct.value) return;
    const value = note.value.trim();
    if (value.length === 0) {
      failWith('empty', text.empty());
      return;
    }
    failure.value = null;
    // The wizard's consent rule (FU-91): an undecided owner is asked first.
    const asked = captureOwnerBinding();
    await llmConsent.askBeforeAi();
    if (!isOwnerBindingCurrent(asked)) return;
    if (llmConsent.needed) {
      failWith('consent', text.consentOff());
      return;
    }

    const action = actions.begin(options.parseScope, value, (left, right) => left === right);
    const request = new AbortController();
    controller = request;
    cancelRequested = false;
    reading.value = true;
    status.value = '';
    elapsedSeconds.value = 0;
    stopTicker();
    ticker = setInterval(() => {
      elapsedSeconds.value += 1;
    }, 1_000);

    await runOwnerBound(
      function* (owner) {
        try {
          const result = yield* owner.wait(options.parse(value, action.key, request.signal));
          actions.settle(options.parseScope, action);
          readCount += 1;
          rowsBinding = owner.binding;
          rows.value = result.drafts.map((draft, index) => options.toRow(draft, `${readCount}-${index}`));
          leftover.value = result.leftover;
          readEmpty.value = result.drafts.length === 0;
          hasResult.value = true;
          status.value = result.drafts.length === 0 ? text.resultNone() : text.resultCount(result.drafts.length);
          yield nextTick();
          resultHeading.value?.focus();
        } catch (cause) {
          if (cancelRequested) {
            // The request is gone and the server cancels the read; a new read gets a new key.
            actions.settle(options.parseScope, action);
            status.value = text.cancelled();
            return;
          }
          // The server answered: nothing is pending under this key. Otherwise keep the
          // key, so a retry after a network drop replays the stored answer.
          if (cause instanceof ApiError) actions.settle(options.parseScope, action);
          if (cause instanceof ApiError && cause.code === 'budget_exceeded') {
            failWith('budget', text.budget());
          } else if (cause instanceof ApiError && cause.code === 'llm_unavailable') {
            failWith('unavailable', text.unavailable());
          } else {
            failWith('error', text.readError());
          }
        }
      },
      {
        onSettled: () => {
          reading.value = false;
          controller = null;
          stopTicker();
        },
      },
    );
  }

  /**
   * Drafts the screen made itself, without a read (HOLO-04, the capture bar:
   * a line that needs no reading, or one the AI could not read, is its own
   * title). They take the place of whatever was read before and belong to the
   * owner signed in now; adding them is the same `addRows`.
   */
  function seed(drafts: readonly TDraft[]): void {
    if (reading.value || adding.value) return;
    readCount += 1;
    rowsBinding = captureOwnerBinding();
    rows.value = drafts.map((draft, index) => options.toRow(draft, `${readCount}-${index}`));
    leftover.value = '';
    readEmpty.value = false;
    hasResult.value = true;
    failure.value = null;
  }

  function cancel(): void {
    if (!reading.value || controller === null) return;
    cancelRequested = true;
    controller.abort();
    void nextTick(() => noteField.value?.focus());
  }

  function onNoteKeydown(event: KeyboardEvent): void {
    // Enter reads; Shift+Enter is a line break; Enter that ends a Hangul IME composition is not a submit.
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void read();
  }

  function everyRowResolved(): boolean {
    return rows.value.length > 0 && rows.value.every((row) => row.state === 'added');
  }

  async function addRows(targets: readonly TRow[]): Promise<void> {
    if (!canAct.value || adding.value) return;
    // Drafts belong to the owner who read them; after an owner change nothing is sent.
    const binding = rowsBinding;
    if (binding === null || !isOwnerBindingCurrent(binding)) return;
    const work = targets
      .map((row) => ({ row, input: options.createInput(row) }))
      .filter((entry): entry is { row: TRow; input: TInput } => entry.row.state === 'idle' && entry.input !== null);
    if (work.length === 0) return;
    adding.value = true;
    for (const { row } of work) {
      row.state = 'adding';
      row.error = null;
    }
    await runOwnerBound(
      function* (owner) {
        let added = 0;
        let lastTitle = '';
        for (const { row, input } of work) {
          // One key per draft: a retry of the same draft never creates it twice.
          const scope = `${options.draftScope}:${row.key}`;
          const action = actions.begin(scope, input, (left, right) => JSON.stringify(left) === JSON.stringify(right));
          try {
            yield* owner.wait(options.create(input, action.key));
            actions.settle(scope, action);
            row.state = 'added';
            added += 1;
            lastTitle = options.inputTitle(input);
          } catch (cause) {
            row.state = 'idle';
            row.error = errorMessage(cause, text.addError(options.inputTitle(input)));
          }
        }
        if (added === 0) return;
        status.value = added === 1 ? text.addedOne(lastTitle) : text.addedMany(added);
        if (everyRowResolved()) note.value = '';
        for (const queryKey of options.refresh) yield queryClient.invalidateQueries({ queryKey });
      },
      {
        binding,
        onSettled: () => {
          adding.value = false;
        },
      },
    );
  }

  function addAll(): Promise<void> {
    return addRows(readyRows.value);
  }

  function focusResult(): void {
    void nextTick(() => resultHeading.value?.focus());
  }

  /** Take a row out of the list (빼기 says so; 고치기 writes its own line). */
  function dropRow(row: TRow): void {
    rows.value = rows.value.filter((candidate) => candidate.key !== row.key);
  }

  function remove(row: TRow): void {
    dropRow(row);
    status.value = text.removed(options.rowTitle(row));
    focusResult();
  }

  return {
    note,
    reading,
    adding,
    elapsedSeconds,
    failure,
    failureText,
    status,
    rows,
    leftover,
    hasResult,
    readEmpty,
    resultHeading,
    noteField,
    canAct,
    readyRows,
    showResult,
    isReady,
    read,
    cancel,
    onNoteKeydown,
    addRows,
    addAll,
    dropRow,
    remove,
    seed,
  };
}
