// The icons of the conversation's steps (reasoning, assessment, compaction, tool calls):
// line icons (16×16, stroked) in the color of the step's state. A file's step takes the
// icon of its kind, as in the files attached; the web and the sub-agents, those of the
// input's switches.
import { fileIconSvg, folderIconSvg } from './file-icons.ts';

const PATHS: Record<string, string> = {
  thinking: '<path d="M6.2 2.5a2.2 2.2 0 0 0-2.1 1.6A2.3 2.3 0 0 0 2.6 6.9a2.4 2.4 0 0 0 .9 3.6 2.3 2.3 0 0 0 2.7 2.8A1.9 1.9 0 0 0 8 13.5V3.8a1.8 1.8 0 0 0-1.8-1.3z"/><path d="M9.8 2.5a2.2 2.2 0 0 1 2.1 1.6 2.3 2.3 0 0 1 1.5 2.8 2.4 2.4 0 0 1-.9 3.6 2.3 2.3 0 0 1-2.7 2.8A1.9 1.9 0 0 1 8 13.5V3.8a1.8 1.8 0 0 1 1.8-1.3z"/><path d="M5.2 6.2c.8 0 1.5.5 1.7 1.2M10.8 6.2c-.8 0-1.5.5-1.7 1.2M5.4 10.2c.7-.2 1.3-.7 1.5-1.4M10.6 10.2c-.7-.2-1.3-.7-1.5-1.4"/>',
  triage: '<circle cx="8" cy="8" r="6"/><path d="m10.6 5.4-1.5 3.7-3.7 1.5 1.5-3.7z"/>',
  compaction: '<path d="M8 1.8v4.4M5.8 4 8 6.2 10.2 4M8 14.2V9.8M5.8 12 8 9.8l2.2 2.2M2.5 8h11"/>',
  search: '<circle cx="7" cy="7" r="4.3"/><path d="m10.2 10.2 3.6 3.6"/>',
  run: '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><path d="m4.6 6.4 2 1.7-2 1.7M8.4 10.2h3"/>',
  web: '<circle cx="8" cy="8" r="6"/><ellipse cx="8" cy="8" rx="2.6" ry="6"/><path d="M2.3 6h11.4M2.3 10h11.4"/>',
  agent: '<circle cx="8" cy="3.5" r="1.8"/><circle cx="3.5" cy="12.5" r="1.8"/><circle cx="12.5" cy="12.5" r="1.8"/><path d="M8 5.3v2.2M8 7.5 4.6 10.9M8 7.5l3.4 3.4"/>',
  plan: '<path d="M6.5 4h7M6.5 8h7M6.5 12h7"/><path d="m2.2 4 .9.9 1.6-1.7M2.2 8l.9.9 1.6-1.7"/><circle cx="3.2" cy="12" r=".9"/>',
  ask: '<path d="M2.5 3h11v7.5H6.5L3.5 13v-2.5h-1z"/><path d="M6.6 5.4a1.5 1.5 0 1 1 2 1.4c-.4.2-.6.5-.6.9v.2"/><path d="M8 9.4h.01"/>',
  memory: '<path d="M4 2.5h8v11l-4-2.8-4 2.8z"/>',
  image: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.5" cy="6.3" r="1.1"/><path d="m2.5 11.5 3.2-3 2.3 2 2.2-2.5 3.3 3.5"/>',
  tool: '<path d="M10.2 2.3a3.2 3.2 0 0 0-3.7 4.2L2.4 10.6a1.3 1.3 0 0 0 1.9 1.9l4.1-4.1a3.2 3.2 0 0 0 4.2-3.7l-2 2-1.7-.4-.4-1.7z"/>',
};

const svg = (paths: string) => `<svg viewBox="0 0 16 16" aria-hidden="true">${paths}</svg>`;

/** The icon of a step: a reasoning, an assessment, a compaction, or a tool (with its file, if any). */
export function stepIconSvg(kind: string, path = ''): string {
  const name = path.trim().split('/').filter(Boolean).pop() ?? '';
  switch (kind) {
    case 'read': case 'write': case 'edit': return name ? fileIconSvg(name) : fileIconSvg('fichier');
    case 'list': return folderIconSvg(false);
    case 'web_search': case 'fetch': return svg(PATHS.web);
    case 'remember': case 'forget': case 'recall': return svg(PATHS.memory);
    default: return svg(PATHS[kind] ?? PATHS.tool);
  }
}
