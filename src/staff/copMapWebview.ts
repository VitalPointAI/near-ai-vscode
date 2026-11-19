// What a webview needs to embed the COP map (media/staff/copMap.js; WP-COP): its content security policy, the vendored files it loads, and the picture
// built from the project. The Staff Room uses these three and the page's nearCopMap.mount; nothing else. Node I/O only, no vscode import: the caller
// passes the webview's cspSource and a function that turns a media path into a webview URI.
//
// CSP spike result (2026-11-18; SECURITY.md "COP map"). MapLibre GL JS 6.16.0 runs under the Staff Room policy of the UX concept (12.3) with no
// 'unsafe-eval' and no new script source: the page's nonced script imports the vendored module (the nonce carries to the import), fetches the vendored
// worker from the extension (connect-src) and starts it from a blob URL (worker-src blob:), because a webview cannot start a worker from the resource
// origin. MapLibre's only eval is in importScriptInWorkers, for plugins this page never loads. Checked in headless Chromium with SwiftShader, page and
// resources on two loopback origins, CSP as below: no violation, globe and Mercator both render, and the only requests were the vendored files and the
// worker blob. Track budget: 2,000 moving symbols at 10 updates a second held 60 frames a second with no long task; 5,000 doubled the slowest frames.
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { buildCopPicture, layerPath, PRODUCT_LAYERS, readLayerBody, syntheticGeography, layerAccess } from '../domain/staff/cop';
import type { CopPicture, PictureFeeds } from '../domain/staff/cop';
import { splitProductFile } from '../domain/staff/products';
import { parseScenarioText, SCENARIO_DIR } from '../domain/staff/scenario';
import type { Scenario } from '../domain/staff/scenario';
import type { StaffSectionId } from '../domain/staff/doctrine';
import { scenarioEnvironment } from './envPack';

/** The vendored files the page loads, relative to the extension's media folder. */
export const COP_MAP_FILES = {
  /** The SVG maps' shared label placement (window.nearDeclutter): loaded before the map script and the Staff Room's map. */
  declutter: 'staff/declutter.js',
  /** The layer drawer both maps share (window.nearLayerDrawer): loaded before the map script and the Staff Room's map. */
  drawer: 'staff/layerDrawer.js',
  script: 'staff/copMap.js',
  style: 'staff/copMap.css',
  maplibre: 'vendor/maplibre-gl/maplibre-gl.mjs',
  worker: 'vendor/maplibre-gl/maplibre-gl-worker.mjs',
  maplibreStyle: 'vendor/maplibre-gl/maplibre-gl.css',
  milsymbol: 'vendor/milsymbol/milsymbol.js'
} as const;

export type CopMapResources = { readonly [K in keyof typeof COP_MAP_FILES]: string };

/** The webview URIs of the map's files; `uri` turns a path under media/ into a webview URI (webview.asWebviewUri(...).toString()). */
export function copMapResources(uri: (mediaPath: string) => string): CopMapResources {
  const out = {} as Record<keyof typeof COP_MAP_FILES, string>;
  for (const key of Object.keys(COP_MAP_FILES) as (keyof typeof COP_MAP_FILES)[]) out[key] = uri(COP_MAP_FILES[key]);
  return out;
}

/**
 * The content security policy of a page with the map (UX concept 12.3). No 'unsafe-eval', no 'unsafe-inline', no remote source: scripts only by nonce,
 * the worker from a blob, fetches only from the extension. An organization tile server is never added here: tiles stay off until that is designed with
 * its label rule.
 */
export function copMapCsp(cspSource: string, nonce: string): string {
  if (!/^[A-Za-z0-9+/=]{8,}$/.test(nonce)) throw new Error('A nonce is at least 8 base64 characters.');
  return [
    "default-src 'none'", `script-src 'nonce-${nonce}'`, `style-src ${cspSource}`, `img-src ${cspSource} data: blob:`, `font-src ${cspSource}`,
    'worker-src blob:', `connect-src ${cspSource}`
  ].join('; ');
}

async function readOptional(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** The project's loaded scenario (its id and region, for the map's tiles), or undefined when there is none or it does not parse. */
export async function loadScenarioOf(root: string): Promise<Pick<Scenario, 'id' | 'region'> | undefined> {
  const text = await readOptional(path.join(root, SCENARIO_DIR, 'scenario.json'));
  const parsed = text === undefined ? undefined : parseScenarioText(text);
  return parsed?.ok ? parsed.value : undefined;
}

/**
 * The picture for a project: the loaded scenario (its frame, synthetic geography and reference layer), every product layer's features with its writer,
 * and the feed observations when a store gives them. `section` and `roster` resolve each layer's writer for the team whose Staff Room this is.
 */
export async function loadCopPicture(root: string, options: { readonly section: StaffSectionId; readonly roster: readonly string[]; readonly feeds?: PictureFeeds; readonly envDir?: string } = { section: 'j3', roster: [] }): Promise<CopPicture> {
  const text = await readOptional(path.join(root, SCENARIO_DIR, 'scenario.json'));
  const parsed = text === undefined ? undefined : parseScenarioText(text);
  const scenario = parsed?.ok ? parsed.value : undefined;
  const frame = scenario?.region.frame;
  const layers = [];
  for (const layer of PRODUCT_LAYERS) {
    const body = await readOptional(path.join(root, layerPath(layer)));
    const access = layerAccess(layer, { section: options.section, roster: options.roster });
    if (access.kind !== 'product') continue;
    const read = body === undefined ? { features: [], problems: [] } : readLayerBody(layer, splitProductFile(body)?.body ?? body, frame);
    layers.push({ layer, features: read.features, problems: read.problems, writer: access.writer });
  }
  // The scenario's environment pack (WP-ENV), when it has one: its DEM's contours replace the hand-drawn contour rings of the synthetic geography.
  const env = scenario ? await scenarioEnvironment(scenario, options.envDir) : undefined;
  const drawn = scenario ? syntheticGeography(scenario) : undefined;
  const geography = drawn && env?.environment ? { ...drawn, features: drawn.features.filter((feature) => feature.properties.kind !== 'contour') } : drawn;
  return buildCopPicture({
    ...(env?.environment ? { environment: env.environment } : {}), ...(env?.problem ? { environmentProblem: env.problem } : {}),
    marking: scenario?.marking ?? 'UNCLASSIFIED // EXERCISE', ...(frame ? { frame } : {}), ...(geography ? { geography } : {}), layers,
    ...(options.feeds ? { feeds: options.feeds } : {}), ...(scenario ? { scenario } : {})
  });
}
