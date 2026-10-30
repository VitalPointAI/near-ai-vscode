const test = require('node:test');
const assert = require('node:assert');
const { parse } = require('../csv');

test('simple rows', () => assert.deepEqual(parse('a,b\n1,2'), [['a', 'b'], ['1', '2']]));
test('a quoted field keeps its comma', () => assert.deepEqual(parse('"a,b",c'), [['a,b', 'c']]));
test('a doubled quote inside quotes is one quote', () => assert.deepEqual(parse('"say ""hi""",x'), [['say "hi"', 'x']]));
test('a line break inside quotes is part of the field', () => assert.deepEqual(parse('"line1\nline2",z\nnext,row'), [['line1\nline2', 'z'], ['next', 'row']]));
test('CRLF line endings', () => assert.deepEqual(parse('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]));
test('empty fields are empty strings', () => assert.deepEqual(parse('a,,b\n,\n'), [['a', '', 'b'], ['', '']]));
test('a trailing comma gives a final empty field', () => assert.deepEqual(parse('a,b,'), [['a', 'b', '']]));
test('unquoted fields are not trimmed', () => assert.deepEqual(parse('  a , b'), [['  a ', ' b']]));
test('an empty text gives no rows', () => assert.deepEqual(parse(''), []));
test('a quoted empty field', () => assert.deepEqual(parse('"",x'), [['', 'x']]));
test('an unclosed quote reports the line it started on', () => assert.throws(() => parse('a\nb\n"open,\nmore'), (error) => error instanceof Error && /\b3\b/.test(error.message)));
