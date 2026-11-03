// The icons of the right-click menus: line icons (16×16, stroked), in the text's color.

const PATHS = {
  open: '<path d="M7 3H3.5v9.5H13V9"/><path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5"/>',
  openWith: '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.2"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1.2"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1.2"/><rect x="9" y="9" width="4.5" height="4.5" rx="1.2"/>',
  rename: '<path d="M10.5 2.5l3 3L6 13H3v-3z"/><path d="M9 4l3 3"/>',
  reveal: '<path d="M1.5 4.2c0-.7.6-1.2 1.2-1.2h3.4l1.4 1.5h5.8c.7 0 1.2.5 1.2 1.2v6.6c0 .7-.5 1.2-1.2 1.2H2.7c-.6 0-1.2-.5-1.2-1.2z"/><path d="M6.5 9.5h4M9 7.5l2 2-2 2"/>',
  trash: '<path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.8 6.8v4.4M9.2 6.8v4.4"/>',
  close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  newConversation: '<path d="M2.5 3h11v7.5H6.5L3.5 13v-2.5h-1z"/><path d="M8 4.8v4M6 6.8h4"/>',
  markRead: '<circle cx="8" cy="8" r="6"/><path d="M5.4 8.2l1.8 1.8 3.4-3.7"/>',
  settings: '<path d="M2.5 5h6M11.5 5h2M2.5 11h2M7.5 11h6"/><circle cx="10" cy="5" r="1.5"/><circle cx="6" cy="11" r="1.5"/>',
  addProject: '<path d="M1.5 4.2c0-.7.6-1.2 1.2-1.2h3.4l1.4 1.5h5.8c.7 0 1.2.5 1.2 1.2v6.6c0 .7-.5 1.2-1.2 1.2H2.7c-.6 0-1.2-.5-1.2-1.2z"/><path d="M8 7v4M6 9h4"/>',
  cut: '<circle cx="4.5" cy="12" r="1.8"/><circle cx="11.5" cy="12" r="1.8"/><path d="M5.7 10.6 11 2.5M10.3 10.6 5 2.5"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5V3a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5"/>',
  paste: '<rect x="3.5" y="3" width="9" height="11" rx="1.5"/><path d="M6 3V2h4v1M6 7h4M6 9.5h4"/>',
  undo: '<path d="M5 6.5h5a3 3 0 0 1 0 6H7"/><path d="M7.5 4 5 6.5 7.5 9"/>',
  selectAll: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke-dasharray="2 2"/>',
  quote: '<path d="M3.5 11.5c0-3.5 1.2-5.3 3.5-6.5M9.5 11.5c0-3.5 1.2-5.3 3.5-6.5"/><circle cx="4.8" cy="11" r="1.3"/><circle cx="10.8" cy="11" r="1.3"/>',
  dictionary: '<path d="M3 2.5h8a1.5 1.5 0 0 1 1.5 1.5v9.5H4.5A1.5 1.5 0 0 1 3 12z"/><path d="M3 12a1.5 1.5 0 0 1 1.5-1.5h8"/><path d="M6 5h4"/>',
  left: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M8 3v10"/><path d="M2.8 4h4.4v8H2.8z" fill="currentColor" stroke="none" opacity="0.75"/>',
  right: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M8 3v10"/><path d="M8.8 4h4.4v8H8.8z" fill="currentColor" stroke="none" opacity="0.75"/>',
};
export type MenuGlyph = keyof typeof PATHS;

export function menuIconSvg(glyph: MenuGlyph): string {
  return `<svg class="ctx-svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[glyph]}</svg>`;
}
