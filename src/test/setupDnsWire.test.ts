import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeMessage, DNS_CAPS, DNS_REFUSALS, encodeQuery } from '../domain/setup/dnsWire';
import type { DnsRefusal } from '../domain/setup/dnsWire';

const service = '_near-ai-models._tcp.local';
const question = { name: service, type: 'PTR', unicastResponse: true } as const;

function header(questions: number, answers: number, authority = 0, additional = 0): number[] {
  return [0, 0, 0x84, 0, 0, questions, 0, answers, 0, authority, 0, additional];
}

const pointer = (offset: number): number[] => [0xc0 | (offset >>> 8), offset & 0xff];
const label = (value: string): number[] => [Buffer.byteLength(value), ...Buffer.from(value)];
const questionTail = [0, 12, 0x80, 1];
const serviceName = [...service.split('.').flatMap(label), 0];

function record(owner: number[], type: number, data: number[], length = data.length): number[] {
  return [...owner, 0, type, 0x80, 1, 0, 0, 0, 120, length >>> 8, length & 0xff, ...data];
}

const instanceName = [...label('example-gpu'), ...pointer(12)];
const targetName = [...label('gpu'), ...label('local'), 0];
const ipv6 = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
const golden = Uint8Array.from([
  ...header(1, 1, 0, 4), ...serviceName, ...questionTail,
  ...record(pointer(12), 12, instanceName),
  ...record(instanceName, 33, [0, 2, 0, 3, 0x2c, 0xaa, ...targetName]),
  ...record(instanceName, 16, [4, 0x74, 0x3d, 0xe9, 0x7f, 0]),
  ...record(targetName, 1, [192, 0, 2, 10]),
  ...record(targetName, 28, ipv6),
]);

test('golden PTR query preserves ID, question and unicast class bit', () => {
  const encoded = encodeQuery({ id: 0x1234, questions: [question] });
  assert.deepEqual([...encoded], [0x12, 0x34, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, ...serviceName, ...questionTail]);
  assert.deepEqual(decodeMessage(encoded), {
    ok: true, message: { id: 0x1234, flags: 0, questions: [question], answers: [], additionals: [] },
  });
});

test('golden compressed response decodes PTR, SRV, TXT, A and AAAA', () => {
  const instance = `example-gpu.${service}`;
  const host = 'gpu.local';
  assert.deepEqual(decodeMessage(golden), {
    ok: true, message: {
      id: 0, flags: 0x8400, questions: [question],
      answers: [{ kind: 'ptr', name: service, target: instance, ttl: 120 }],
      additionals: [
        { kind: 'srv', name: instance, target: host, port: 11434, priority: 2, weight: 3, ttl: 120 },
        { kind: 'txt', name: instance, strings: ['t=é', ''], ttl: 120 },
        { kind: 'a', name: host, address: '192.0.2.10', ttl: 120 },
        { kind: 'aaaa', name: host, address: '2001:db8::1', ttl: 120 },
      ],
    },
  });
});

function pointerChain(): number[] {
  const bytes = [...header(18, 0), 0, ...questionTail];
  let prior = 12;
  for (let index = 0; index < 17; index++) {
    const next = bytes.length;
    bytes.push(...pointer(prior), ...questionTail);
    prior = next;
  }
  return bytes;
}

const refused: [string, ArrayLike<number>, DnsRefusal][] = [
  ['self pointer', [...header(1, 0), ...pointer(12), ...questionTail], 'pointer-loop'],
  ['backwards pointer that reaches itself through a label', [...header(1, 0), ...label('x'), ...pointer(12), ...questionTail], 'pointer-loop'],
  ['forward pointer', [...header(1, 0), ...pointer(14), 0, ...questionTail], 'bad-pointer'],
  ['pointer past the packet', [...header(1, 0), ...pointer(200), ...questionTail], 'bad-pointer'],
  ['17 chained pointers', pointerChain(), 'bad-pointer'],
  ['64-byte label', [...header(1, 0), ...label('a'.repeat(64)), 0, ...questionTail], 'label-too-long'],
  ['256-byte name', [...header(1, 0), ...Array.from({ length: 3 }, () => label('a'.repeat(63))).flat(), ...label('b'.repeat(62)), 0, ...questionTail], 'name-too-long'],
  ['65 answers', header(0, 65), 'too-many-records'],
  ['65 authority records', header(0, 0, 65), 'too-many-records'],
  ['RDATA past the packet', [...header(0, 1), ...record(targetName, 1, [192, 0, 2, 10], 5)], 'bad-rdata'],
  ['PTR RDATA ends inside a label', [...header(0, 2), ...record(targetName, 12, [3, 0x61]), ...record(targetName, 1, [192, 0, 2, 10])], 'bad-rdata'],
  ['TXT string runs past RDATA', [...header(0, 1), ...record(targetName, 16, [2, 0x61])], 'bad-rdata'],
  ['17 TXT strings', [...header(0, 1), ...record(targetName, 16, Array(17).fill(0))], 'bad-rdata'],
  ['AAAA address is short', [...header(0, 1), ...record(targetName, 28, ipv6.slice(1))], 'bad-rdata'],
  ['9001-byte packet', new Uint8Array(9001), 'too-long'],
  ['short header', new Uint8Array(11), 'truncated'],
];

for (const [description, bytes, reason] of refused) {
  test(`Pitfall 8: refuses ${description}`, () => {
    assert.deepEqual(decodeMessage(Uint8Array.from(bytes)), { ok: false, reason });
  });
}

test('unrelated types are skipped and the following A record is retained', () => {
  const bytes = Uint8Array.from([
    ...header(0, 2), ...record(targetName, 47, [1, 2, 3]), ...record(targetName, 1, [192, 0, 2, 10]),
  ]);
  const decoded = decodeMessage(bytes);
  assert.ok(decoded.ok);
  assert.deepEqual(decoded.message.answers, [{ kind: 'a', name: 'gpu.local', address: '192.0.2.10', ttl: 120 }]);
});

test('seeded fuzz keeps 10000 DNS packet mutations within the decoder budget', () => {
  let state = 0x32105;
  const random = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const seeds = [golden, encodeQuery({ id: 0, questions: [question] })];
  const firstRecordLength = 12 + serviceName.length + questionTail.length + 2 + 8;
  for (let index = 0; index < 10_000; index++) {
    const seed = seeds[random() % seeds.length];
    const bytes = seed.slice();
    const offset = random() % bytes.length;
    const mutation = index % 3;
    if (mutation === 0) bytes[offset] ^= 1 << (random() % 8);
    if (mutation === 1) {
      const lengthOffset = seed === golden ? firstRecordLength + random() % 2 : 12;
      bytes[lengthOffset] = random() & 0xff;
    }
    const packet = mutation === 2 ? bytes.subarray(0, offset) : bytes;
    const start = process.hrtime.bigint();
    const result = decodeMessage(packet);
    assert.ok(process.hrtime.bigint() - start < 50_000_000n, `mutation ${index} exceeded 50 ms`);
    if (result.ok) {
      for (const records of [result.message.questions, result.message.answers, result.message.additionals]) {
        assert.ok(records.length <= DNS_CAPS.maxRecordsPerSection);
      }
    } else {
      assert.ok(DNS_REFUSALS.includes(result.reason));
    }
  }
});
