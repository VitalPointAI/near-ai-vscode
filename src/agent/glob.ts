// The glob matcher lives under src/domain so the pure gate folder can use it; this file keeps every existing import path working.
export { globToRegExp, matchesGlob } from '../domain/glob';
