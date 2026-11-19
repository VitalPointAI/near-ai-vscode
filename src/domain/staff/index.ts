// The staff contract (design 10, WP-0): the schema every staff work package imports. Pure: no I/O, no clock, no vscode.
// Doctrine terms live only in doctrine.ts, so a correction to a step name or an annex letter is a one-file change.
export * from './doctrine';
export * from './events';
export * from './intel';
export * from './ownership';
export * from './parse';
export * from './products';
export * from './profiles';
export * from './release';
export * from './teamBlock';
// WP-SHARED: the product ledger, registers, wargame ledger, guard-scan, tradecraft lint, read models and the release-guard member.
export * from './guardScan';
export * from './ledger';
export * from './readModels';
export * from './registers';
export * from './releaseGuard';
export * from './tradecraftLint';
export * from './wargame';
// WP-DEMO: the scenario reader, acceptance fixtures and demo scripts.
export * from './scenario';
export * from './acceptance';
export * from './demoScripts';
export * from './realEntities';
// WP-OBS0: the drop 2 feed contract (observations, feeds, tracks, the exercise frame, slices, watches, feed layers and events).
export * from './obs';
