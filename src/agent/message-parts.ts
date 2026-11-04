// What is attached at the end of a user message: its skills, then its files. Without imports:
// the interface reads it too.

/** The line before the list of files attached, at the end of a message. */
export const ATTACHED = 'Fichiers joints :';
/** The line before the skills attached to a message (each as /name, which every harness reads). */
export const SKILLS = 'Skills :';
const FILES_AT_END = /(?:^|\n\n)Fichiers joints :\n((?:- `[^`\n]+`(?:\n|$))+)\s*$/;
const SKILLS_AT_END = /(?:^|\n\n)Skills : ((?:\/[a-z0-9][a-z0-9-]*(?: |$))+)\s*$/;

/** A message: its text, then the skills and the files attached at its end. */
export function splitMessage(text: string): { body: string; skills: string[]; files: string[] } {
  let body = text;
  let files: string[] = [];
  let skills: string[] = [];
  const f = FILES_AT_END.exec(body);
  if (f) [files, body] = [[...f[1].matchAll(/^- `([^`\n]+)`/gm)].map((x) => x[1]), body.slice(0, f.index)];
  const s = SKILLS_AT_END.exec(body);
  if (s) [skills, body] = [s[1].trim().split(/\s+/).map((x) => x.slice(1)), body.slice(0, s.index)];
  return { body, skills, files };
}

/** A message with its skills and files attached at its end. */
export function joinMessage(body: string, skills: string[], files: string[]): string {
  const parts = [body.trim()];
  if (skills.length) parts.push(`${SKILLS} ${skills.map((n) => `/${n}`).join(' ')}`);
  if (files.length) parts.push(`${ATTACHED}\n${files.map((f) => `- \`${f}\``).join('\n')}`);
  return parts.filter(Boolean).join('\n\n');
}

