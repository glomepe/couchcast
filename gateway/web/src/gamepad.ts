// Manette du navigateur (API Gamepad, disposition « standard ») → état Remote Play.
// Format envoyé : u32 boutons | u8 L2 | u8 R2 | i16 LX | i16 LY | i16 RX | i16 RY (little-endian).

// Bits ChiakiControllerButton (chiaki-ng/lib/include/chiaki/controller.h).
const CROSS = 1 << 0, MOON = 1 << 1, BOX = 1 << 2, PYRAMID = 1 << 3;
const DPAD_LEFT = 1 << 4, DPAD_RIGHT = 1 << 5, DPAD_UP = 1 << 6, DPAD_DOWN = 1 << 7;
const L1 = 1 << 8, R1 = 1 << 9, L3 = 1 << 10, R3 = 1 << 11;
const OPTIONS = 1 << 12, SHARE = 1 << 13, TOUCHPAD = 1 << 14, PS = 1 << 15;

// Index des boutons dans la disposition standard du W3C → bit Remote Play.
const MAPPING: Array<[number, number]> = [
  [0, CROSS], [1, MOON], [2, BOX], [3, PYRAMID],
  [4, L1], [5, R1], [8, SHARE], [9, OPTIONS], [10, L3], [11, R3],
  [12, DPAD_UP], [13, DPAD_DOWN], [14, DPAD_LEFT], [15, DPAD_RIGHT],
  [16, PS], [17, TOUCHPAD],
];

const DEADZONE = 0.08;

function axis(v: number | undefined): number {
  if (v === undefined || Math.abs(v) < DEADZONE) return 0;
  return Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
}

export function encodeGamepad(gp: Gamepad): ArrayBuffer {
  let buttons = 0;
  for (const [index, bit] of MAPPING) if (gp.buttons[index]?.pressed) buttons |= bit;
  const buf = new ArrayBuffer(14);
  const v = new DataView(buf);
  v.setUint32(0, buttons >>> 0, true);
  v.setUint8(4, Math.round((gp.buttons[6]?.value ?? 0) * 255));
  v.setUint8(5, Math.round((gp.buttons[7]?.value ?? 0) * 255));
  v.setInt16(6, axis(gp.axes[0]), true);
  v.setInt16(8, axis(gp.axes[1]), true);
  v.setInt16(10, axis(gp.axes[2]), true);
  v.setInt16(12, axis(gp.axes[3]), true);
  return buf;
}

/** Lit la première manette à chaque image et envoie son état quand il change. */
export function startGamepadLoop(send: (state: ArrayBuffer) => void, onName: (name: string | null) => void): () => void {
  let raf = 0;
  let lastKey = '';
  let lastSent = 0;
  let lastName: string | null = null;

  const tick = () => {
    const gp = navigator.getGamepads().find((g): g is Gamepad => !!g && g.connected) ?? null;
    const name = gp?.id ?? null;
    if (name !== lastName) {
      lastName = name;
      onName(name);
    }
    if (gp) {
      const state = encodeGamepad(gp);
      const key = new Uint8Array(state).join(',');
      const now = performance.now();
      // Envoi sur changement, plus un rappel toutes les 100 ms (le canal n'est pas fiable).
      if (key !== lastKey || now - lastSent > 100) {
        send(state);
        lastKey = key;
        lastSent = now;
      }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
