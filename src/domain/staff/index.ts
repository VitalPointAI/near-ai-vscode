// The staff contract (design 10, WP-0): the schema every staff work package imports. Pure: no I/O, no clock, no vscode.
// Doctrine terms live only in doctrine.ts, so a correction to a step name or an annex letter is a one-file change.
export * from './doctrine';
export * from './events';
export * from './ownership';
export * from './parse';
export * from './products';
export * from './profiles';
export * from './release';
export * from './teamBlock';
