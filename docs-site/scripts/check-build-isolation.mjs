#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2); const markersPath = args[args.indexOf('--markers') + 1]; const directories = args.flatMap((item, index) => item === '--dir' ? [args[index + 1]] : []).filter(Boolean);
if (!markersPath || directories.length === 0) { console.error('Usage: check-build-isolation.mjs --markers <file> --dir <folder> [...]'); process.exit(2); }
const markers = readFileSync(markersPath, 'utf8').split(/\r?\n/).filter(Boolean); const found = [];
function scan(dir) { for (const name of readdirSync(dir)) { const path = join(dir, name); const stat = statSync(path); if (stat.isDirectory()) scan(path); else if (stat.isFile()) { const text = readFileSync(path, 'utf8'); for (const marker of markers) if (text.includes(marker)) found.push(`${path}: ${marker}`); } } }
for (const dir of directories) if (existsSync(dir)) scan(dir);
if (found.length) { console.error(`Private overlay marker found:\n${found.join('\n')}`); process.exit(1); }
console.log('Build isolation check passed: no private overlay markers found.');
