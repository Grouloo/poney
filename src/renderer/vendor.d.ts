// The libraries the window loads by path (it has no bundler): their types are those of the packages.
declare module '*/katex/dist/katex.mjs' {
  export { default } from 'katex';
}
declare module '*/marked/lib/marked.esm.js' {
  export { Marked } from 'marked';
}
declare module '*/dompurify/dist/purify.es.mjs' {
  const DOMPurify: {
    sanitize: (html: string) => string;
  };
  export default DOMPurify;
}
declare module '*/@highlightjs/cdn-assets/es/highlight.min.js' {
  const hljs: {
    getLanguage: (name: string) => unknown;
    highlight: (code: string, options: { language: string; ignoreIllegals?: boolean }) => { value: string };
    highlightAuto: (code: string) => { value: string };
  };
  export default hljs;
}
