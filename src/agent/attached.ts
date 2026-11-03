// Files attached to a message, and the conversation's private folder as the interface names it.
// The message keeps `.poney/…` paths (what the user sees, what Poney's models read); the
// harnesses of Claude and Antigravity read the absolute path, and show `.poney/…` again.
import path from 'node:path';

/** The line before the list of files attached, at the end of a message. */
export const ATTACHED = 'Fichiers joints :';

/** A file of the private folder named `.poney/…`, else null. */
export function soberPath(file: string, scratch: string | null): string | null {
  if (!scratch) return null;
  const rel = path.relative(scratch, file.replace(/^file:\/\//, ''));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel ? `.poney/${rel.split(path.sep).join('/')}` : '.poney';
}

/** The message as a harness that reads absolute paths gets it: the files attached under `.poney/` there. */
export function withAttachedPaths(text: string, scratch: string | null): string {
  const at = text.lastIndexOf(`${ATTACHED}\n`);
  if (!scratch || at < 0) return text;
  const list = text.slice(at).replace(/^- `\.poney\/([^`]+)`$/gm, (_all, rel: string) => `- \`${path.join(scratch, ...rel.split('/'))}\``);
  return text.slice(0, at) + list;
}

/** A message without the list of its files attached (only their names, when it has no text). */
export function withoutAttached(text: string): string {
  const m = /(?:^|\n\n)Fichiers joints :\n((?:- `[^`\n]+`(?:\n|$))+)\s*$/.exec(text);
  if (!m) return text;
  return text.slice(0, m.index).trim() || [...m[1].matchAll(/^- `([^`\n]+)`/gm)].map((x) => x[1].split('/').pop()).join(', ');
}
