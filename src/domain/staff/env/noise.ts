// Deterministic noise for the synthetic land cover and imagery: integer hashing (Math.imul, the same style as seededRandom in synthetic.ts), so the
// same seed gives the same values on every machine and in any order of evaluation. Pure: no I/O, no clock, no state.

/** A 32-bit hash of two integers and a seed, as a number in [0, 1). */
export function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** Smooth value noise in [-1, 1] on a unit lattice. */
export function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = fade(x - ix), fy = fade(y - iy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return (a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy) * 2 - 1;
}

/** Fractal value noise: `octaves` layers, each at twice the frequency and `gain` times the weight, normalised to about [-1, 1]. */
export function fbm(x: number, y: number, seed: number, octaves = 4, gain = 0.5): number {
  let sum = 0, weight = 1, total = 0, f = 1;
  for (let o = 0; o < octaves; o += 1) {
    sum += valueNoise(x * f, y * f, seed + o * 1013) * weight;
    total += weight;
    weight *= gain;
    f *= 2.03;
  }
  return sum / total;
}
