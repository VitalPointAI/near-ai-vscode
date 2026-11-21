import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateOurs } from '../src/validate.ts';
const levelsFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'levels.json');
test('levels document validates and names the planned profiles', () => { const levels = JSON.parse(readFileSync(levelsFile, 'utf8')); assert.equal(validateOurs(levels, 'levels').ok, true); assert.equal(levels.levels.find((level: any) => level.id === 'protected-b').profile, 'profiles/itsp-10-033-01-medium.json'); });
test('classified is explicitly appliance-only and makes no claim', () => { const levels = JSON.parse(readFileSync(levelsFile, 'utf8')); assert.equal(levels.levels.find((level: any) => level.id === 'classified').claim, false); });
