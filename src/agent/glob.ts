// Glob patterns for the Glob and Grep tools: `*`, `**`, `?`, `[...]`, and `{a,b}`.

export function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        const slashAfter = pattern[index + 2] === '/';
        source += slashAfter ? '(?:.*/)?' : '.*';
        index += slashAfter ? 2 : 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      const close = pattern.indexOf(']', index + 1);
      if (close === -1) { source += '\\['; continue; }
      const body = pattern.slice(index + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\');
      source += `[${body}]`;
      index = close;
    } else if (char === '{') {
      const close = pattern.indexOf('}', index + 1);
      if (close === -1) { source += '\\{'; continue; }
      source += `(?:${pattern.slice(index + 1, close).split(',').map((part) => globToRegExp(part).source.slice(1, -1)).join('|')})`;
      index = close;
    } else {
      source += /[.+^$()|\\]/.test(char) ? `\\${char}` : char;
    }
  }
  return new RegExp(`^${source}$`);
}

/** Matches against the full relative path, or just the file name when the pattern has no slash. */
export function matchesGlob(pattern: string, relativePath: string): boolean {
  const regex = globToRegExp(pattern);
  return regex.test(relativePath) || (!pattern.includes('/') && regex.test(relativePath.split('/').pop() ?? ''));
}
