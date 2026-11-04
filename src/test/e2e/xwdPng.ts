// Stub for the RED step of Phase 62 plan 16 task 1: every function returns an empty result, so the tests fail on their own assertions.
// The converter arrives in the GREEN commit.
export interface RgbImage { width: number; height: number; rgb: Buffer }
type Box = { x: number; y: number; width: number; height: number };
const empty = (): RgbImage => ({ width: 0, height: 0, rgb: Buffer.alloc(0) });
export function readXwd(_file: Buffer): RgbImage { return empty(); }
export function encodePng(_image: RgbImage): Buffer { return Buffer.alloc(0); }
export function cropImage(_image: RgbImage, _box: Box): RgbImage { return empty(); }
export function xwdToPng(_file: Buffer, _crop?: Box): Buffer { return Buffer.alloc(0); }
export async function captureScreen(_fbdir: string, _outFile: string, _crop?: Box): Promise<{ width: number; height: number; bytes: number }> { return { width: 0, height: 0, bytes: 0 }; }
