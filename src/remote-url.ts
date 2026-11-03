// Addresses of remote repositories, for the main process and the window alike.

/** The folder a clone of this address goes to: the last part of its path, without .git. */
export function repoName(url: string): string {
  const pathPart = url.trim().replace(/[?#].*$/, '').replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, '').replace(/^[^/:]+@[^:]+:/, '');
  return pathPart.replace(/\/+$/, '').split(/[/:]/).pop()?.replace(/\.git$/i, '').replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '') ?? '';
}

/** A token's address: https, no trailing slash, the host in lower case; null if it is not one. */
export function tokenUrl(text: string): string | null {
  let u: URL;
  try {
    u = new URL(/^[a-z][\w+.-]*:\/\//i.test(text.trim()) ? text.trim() : `https://${text.trim()}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!u.hostname || u.username || u.password || u.search || u.hash) return null;
  return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
}

export const isGithub = (url: string) => /^https:\/\/github\.com(\/|$)/.test(url);
