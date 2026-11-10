import { PromptNotFoundError } from './errors.js';
import { PROMPTS } from './prompts.generated.js';

/**
 * Pure in-memory prompt registry. The map is generated at build time from
 * `packages/llm/prompts/<id>/<version>.md`; the core package never touches the filesystem.
 */
export function promptKey(promptId: string, version: string): string {
  return `${promptId}@${version}`;
}

export function hasPrompt(promptId: string, version: string): boolean {
  return Object.hasOwn(PROMPTS, promptKey(promptId, version));
}

export function getPrompt(promptId: string, version: string): string {
  const text = PROMPTS[promptKey(promptId, version)];
  if (text === undefined) throw new PromptNotFoundError(promptId, version);
  return text;
}

export function listPromptKeys(): readonly string[] {
  return Object.freeze(Object.keys(PROMPTS).sort());
}
