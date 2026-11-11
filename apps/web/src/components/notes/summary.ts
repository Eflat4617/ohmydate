/**
 * Plain-text note summaries for list rows (no Markdown symbols, no
 * addresses). Kept apart from `markdown.ts` so lists elsewhere in the app do
 * not pull the Markdown parser into the main bundle.
 */

/** Plain-text summary for list rows (no Markdown symbols, no addresses). */
export function plainSummary(source: string, max = 120): string {
  const text = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>\n]*>/g, ' ')
    .replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/[*_~`|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

/** List-row summary: a first heading that only repeats the title is skipped. */
export function noteSummary(title: string, bodyMd: string, max = 120): string {
  const lines = bodyMd.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex((line) => line.trim().length > 0);
  if (first !== -1) {
    const heading = /^ {0,3}#{1,6}[ \t]+(.*?)[ \t#]*$/.exec(lines[first] ?? '');
    if (heading !== null && (heading[1] ?? '').trim() === title.trim()) lines.splice(first, 1);
  }
  return plainSummary(lines.join('\n'), max);
}
