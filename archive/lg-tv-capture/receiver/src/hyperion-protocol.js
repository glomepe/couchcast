// Protocole "flatbuffers" de Hyperion.ng, tel qu'utilisé par hyperion-webos / PicCap.
// Chaque message TCP = longueur u32 big-endian + buffer FlatBuffers.
// Schémas : hyperion-webos/fbs/hyperion_request.fbs et hyperion_reply.fbs.
import { Builder } from 'flatbuffers';

export const Command = { NONE: 0, Color: 1, Image: 2, Clear: 3, Register: 4 };
export const ImageType = { NONE: 0, RawImage: 1, NV12Image: 2 };
export const MAX_MESSAGE_SIZE = 64 * 1024 * 1024;

// --- Lecture FlatBuffers minimale (sans code généré) ---------------------

class Table {
  constructor(view, pos) {
    this.view = view;
    this.pos = pos;
    this.vtable = pos - view.getInt32(pos, true);
    this.vtableSize = view.getUint16(this.vtable, true);
  }

  fieldOffset(id) {
    const vo = 4 + id * 2;
    return vo < this.vtableSize ? this.view.getUint16(this.vtable + vo, true) : 0;
  }

  u8(id, def = 0) {
    const o = this.fieldOffset(id);
    return o ? this.view.getUint8(this.pos + o) : def;
  }

  i32(id, def = 0) {
    const o = this.fieldOffset(id);
    return o ? this.view.getInt32(this.pos + o, true) : def;
  }

  #indirect(id) {
    const o = this.fieldOffset(id);
    if (!o) return 0;
    const at = this.pos + o;
    return at + this.view.getUint32(at, true);
  }

  table(id) {
    const at = this.#indirect(id);
    return at ? new Table(this.view, at) : null;
  }

  // Vecteur d'octets renvoyé sans copie (sous-vue du buffer reçu).
  bytes(id) {
    const at = this.#indirect(id);
    if (!at) return null;
    const len = this.view.getUint32(at, true);
    return new Uint8Array(this.view.buffer, this.view.byteOffset + at + 4, len);
  }

  string(id) {
    const b = this.bytes(id);
    return b ? new TextDecoder().decode(b) : null;
  }
}

function root(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return new Table(view, view.getUint32(0, true));
}

/**
 * Décode un message Request. Retourne
 *   { type: 'register', origin, priority }
 *   { type: 'image', format: 'nv12'|'rgb', width, height, strideY, strideUV, y, uv, rgb }
 *   { type: 'color' | 'clear' | 'unknown' }
 */
export function decodeRequest(buf) {
  const req = root(buf);
  const cmdType = req.u8(0);
  const cmd = req.table(1);
  if (!cmd) return { type: 'unknown' };

  switch (cmdType) {
    case Command.Register:
      return { type: 'register', origin: cmd.string(0), priority: cmd.i32(1) };

    case Command.Image: {
      const imgType = cmd.u8(0);
      const img = cmd.table(1);
      if (!img) return { type: 'unknown' };
      if (imgType === ImageType.NV12Image) {
        const width = img.i32(2);
        const height = img.i32(3);
        return {
          type: 'image',
          format: 'nv12',
          width,
          height,
          strideY: img.i32(4) || width,
          strideUV: img.i32(5) || width,
          y: img.bytes(0),
          uv: img.bytes(1),
        };
      }
      if (imgType === ImageType.RawImage) {
        const width = img.i32(1, -1);
        return { type: 'image', format: 'rgb', width, height: img.i32(2, -1), strideY: width * 3, rgb: img.bytes(0) };
      }
      return { type: 'unknown' };
    }

    case Command.Color:
      return { type: 'color' };
    case Command.Clear:
      return { type: 'clear' };
    default:
      return { type: 'unknown' };
  }
}

export function decodeReply(buf) {
  const reply = root(buf);
  return { error: reply.string(0), video: reply.i32(1, -1), registered: reply.i32(2, -1) };
}

// --- Écriture -------------------------------------------------------------

function finish(b, rootOffset) {
  b.finish(rootOffset);
  const body = b.asUint8Array();
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.set(body, 4);
  return out;
}

// Reply { error:string; video:int = -1; registered:int = -1 }
export function encodeReply({ error = null, video = -1, registered = -1 } = {}) {
  const b = new Builder(64);
  const err = error === null ? 0 : b.createString(error);
  b.startObject(3);
  if (err) b.addFieldOffset(0, err, 0);
  b.addFieldInt32(1, video, -1);
  b.addFieldInt32(2, registered, -1);
  return finish(b, b.endObject());
}

function request(b, cmdType, cmdOffset) {
  b.startObject(2);
  b.addFieldInt8(0, cmdType, 0);
  b.addFieldOffset(1, cmdOffset, 0);
  return finish(b, b.endObject());
}

export function encodeRegister(origin, priority) {
  const b = new Builder(64);
  const o = b.createString(origin);
  b.startObject(2);
  b.addFieldOffset(0, o, 0);
  b.addFieldInt32(1, priority, 0);
  return request(b, Command.Register, b.endObject());
}

function image(b, imgType, imgOffset) {
  b.startObject(3);
  b.addFieldInt8(0, imgType, 0);
  b.addFieldOffset(1, imgOffset, 0);
  b.addFieldInt32(2, -1, -1);
  return request(b, Command.Image, b.endObject());
}

export function encodeNV12Image({ width, height, strideY, strideUV, y, uv }) {
  const b = new Builder(y.length + uv.length + 256);
  const yv = b.createByteVector(y);
  const uvv = b.createByteVector(uv);
  b.startObject(6);
  b.addFieldOffset(0, yv, 0);
  b.addFieldOffset(1, uvv, 0);
  b.addFieldInt32(2, width, 0);
  b.addFieldInt32(3, height, 0);
  b.addFieldInt32(4, strideY, 0);
  b.addFieldInt32(5, strideUV, 0);
  return image(b, ImageType.NV12Image, b.endObject());
}

export function encodeRawImage({ width, height, rgb }) {
  const b = new Builder(rgb.length + 256);
  const data = b.createByteVector(rgb);
  b.startObject(3);
  b.addFieldOffset(0, data, 0);
  b.addFieldInt32(1, width, -1);
  b.addFieldInt32(2, height, -1);
  return image(b, ImageType.RawImage, b.endObject());
}

/**
 * Découpe un flux TCP en messages (préfixe de longueur u32 big-endian).
 * Les octets sont accumulés sans recopie tant qu'un message n'est pas complet.
 */
export class MessageReader {
  #chunks = [];
  #buffered = 0;
  #expected = -1;

  constructor(onMessage, maxSize = MAX_MESSAGE_SIZE) {
    this.onMessage = onMessage;
    this.maxSize = maxSize;
  }

  push(chunk) {
    this.#chunks.push(chunk);
    this.#buffered += chunk.length;

    for (;;) {
      if (this.#expected < 0) {
        if (this.#buffered < 4) return;
        this.#expected = this.#take(4).readUInt32BE(0);
        if (this.#expected > this.maxSize) {
          throw new Error(`message trop gros : ${this.#expected} octets`);
        }
      }
      if (this.#buffered < this.#expected) return;
      const msg = this.#take(this.#expected);
      this.#expected = -1;
      this.onMessage(msg);
    }
  }

  #take(n) {
    const first = this.#chunks[0];
    let out;
    if (first.length >= n) {
      out = first.subarray(0, n);
      if (first.length === n) this.#chunks.shift();
      else this.#chunks[0] = first.subarray(n);
    } else {
      out = Buffer.allocUnsafe(n);
      let filled = 0;
      while (filled < n) {
        const c = this.#chunks[0];
        const k = Math.min(c.length, n - filled);
        c.copy(out, filled, 0, k);
        filled += k;
        if (k === c.length) this.#chunks.shift();
        else this.#chunks[0] = c.subarray(k);
      }
    }
    this.#buffered -= n;
    return out;
  }
}
