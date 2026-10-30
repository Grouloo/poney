// The icons of the file tree: line icons (16×16, stroked), one per broad kind of
// file, in that kind's color.

const SHEET = '<path d="M4 1.8h5.2L12.5 5v9.2H4z"/><path d="M9 1.9V5.2h3.4"/>';

const KINDS = {
  code: ['#7fb2ff', '<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>'],
  web: ['#f78c6c', '<circle cx="8" cy="8" r="6"/><ellipse cx="8" cy="8" rx="2.6" ry="6"/><path d="M2.3 6h11.4M2.3 10h11.4"/>'],
  style: ['#c792ea', '<path d="M8 1.8s4.6 4.9 4.6 8a4.6 4.6 0 0 1-9.2 0c0-3.1 4.6-8 4.6-8z"/>'],
  data: ['#e6b450', '<path d="M6 2.5c-2 0-2 1.3-2 2.7 0 1.5-.3 2.3-1.5 2.8C3.7 8.5 4 9.3 4 10.8c0 1.4 0 2.7 2 2.7M10 2.5c2 0 2 1.3 2 2.7 0 1.5.3 2.3 1.5 2.8-1.2.5-1.5 1.3-1.5 2.8 0 1.4 0 2.7-2 2.7"/>'],
  text: ['#a3a2ad', `${SHEET}<path d="M6 8h4.5M6 10.5h4.5"/>`],
  doc: ['#89ddff', '<path d="M3 2.5h7.5A1.5 1.5 0 0 1 12 4v9.5H4.5A1.5 1.5 0 0 1 3 12z"/><path d="M3 12a1.5 1.5 0 0 1 1.5-1.5H12"/>'],
  pdf: ['#f0616d', `${SHEET}<path d="M6 8.5h4.5M6 11h2.5"/>`],
  sheet: ['#4cc38a', '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M2.5 6.2h11M2.5 9.8h11M6.2 6.2v7.3"/>'],
  image: ['#4cc38a', '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.5" cy="6.3" r="1.1"/><path d="m2.5 11.5 3.2-3 2.3 2 2.2-2.5 3.3 3.5"/>'],
  audio: ['#c792ea', '<path d="M6 12V3.5l7-1.5V10"/><circle cx="4.5" cy="12" r="1.5"/><circle cx="11.5" cy="10" r="1.5"/>'],
  video: ['#f78c6c', '<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="m6.7 6 3.3 2-3.3 2z"/>'],
  archive: ['#e6b450', '<rect x="2" y="2.8" width="12" height="3.2" rx="1"/><path d="M3 6v6.2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6M6.5 8.5h3"/>'],
  shell: ['#4cc38a', '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><path d="m4.6 6.4 2 1.7-2 1.7M8.4 10.2h3"/>'],
  database: ['#7fb2ff', '<ellipse cx="8" cy="3.8" rx="5" ry="1.8"/><path d="M3 3.8v8.4c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V3.8M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8"/>'],
  config: ['#a3a2ad', '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4"/>'],
  lock: ['#a3a2ad', '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/>'],
  font: ['#a3a2ad', '<path d="m3 13 4.2-10h1.6L13 13M4.7 9.5h6.6"/>'],
  binary: ['#a3a2ad', `${SHEET}<path d="M6.5 8v3.5M9.5 8c-.8 0-1 .8-1 1.7s.2 1.8 1 1.8 1-.9 1-1.8S10.3 8 9.5 8z"/>`],
  file: ['#a3a2ad', SHEET],
};

const EXTENSIONS = {
  code: 'js mjs cjs jsx ts tsx py rb rs go java kt kts swift c h cc cpp hpp cs php lua dart scala ex exs erl hs clj ml r jl pl vue svelte zig nim',
  web: 'html htm xhtml',
  style: 'css scss sass less styl',
  data: 'json jsonc json5 yaml yml toml xml ndjson jsonl',
  text: 'txt log rtf',
  doc: 'md markdown mdx rst adoc org doc docx odt',
  pdf: 'pdf',
  sheet: 'csv tsv xls xlsx ods',
  image: 'png jpg jpeg gif svg webp bmp ico avif heic tiff',
  audio: 'mp3 wav flac ogg m4a aac opus',
  video: 'mp4 mov webm mkv avi m4v',
  archive: 'zip tar gz tgz bz2 xz 7z rar',
  shell: 'sh bash zsh fish ps1 bat cmd',
  database: 'sql db sqlite sqlite3',
  config: 'ini cfg conf env editorconfig',
  lock: 'lock pem key crt',
  font: 'ttf otf woff woff2',
  binary: 'exe dll so dylib bin wasm o a class pyc',
};
const BY_EXTENSION = new Map(Object.entries(EXTENSIONS).flatMap(([kind, list]) => list.split(' ').map((ext) => [ext, kind])));

// Names that say more than their extension (or have none).
const BY_NAME = [
  [/^(readme|changelog|contributing|license|licence|notice|authors|copying)\b/i, 'doc'],
  [/^(package-lock\.json|.*\.lock|.*-lock\.ya?ml|.*\.lockb)$/i, 'lock'],
  [/^(dockerfile|makefile|rakefile|gemfile|procfile|justfile)$/i, 'config'],
  [/^\.(env|git|npm|eslint|prettier|docker|editor|nvm|tool|babel)/i, 'config'],
];

const svg = (color, paths) => `<svg class="file-icon" viewBox="0 0 16 16" style="color:${color}" aria-hidden="true">${paths}</svg>`;

/** The kind of a file, from its name. */
export function fileKind(name) {
  const named = BY_NAME.find(([re]) => re.test(name));
  if (named) return named[1];
  const dot = name.lastIndexOf('.');
  return (dot >= 0 && BY_EXTENSION.get(name.slice(dot + 1).toLowerCase())) || 'file';
}

/** The icon of a file, as SVG. */
export function fileIconSvg(name) {
  const [color, paths] = KINDS[fileKind(name)];
  return svg(color, paths);
}

/** The icon of a folder, open or closed, as SVG. */
export function folderIconSvg(open) {
  return svg('#e6b450', open
    ? '<path d="M2 12.5V4a1 1 0 0 1 1-1h3l1.5 1.5H12a1 1 0 0 1 1 1V7"/><path d="M2 12.5 4 7h10.5l-2 5.5z"/>'
    : '<path d="M2 4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>');
}
