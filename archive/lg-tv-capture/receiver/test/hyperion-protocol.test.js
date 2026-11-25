import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MessageReader,
  decodeReply,
  decodeRequest,
  encodeNV12Image,
  encodeRawImage,
  encodeRegister,
  encodeReply,
} from '../src/hyperion-protocol.js';

// Retire le préfixe de longueur pour obtenir le buffer FlatBuffers seul.
const body = (framed) => {
  assert.equal(framed.readUInt32BE(0), framed.length - 4);
  return framed.subarray(4);
};

test('Register aller-retour', () => {
  assert.deepEqual(decodeRequest(body(encodeRegister('webos', 150))), {
    type: 'register',
    origin: 'webos',
    priority: 150,
  });
});

test('Reply "registered" lisible par hyperion-webos', () => {
  assert.deepEqual(decodeReply(body(encodeReply({ registered: 150 }))), { error: null, video: -1, registered: 150 });
  assert.deepEqual(decodeReply(body(encodeReply({ error: 'nope' }))), { error: 'nope', video: -1, registered: -1 });
});

test('NV12 avec stride aller-retour', () => {
  const width = 8, height = 4, strideY = 12, strideUV = 12;
  const y = Uint8Array.from({ length: strideY * height }, (_, i) => i);
  const uv = Uint8Array.from({ length: strideUV * height / 2 }, (_, i) => 255 - i);
  const f = decodeRequest(body(encodeNV12Image({ width, height, strideY, strideUV, y, uv })));
  assert.equal(f.format, 'nv12');
  assert.deepEqual([f.width, f.height, f.strideY, f.strideUV], [width, height, strideY, strideUV]);
  assert.deepEqual([...f.y], [...y]);
  assert.deepEqual([...f.uv], [...uv]);
});

test('RawImage RGB aller-retour', () => {
  const rgb = Uint8Array.from({ length: 4 * 2 * 3 }, (_, i) => i * 3);
  const f = decodeRequest(body(encodeRawImage({ width: 4, height: 2, rgb })));
  assert.deepEqual([f.format, f.width, f.height, f.strideY], ['rgb', 4, 2, 12]);
  assert.deepEqual([...f.rgb], [...rgb]);
});

test('MessageReader reconstitue les messages quel que soit le découpage TCP', () => {
  const msgs = [encodeRegister('a', 1), encodeReply({ registered: 1 }), encodeRegister('bb', 2)];
  const stream = Buffer.concat(msgs);
  for (const chunkSize of [1, 3, 7, stream.length]) {
    const got = [];
    const r = new MessageReader((m) => got.push(Buffer.from(m)));
    for (let i = 0; i < stream.length; i += chunkSize) r.push(stream.subarray(i, i + chunkSize));
    assert.deepEqual(got, msgs.map((m) => m.subarray(4)), `chunkSize=${chunkSize}`);
  }
});

test('MessageReader refuse un message démesuré', () => {
  const r = new MessageReader(() => {}, 1024);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(4096);
  assert.throws(() => r.push(header), /trop gros/);
});
