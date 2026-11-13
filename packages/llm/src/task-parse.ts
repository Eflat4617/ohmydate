/**
 * CAL-05: natural-language task entry in the inbox ("금요일까지 보고서 초안,
 * 내일까지 교수님께 메일").
 *
 * The same shape as commitment_parse (CAL-02): the model reads the person's
 * note into LOCAL deadline dates / times only; the API converts them to
 * instants in the owner's zone, validates them and returns task drafts. Nothing
 * is saved by the read: the person adds each draft through the ordinary task
 * create call (05 §1).
 *
 * The input is built by the shared `buildNoteReadInput` (masked + fenced note,
 * caller-computed `now` and `calendar`, resolved `outputLanguage`), so the API,
 * the contract smoke and the injection evaluation build exactly the same object.
 */

import {
  buildNoteReadInput,
  type CommitmentParseInputBundle,
  type CommitmentParseInputRequest,
} from './commitment-parse.js';

export const TASK_PARSE_PROMPT = { promptId: 'task_parse', version: 'v1' } as const;
export const TASK_PARSE_SCHEMA_ID = 'llm.task_parse.v1';
export const TASK_PARSE_CONFIG_VERSION = 'task-parse@1';
/** The fence id of the note block (one block per call). */
export const TASK_TEXT_BLOCK_ID = 'task-text';
/** Longest note the API accepts (characters, after trimming). */
export const MAX_TASK_TEXT_LENGTH = 500;
/** Most drafts one read may return (schema `maxItems`). */
export const MAX_TASK_DRAFTS = 10;

/** Same request as commitment_parse: text, local now, calendar, zone, output language. */
export type TaskParseInputRequest = CommitmentParseInputRequest;
export type TaskParseInputBundle = CommitmentParseInputBundle;

/** One item of `llm.task_parse.v1` (schema-validated before use). */
export interface TaskParseItem {
  /** The to-do in the person's words, without the deadline phrase. */
  readonly title: string;
  /** Local deadline date `YYYY-MM-DD`, or null for a task without a deadline. */
  readonly dueDate: string | null;
  /** Local deadline time `HH:mm`, or null (the API takes the end of the day). */
  readonly dueTime: string | null;
  /** No day was written (a time only) or only a vague one ("이번 주까지"). */
  readonly dateWasGuessed: boolean;
  /** The time was a bare hour from 7 to 11 read as AM (CAL-05 addendum). */
  readonly meridiemWasGuessed: boolean;
}

export interface TaskParseOutput {
  readonly items: readonly TaskParseItem[];
  readonly leftover: string;
}

/** The structured input of task_parse@v1. */
export function buildTaskParseInput(request: TaskParseInputRequest): TaskParseInputBundle {
  return buildNoteReadInput(TASK_PARSE_CONFIG_VERSION, TASK_TEXT_BLOCK_ID, request);
}
