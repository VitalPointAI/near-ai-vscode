const test = require('node:test');
const assert = require('node:assert');
const { parse } = require('./csv');

test('simple rows', () => {
  assert.deepEqual(parse('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
});
