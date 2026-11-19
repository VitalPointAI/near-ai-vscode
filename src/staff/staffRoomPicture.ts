// The COP picture the Staff Room sends beside its model (WP-ROOM, WP-COP): the loaded scenario, every product layer and, when the observation store
// is set up and the person's clearance can be asked, the feed observations that clearance covers. Node I/O only, no vscode import.
//
// Clearance. The rows come from the store's own reader view (ObservationStore.view), which drops every row the reader's clearance does not cover before
// anything is computed, the same way the observation tools do. The picture's `visible` check is the same reader asked of a label (picture.ts asks it of
// each row and of every observation a track is built from), so a higher-labelled update never moves a track the person sees. With no reader, no row is
// read at all: nothing labelled is shown, and the feed layers say there is no store.
import type { CopPicture, PictureFeeds } from '../domain/staff/cop';
import { layersFor } from '../domain/staff/obs/layers';
import type { Observation } from '../domain/staff/obs/observation';
import { loadCopPicture } from './copMapWebview';
import type { ObservationStore, ObsReader } from './observationStore';

export interface StaffRoomPicture {
  /** The picture, or undefined when it could not be built (then `problem` says why). */
  readonly picture?: CopPicture;
  readonly problem?: string;
  /** The time on the store's clock (a simulation's exercise clock while one runs), which the map's time slider follows. */
  readonly now: number;
}

/** A label as the picture names it (`scale/level`), asked of the reader with no compartment, releasability or handling, as the observation tools do. */
export function labelVisible(reader: ObsReader): (label: string) => boolean {
  return (label) => {
    const at = label.indexOf('/');
    if (at <= 0) return false;
    try { return reader({ scale: label.slice(0, at), level: label.slice(at + 1), compartments: [], releasability: [], handling: [] }); } catch { return false; }
  };
}

/** The feeds of the picture for one reader: the store's rows its clearance covers, with the store's decay and the feed layers of each row's feed. */
export async function pictureFeeds(store: ObservationStore, reader: ObsReader): Promise<PictureFeeds | undefined> {
  const read = await store.view(reader);
  if (!read.ok) return undefined;
  const { rows, registry, lookup } = read.value;
  const layersOf = (row: Observation): readonly string[] => {
    const entry = registry.feeds[row.feed];
    return entry ? layersFor(entry.descriptor.category, entry.descriptor.format) : [];
  };
  return { rows, visible: labelVisible(reader), now: store.time(), decay: (row) => lookup.decayOf(row.feed), layersOf };
}

/** The Staff Room's picture: never throws; a picture that cannot be built comes back as a problem in words, and the room keeps its SVG map. */
export async function staffRoomPicture(root: string, options: { readonly store?: ObservationStore; readonly reader?: ObsReader; readonly now?: () => number } = {}): Promise<StaffRoomPicture> {
  const now = options.store ? options.store.time() : (options.now ?? Date.now)();
  let feeds: PictureFeeds | undefined;
  try {
    if (options.store && options.reader) feeds = await pictureFeeds(options.store, options.reader);
  } catch { feeds = undefined; }
  try {
    const picture = await loadCopPicture(root, { section: 'j3', roster: [], ...(feeds ? { feeds } : {}) });
    return { picture, now };
  } catch (error) {
    return { problem: `the COP picture could not be read (${error instanceof Error ? error.message : String(error)})`, now };
  }
}
