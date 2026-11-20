// The WebP encoder of the map tile builders (scripts/generate-env-pack.mjs --tiles and scripts/build-globe-tiles.mjs): @jsquash/webp, libwebp built
// to WebAssembly (Apache-2.0), a build-time devDependency only. Nothing here ships in the extension and nothing runs at run time.
//
// Node cannot fetch the encoder's .wasm by URL, so the module is compiled from the file on disk and handed to the encoder's init. The SIMD build is
// used when Node supports it (every supported Node does); encoded bytes may still differ between libwebp builds, which is why the tile indexes also
// record a digest of the pixels before encoding (src/domain/staff/env/tiles.ts).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/** Where a build-time package is, or a clear message: the encoders are devDependencies, installed by `npm install` (or found through NODE_PATH). */
export function resolveDev(specifier) {
  try { return require.resolve(specifier); } catch {
    throw new Error(`${specifier} is not installed. It is a build-time devDependency of the map tile builders: run npm install first.`);
  }
}

let encoder;

/** encode({ data: Uint8ClampedArray RGBA, width, height }, options) -> Uint8Array of WebP bytes. */
export async function webpEncoder() {
  if (encoder) return encoder;
  const entry = resolveDev('@jsquash/webp/encode.js');
  const mod = await import(pathToFileURL(entry).href);
  // The same feature check the encoder makes, so the .wasm compiled here is the build its init loads.
  const detect = await import(pathToFileURL(createRequire(entry).resolve('wasm-feature-detect')).href);
  const simd = detect.simd || detect.default.simd;
  const wasm = path.join(path.dirname(entry), 'codec', 'enc', (await simd()) ? 'webp_enc_simd.wasm' : 'webp_enc.wasm');
  await mod.init(await WebAssembly.compile(readFileSync(wasm)));
  encoder = async (image, options) => new Uint8Array(await mod.default(image, options));
  return encoder;
}
