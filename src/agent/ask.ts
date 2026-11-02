// The questionnaire (<ask>): the model asks the user a few questions, each with
// proposed answers (one or several to pick) and room for their own words. Asking
// puts the conversation on hold like a command waiting for approval (the same
// path in main.ts); the answers come back as the tool's result.
//
//   <ask>
//   ? Which database should I use?
//   - PostgreSQL
//   - SQLite
//   ? Which features do you want? @multiple
//   - login
//   - export
//   </ask>

import { list, rec } from '../unknown.ts';
import type { Question, QuestionAnswer } from '../types.ts';

export const MAX_QUESTIONS = 6;
const MAX_OPTIONS = 8;

const clean = (s: unknown, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
// "@multiple", "(several)", "[multiple choice]": more than one answer can be picked.
const MULTIPLE = /\s*(@(multiple|multi|several|many)\b|[([](multiple( choice)?|several|choose several|pick several)[)\]])\s*/i;
const OPTION = /^\s*(?:[-*•+]|\[\s?\]|[a-h][).]|\d+[).])\s+(.+)$/i;
const QUESTION = /^\s*(?:\?|q\d*\s*[:.)]|question\s*\d*\s*[:.)]|#+)\s*(.+)$/i;

/** The questions of an <ask> body (tolerant: numbered, "Q:", or a plain line ending with "?"). */
export function parseQuestions(body: unknown): Question[] {
  const out: Question[] = [];
  for (const raw of String(body ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const q = line.match(QUESTION);
    const o = q ? null : line.match(OPTION);
    // (a list line that asks something is a question: "1. Which database?")
    const asks = o && /\?$/.test(o[1].replace(MULTIPLE, ' ').trim());
    if (o && !asks) {
      const last = out[out.length - 1];
      if (last && last.options.length < MAX_OPTIONS) last.options.push(clean(o[1], 200));
      continue;
    }
    const text = q ? q[1] : o ? o[1] : line.endsWith('?') || MULTIPLE.test(line) ? line : '';
    if (!text) continue;
    out.push({ question: clean(text.replace(MULTIPLE, ' ')), options: [], multiple: MULTIPLE.test(text) });
  }
  return out.filter((q) => q.question).slice(0, MAX_QUESTIONS);
}

/** The answers as sent by the window, narrowed: one per question, the choices among its options. */
export function cleanAnswers(questions: Question[], answers: unknown): QuestionAnswer[] {
  const given = list(answers);
  return questions.map((q, i) => {
    const a = rec(given[i]);
    const choices = list(a.choices).map((c) => clean(c, 200)).filter((c) => q.options.includes(c));
    return { choices: q.multiple ? [...new Set(choices)] : choices.slice(0, 1), other: String(a.other ?? '').trim().slice(0, 2000) };
  });
}

/** Each question with its answer, as shown on the card and given to the model. */
export function answersText(questions: Question[], answers: QuestionAnswer[]): string {
  return questions.map((q, i) => {
    const a = answers[i] ?? { choices: [], other: '' };
    const parts = [a.choices.join(', '), a.other ? `"${a.other}"` : ''].filter(Boolean);
    return `${i + 1}. ${q.question}\n→ ${parts.join('; ') || '(no answer)'}`;
  }).join('\n');
}

/** The tool's result for the model: the answers, or the questionnaire closed unanswered. */
export function askResult(questions: Question[], answers: QuestionAnswer[] | null): string {
  if (!answers) return 'The user closed the questionnaire without answering. Go on with sensible choices and say which ones you made, or ask in your answer.';
  return `The user answered (their own words in quotes):\n${answersText(questions, answers)}\nGo on with these answers.`;
}

export const ASK_FORMAT = 'Write each question on a line starting with "?" (add @multiple when several answers can be picked), and its proposed answers below it, one per line starting with "-".';
