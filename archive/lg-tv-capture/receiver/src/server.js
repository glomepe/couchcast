#!/usr/bin/env node
// LG Remote Screen — récepteur prototype.
//
// Se fait passer pour un serveur Hyperion.ng (port flatbuffers 19400) afin de
// recevoir les frames brutes envoyées par hyperion-webos / PicCap depuis la TV,
// mesure le débit réel (FPS, Mbit/s, gigue) et relaie les frames vers un
// navigateur via WebSocket (rendu NV12/RGB en WebGL).
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { WebSocketServer } from 'ws';
import { MessageReader, decodeRequest, encodeReply } from './hyperion-protocol.js';
import { FrameStats } from './stats.js';

const { values: opts } = parseArgs({
  options: {
    'hyperion-port': { type: 'string', default: '19400' },
    'http-port': { type: 'string', default: '8080' },
    quiet: { type: 'boolean', default: false },
  },
});

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const FORMAT = { nv12: 1, rgb: 2 };
const HEADER_SIZE = 32;
// Au-delà, le navigateur ne suit pas : on saute des frames plutôt que d'accumuler de la latence.
const MAX_WS_BUFFERED = 8 * 1024 * 1024;

const stats = new FrameStats();
const viewers = new Set();
let seq = 0;

// --- Réception depuis la TV ------------------------------------------------

const tcpServer = net.createServer((socket) => {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  log(`TV connectée : ${peer}`);
  socket.setNoDelay(true);
  stats.source = peer;

  let reader = new MessageReader((msg) => {
    stats.addBytes(msg.length + 4);
    let req;
    try {
      req = decodeRequest(msg);
    } catch (err) {
      log(`message illisible (${msg.length} o) : ${err.message}`);
      return;
    }

    if (req.type === 'register') {
      log(`register origin="${req.origin}" priority=${req.priority}`);
      // hyperion-webos n'envoie aucune image tant qu'il n'a pas reçu registered == priority.
      socket.write(encodeReply({ registered: req.priority }));
    } else if (req.type === 'image') {
      stats.addFrame(req);
      broadcast(req);
    }
  });

  socket.on('data', (chunk) => {
    try {
      reader.push(chunk);
    } catch (err) {
      log(`flux invalide depuis ${peer} : ${err.message}`);
      socket.destroy();
    }
  });
  socket.on('error', (err) => log(`erreur socket ${peer} : ${err.message}`));
  socket.on('close', () => {
    log(`TV déconnectée : ${peer}`);
    reader = null;
    if (stats.source === peer) stats.source = null;
  });
});

// --- Diffusion vers les navigateurs ----------------------------------------

function packFrame(f) {
  const planes = f.format === 'nv12' ? [f.y, f.uv] : [f.rgb];
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32LE(seq++ >>> 0, 0);
  header.writeUInt16LE(FORMAT[f.format], 4);
  header.writeUInt32LE(f.width, 8);
  header.writeUInt32LE(f.height, 12);
  header.writeUInt32LE(f.strideY, 16);
  header.writeUInt32LE(f.strideUV ?? 0, 20);
  header.writeUInt32LE(planes[0].length, 24);
  header.writeUInt32LE(planes[1]?.length ?? 0, 28);
  return Buffer.concat([header, ...planes]);
}

function broadcast(frame) {
  if (viewers.size === 0) return;
  let packet = null;
  for (const ws of viewers) {
    if (ws.bufferedAmount > MAX_WS_BUFFERED) {
      stats.dropped++;
      continue;
    }
    packet ??= packFrame(frame);
    ws.send(packet, { binary: true });
  }
}

// --- HTTP + WebSocket ------------------------------------------------------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(stats.snapshot(viewers.size)));
    return;
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws', perMessageDeflate: false });
wss.on('connection', (ws) => {
  viewers.add(ws);
  ws.on('close', () => viewers.delete(ws));
  ws.on('error', () => viewers.delete(ws));
});

// Statistiques poussées aux navigateurs et affichées en console.
setInterval(() => {
  const snap = stats.tick(viewers.size);
  const text = JSON.stringify({ type: 'stats', ...snap });
  for (const ws of viewers) ws.send(text);
  if (!opts.quiet && (snap.fps > 0 || snap.source)) {
    log(
      `${snap.format ?? '-'} ${snap.width}x${snap.height} | ${snap.fps.toFixed(1)} fps | ` +
        `${snap.mbps.toFixed(1)} Mbit/s | intervalle moy ${snap.intervalAvgMs.toFixed(1)} ms, max ${snap.intervalMaxMs.toFixed(1)} ms | ` +
        `viewers ${snap.viewers}, frames sautées ${snap.dropped}`,
    );
  }
}, 1000).unref();

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

tcpServer.listen(Number(opts['hyperion-port']), () => {
  httpServer.listen(Number(opts['http-port']), () => {
    const ips = lanAddresses();
    log(`Récepteur Hyperion (flatbuffers) : port ${opts['hyperion-port']}`);
    log(`Viewer : ${ips.map((ip) => `http://${ip}:${opts['http-port']}/`).join('  ') || `http://localhost:${opts['http-port']}/`}`);
    log(`Dans PicCap, mettre l'adresse ${ips[0] ?? '<IP de cet ordinateur>'} et le port ${opts['hyperion-port']}.`);
  });
});
