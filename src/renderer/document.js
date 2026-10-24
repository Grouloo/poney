// Formatted view of Markdown documents in the file viewer (same engine as the
// answers, raw HTML kept). The HTML is sanitized by the caller (DOMPurify, which
// needs a DOM).
import { renderMarkdown } from './markdown.js';

export const documentHtml = (src) => renderMarkdown(src, { forAnswer: false });
