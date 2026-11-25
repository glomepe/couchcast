#!/usr/bin/env node
// Simule hyperion-webos côté TV : même séquence protocolaire (Register, attente
// de la réponse "registered", puis envoi d'images) avec une mire animée.
// Sert à valider le récepteur et le viewer sans téléviseur.
import net from 'node:net';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { MessageReader, decodeReply, encodeNV12Image, encodeRawImage, encodeRegister } from './hyperion-protocol.js';

const { values: opts } = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '19400' },
    width: { type: 'string', default: '1280' },
    height: { type: 'string', default: '720' },
    fps: { type: 'string', default: '30' },
    format: { type: 'string', default: 'nv12' }, // nv12 | rgb
    'stride-pad': { type: 'string', default: '0' }, // octets de padding par ligne, comme certains buffers TV
    priority: { type: 'string', default: '150' },
    seconds: { type: 'string', default: '0' }, // 0 = infini
  },
});

const width = Number(opts.width);
const height = Number(opts.height);
const fps = Number(opts.fps);
const priority = Number(opts.priority);
const strideY = width + Number(opts['stride-pad']);
const strideUV = strideY;

const socket = net.connect(Number(opts.port), opts.host);
await once(socket, 'connect');
socket.setNoDelay(true);
console.log(`connecté à ${opts.host}:${opts.port}, ${opts.format} ${width}x${height} @ ${fps} fps`);

let registered = false;
const reader = new MessageReader((msg) => {
  const reply = decodeReply(msg);
  if (reply.registered === priority) registered = true;
});
socket.on('data', (c) => reader.push(c));
socket.on('close', () => process.exit(0));

socket.write(encodeRegister('fake-tv', priority));
while (!registered) await new Promise((r) => setTimeout(r, 10));
console.log('enregistré auprès du serveur');

const y = new Uint8Array(strideY * height);
const uv = new Uint8Array(strideUV * (height / 2));
const rgb = new Uint8Array(width * height * 3);

function drawNV12(t) {
  const bar = Math.floor((t * 4) % width);
  for (let row = 0; row < height; row++) {
    const base = row * strideY;
    for (let x = 0; x < width; x++) {
      const v = ((x + row + t) & 0xff) * 0.6 + 16;
      y[base + x] = Math.abs(x - bar) < 12 ? 235 : v;
    }
  }
  for (let row = 0; row < height / 2; row++) {
    const base = row * strideUV;
    for (let x = 0; x < width; x += 2) {
      uv[base + x] = (x * 224) / width + 16; // U
      uv[base + x + 1] = (row * 448) / height + 16; // V
    }
  }
}

function drawRGB(t) {
  const bar = Math.floor((t * 4) % width);
  for (let row = 0; row < height; row++) {
    for (let x = 0; x < width; x++) {
      const i = (row * width + x) * 3;
      const on = Math.abs(x - bar) < 12;
      rgb[i] = on ? 255 : (x * 255) / width;
      rgb[i + 1] = on ? 255 : (row * 255) / height;
      rgb[i + 2] = on ? 255 : (x + row + t) & 0xff;
    }
  }
}

const interval = 1000 / fps;
const end = Number(opts.seconds) > 0 ? performance.now() + Number(opts.seconds) * 1000 : Infinity;
let next = performance.now();
let sent = 0;
let windowStart = performance.now();

while (performance.now() < end) {
  if (opts.format === 'rgb') {
    drawRGB(sent);
    if (!socket.write(encodeRawImage({ width, height, rgb }))) await once(socket, 'drain');
  } else {
    drawNV12(sent);
    if (!socket.write(encodeNV12Image({ width, height, strideY, strideUV, y, uv }))) await once(socket, 'drain');
  }
  sent++;

  if (performance.now() - windowStart >= 2000) {
    const secs = (performance.now() - windowStart) / 1000;
    console.log(`envoi : ${(sent / secs).toFixed(1)} fps`);
    sent = 0;
    windowStart = performance.now();
  }

  next += interval;
  const wait = next - performance.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  else next = performance.now(); // en retard : on ne cherche pas à rattraper
}
socket.end();
