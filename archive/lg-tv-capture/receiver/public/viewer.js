// Viewer : reçoit les frames brutes (NV12 ou RGB) via WebSocket et les affiche en WebGL2.
// La conversion YUV → RGB est faite par le GPU du navigateur.
const FORMAT_NV12 = 1;
const FORMAT_RGB = 2;
const HEADER_SIZE = 32;

const canvas = document.getElementById('view');
const empty = document.getElementById('empty');
const $ = (id) => document.getElementById(id);

const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, desynchronized: true });
if (!gl) {
  empty.textContent = 'WebGL2 indisponible dans ce navigateur.';
  throw new Error('WebGL2 indisponible');
}

const VERT = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() {
  uv = vec2((pos.x + 1.0) * 0.5, (1.0 - pos.y) * 0.5);
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec2 uv;
out vec4 color;
uniform int format;
uniform sampler2D texY;
uniform sampler2D texUV;
uniform mat3 yuv2rgb;
uniform vec3 offset;
uniform vec3 scale;
void main() {
  if (format == ${FORMAT_RGB}) {
    color = vec4(texture(texY, uv).rgb, 1.0);
    return;
  }
  vec3 yuv = vec3(texture(texY, uv).r, texture(texUV, uv).rg);
  color = vec4(clamp(yuv2rgb * ((yuv - offset) * scale), 0.0, 1.0), 1.0);
}`;

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

const prog = gl.createProgram();
gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
gl.linkProgram(prog);
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
gl.useProgram(prog);

const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
const posLoc = gl.getAttribLocation(prog, 'pos');
gl.enableVertexAttribArray(posLoc);
gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

function makeTexture(unit) {
  const t = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
const texY = makeTexture(0);
const texUV = makeTexture(1);
gl.uniform1i(gl.getUniformLocation(prog, 'texY'), 0);
gl.uniform1i(gl.getUniformLocation(prog, 'texUV'), 1);
gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

const loc = {
  format: gl.getUniformLocation(prog, 'format'),
  yuv2rgb: gl.getUniformLocation(prog, 'yuv2rgb'),
  offset: gl.getUniformLocation(prog, 'offset'),
  scale: gl.getUniformLocation(prog, 'scale'),
};

// Matrices en ordre colonne (GLSL) : rgb = M * (y, u, v).
const MATRICES = {
  709: [1, 1, 1, 0, -0.1873, 1.8556, 1.5748, -0.4681, 0],
  601: [1, 1, 1, 0, -0.344136, 1.772, 1.402, -0.714136, 0],
};

function applyColorSettings() {
  gl.uniformMatrix3fv(loc.yuv2rgb, false, MATRICES[$('matrix').value]);
  if ($('range').value === 'limited') {
    gl.uniform3f(loc.offset, 16 / 255, 128 / 255, 128 / 255);
    gl.uniform3f(loc.scale, 255 / 219, 255 / 224, 255 / 224);
  } else {
    gl.uniform3f(loc.offset, 0, 128 / 255, 128 / 255);
    gl.uniform3f(loc.scale, 1, 1, 1);
  }
}
applyColorSettings();
$('matrix').addEventListener('change', applyColorSettings);
$('range').addEventListener('change', applyColorSettings);

// --- Réception -------------------------------------------------------------

let pending = null; // dernière frame reçue, pas encore affichée
let displayed = 0;
let displayedWindowStart = performance.now();

function upload(f) {
  if (canvas.width !== f.width || canvas.height !== f.height) {
    canvas.width = f.width;
    canvas.height = f.height;
    gl.viewport(0, 0, f.width, f.height);
  }
  gl.uniform1i(loc.format, f.format);

  if (f.format === FORMAT_RGB) {
    gl.activeTexture(gl.TEXTURE0);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, f.strideY / 3);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, f.width, f.height, 0, gl.RGB, gl.UNSIGNED_BYTE, f.plane0);
  } else {
    gl.activeTexture(gl.TEXTURE0);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, f.strideY);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, f.width, f.height, 0, gl.RED, gl.UNSIGNED_BYTE, f.plane0);
    gl.activeTexture(gl.TEXTURE1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, f.strideUV / 2);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, f.width / 2, f.height / 2, 0, gl.RG, gl.UNSIGNED_BYTE, f.plane1);
  }
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function render() {
  if (pending) {
    upload(pending);
    pending = null;
    displayed++;
    if (canvas.hidden) {
      canvas.hidden = false;
      empty.hidden = true;
    }
  }
  requestAnimationFrame(render);
}
requestAnimationFrame(render);

function parseFrame(buf) {
  const v = new DataView(buf);
  const len0 = v.getUint32(24, true);
  const len1 = v.getUint32(28, true);
  return {
    seq: v.getUint32(0, true),
    format: v.getUint16(4, true),
    width: v.getUint32(8, true),
    height: v.getUint32(12, true),
    strideY: v.getUint32(16, true),
    strideUV: v.getUint32(20, true),
    plane0: new Uint8Array(buf, HEADER_SIZE, len0),
    plane1: len1 ? new Uint8Array(buf, HEADER_SIZE + len0, len1) : null,
  };
}

function showStats(s) {
  const now = performance.now();
  const dfps = (displayed * 1000) / (now - displayedWindowStart);
  displayed = 0;
  displayedWindowStart = now;

  $('s-source').textContent = s.source ?? 'aucune';
  $('s-format').textContent = s.format ? `${s.format.toUpperCase()} ${s.width}×${s.height}` : '-';
  $('s-fps').textContent = s.fps.toFixed(1);
  $('s-fps').className = s.fps >= 29 ? 'ok' : s.fps >= 15 ? 'warn' : 'bad';
  $('s-dfps').textContent = dfps.toFixed(1);
  $('s-mbps').textContent = `${s.mbps.toFixed(1)} Mbit/s`;
  $('s-int').textContent = `${s.intervalAvgMs.toFixed(1)} / ${s.intervalMaxMs.toFixed(1)} ms`;
  $('s-size').textContent = s.frameBytes ? `${(s.frameBytes / 1024).toFixed(0)} Kio` : '-';
  $('s-drop').textContent = String(s.dropped);
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    $('s-conn').textContent = 'connecté';
    $('s-conn').className = 'ok';
  };
  ws.onclose = () => {
    $('s-conn').textContent = 'déconnecté, nouvel essai…';
    $('s-conn').className = 'bad';
    setTimeout(connect, 1000);
  };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      const msg = JSON.parse(e.data);
      if (msg.type === 'stats') showStats(msg);
    } else {
      pending = parseFrame(e.data); // seule la plus récente compte
    }
  };
}
connect();

// --- Contrôles -------------------------------------------------------------

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
}
function toggleHud() {
  $('hud').classList.toggle('hidden');
}
$('fs').addEventListener('click', toggleFullscreen);
$('hide').addEventListener('click', toggleHud);
document.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  if (e.key === 'h' || e.key === 'H') toggleHud();
});
