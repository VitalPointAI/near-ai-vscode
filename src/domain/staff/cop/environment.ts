// The environment layers of the COP picture (research note 11, 6.1 and 6.4; WP-ENV): hillshade and contours from a pack's DEM, the coastline, and
// the weather frames, ready for the map to draw. Pure: no I/O, no clock, no vscode.
//
// These are views like the feed layers: nobody writes them, and the J2 geoint-analyst owns their settings (obs/layers.ts, the terrain and weather
// rows). The page toggles each one and picks the weather frame with the shared time slider; the pack's attribution is shown whenever one is on.
import { contourLevels, demContours, demGrid, hillshadeFeatures } from '../env/terrain';
import type { ContourFeature, HillshadeFeature, Position } from '../env/terrain';
import { weatherLayer } from '../env/weather';
import type { WeatherLayer } from '../env/weather';
import type { EnvPack } from '../env/pack';

/** The picture layer ids of the environment layers. They start `env-`, so they are never mistaken for a product or feed layer. */
export const ENV_LAYERS = { hillshade: 'env-hillshade', contours: 'env-contours', weather: 'env-weather' } as const;

/** Contour spacing on the map, in metres; every fifth line (every 100 m) is an index contour, labelled with its height. */
export const CONTOUR_INTERVAL_M = 20;

export interface CoastFeature {
  readonly type: 'Feature';
  readonly geometry: { readonly type: 'LineString'; readonly coordinates: readonly Position[] };
  readonly properties: { readonly kind: 'coastline'; readonly height: 0; readonly index: true };
}

export interface PictureEnvironment {
  readonly pack: { readonly id: string; readonly title: string; readonly data: 'synthetic' | 'real'; readonly attribution: readonly string[]; readonly licence: string };
  readonly hillshade: { readonly type: 'FeatureCollection'; readonly features: readonly HillshadeFeature[] };
  /** Contour lines and the coastline (height 0). */
  readonly contours: { readonly type: 'FeatureCollection'; readonly features: ReadonlyArray<ContourFeature | CoastFeature> };
  readonly weather?: WeatherLayer;
  /** The contour levels drawn, for the layer's note. */
  readonly levels: readonly number[];
}

/** The environment layers of a validated pack. */
export function pictureEnvironment(pack: EnvPack): PictureEnvironment {
  const coast: CoastFeature[] = pack.coastline.features.flatMap((feature) => {
    const lines = feature.geometry.type === 'Polygon' ? feature.geometry.coordinates : [feature.geometry.coordinates];
    return lines.map((line): CoastFeature => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: { kind: 'coastline', height: 0, index: true } }));
  });
  return {
    pack: { id: pack.manifest.id, title: pack.manifest.title, data: pack.manifest.data, attribution: pack.manifest.attribution, licence: pack.manifest.licence },
    hillshade: { type: 'FeatureCollection', features: hillshadeFeatures(pack.dem) },
    contours: { type: 'FeatureCollection', features: [...coast, ...demContours(pack.dem, CONTOUR_INTERVAL_M)] },
    ...(pack.weather ? { weather: weatherLayer(pack.weather) } : {}),
    levels: contourLevels(demGrid(pack.dem), CONTOUR_INTERVAL_M)
  };
}
