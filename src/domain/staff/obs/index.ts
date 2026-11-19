// The drop 2 feed contract (research note 11, section 9.3; WP-OBS0): the observation row, feed and channel descriptors, tracks and decay, the exercise
// frame, slices, standing watches, COP feed layer ownership, the feed events and the agent tool signatures. Every feed package (store, importers,
// simulator, packs, watches, tools, the map) imports these and nothing else defines them. Pure: no I/O, no clock, no vscode.
export * from './events';
export * from './feeds';
export * from './frame';
export * from './layers';
export * from './observation';
export { OBS_FAILURES, obsRefused } from './read';
export type { ObsFailure, ObsParsed, ObsRefusal } from './read';
export * from './slices';
export * from './tools';
export * from './tracks';
export * from './watches';
