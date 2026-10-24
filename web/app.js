/* XP GlassPad – iPad bezel for the X-Plane 12 G1000 / GNS 430 / GNS 530
 *
 * - polls /api/status to learn which avionics the loaded aircraft uses
 * - shows the matching bezel, streams the real screen from /frame/<device>
 * - keys:  tap = command once, hold >0.5 s = command begin/end (e.g. CLR hold = default map)
 * - knobs: turn with a circular finger motion (start on the outer ring = outer knob,
 *          start in the middle = inner knob), tap = push. Mouse wheel works for testing.
 * - RANGE knob (G1000): turn = range, tap = push pan, hold + drag = joystick pan
 */
'use strict';

const PREFER = ['pfd1', 'mfd', 'pfd2', 'gns530_1', 'gns430_1', 'gns530_2', 'gns430_2',
                'mcdu_1', 'tl_mcdu_1', 'cdu739_1', 'cdu815_1', 'mcdu_2', 'tl_mcdu_2', 'cdu739_2', 'cdu815_2'];
const isFms = (key) => /^(tl_)?(mcdu|cdu)/.test(key);
const portrait = () => window.innerHeight > window.innerWidth;
const DETENT = 20;          // degrees of finger rotation per knob click
const HOLD_MS = 500;        // key hold threshold for begin/end
const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------- i18n (German if the tablet is German, else English)
const DE = (navigator.language || '').toLowerCase().startsWith('de');
const T = DE ? {
  noConn: 'Keine Verbindung zu X-Plane', wait: 'Warte auf Bild von X-Plane …', offline: 'nicht verbunden',
  noDev: 'Das geladene Flugzeug nutzt kein X-Plane-Standardgerät (G1000, GNS, MCDU/CDU). Add-ons wie ToLiss oder Zibo zeichnen ihr eigenes Gerät – Unterstützung folgt.', menuHint: 'Menü: Taste MENÜ oben links am Gerät (ohne Gerät: oben in der Mitte tippen).',
  menuKey: 'MENÜ', sound: 'Klick-Sound', ap: 'AP-Tasten (G1000)', auto: 'Gerät automatisch wählen', menu: 'Menü',
  dual: 'GNS 530 + 430 zusammen', pixel: 'Echte Display-Pixel (GNS)',
  lightAuto: 'Tastenbeleuchtung aus dem Sim', lightMan: 'Beleuchtung manuell',
} : {
  noConn: 'No connection to X-Plane', wait: 'Waiting for image from X-Plane …', offline: 'not connected',
  noDev: 'The loaded aircraft uses no built-in X-Plane unit (G1000, GNS, MCDU/CDU). Add-ons like ToLiss or Zibo draw their own unit – support is coming.', menuHint: 'Menu: MENU key top left on the unit (no unit shown: tap the top centre).',
  menuKey: 'MENU', sound: 'Click sound', ap: 'AP keys (G1000)', auto: 'Pick device automatically', menu: 'Menu',
  dual: 'GNS 530 + 430 together', pixel: 'Real display pixels (GNS)',
  lightAuto: 'Key lighting from the sim', lightMan: 'Manual lighting',
};

const opts = loadOpts();
let status = null;
let current = null;          // device key shown
let manualPick = false;
let lastAcf = null;
const seen = new Set();   // devices the sim actually draws (bound-but-never-drawn units, e.g. a hidden GNS in an add-on, are ignored)
// FMS units (Laminar MCDU/CDU, ToLiss MCDU) are still in development – hidden in this release
const FMS_ENABLED = /[?&]fms=1/.test(location.search);
const usable = (d) => d.bound && seen.has(d.key) && (FMS_ENABLED || !isFms(d.key));

// ---------------------------------------------------------------- options (per iPad)
function loadOpts() {
  let o = { sound: true, ap: true, auto: true, dual: true, pixel: false, lightAuto: true, lightVal: 0 };
  try { Object.assign(o, JSON.parse(localStorage.getItem('glasspad') || '{}')); } catch (e) {}
  return o;
}
function saveOpts() { try { localStorage.setItem('glasspad', JSON.stringify(opts)); } catch (e) {} }

// ---------------------------------------------------------------- commands
const pending = new Map();   // batched knob detents: name -> count
let flushTimer = null;
function send(name, mode = 'once', n = 1) {
  if (!name) return;
  fetch(`/api/cmd?c=${encodeURIComponent(name)}&m=${mode}&n=${n}`, { cache: 'no-store' })
    .catch(() => toast(T.noConn));
}
function queueStep(name) {
  if (!name) return;
  pending.set(name, (pending.get(name) || 0) + 1);
  if (!flushTimer) flushTimer = setTimeout(flushSteps, 35);
}
function flushSteps() {
  flushTimer = null;
  for (const [name, n] of pending) {
    for (let left = n; left > 0; left -= 50) send(name, 'once', Math.min(50, left));
  }
  pending.clear();
}

// ---------------------------------------------------------------- click sound
let actx = null;
function click(strength = 1) {
  if (!opts.sound) return;
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const len = Math.floor(actx.sampleRate * 0.012);
    const buf = actx.createBuffer(1, len, actx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 6);
    const src = actx.createBufferSource(); src.buffer = buf;
    const f = actx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2600; f.Q.value = 1.2;
    const g = actx.createGain(); g.gain.value = 0.35 * strength;
    src.connect(f).connect(g).connect(actx.destination); src.start();
  } catch (e) {}
}

// ---------------------------------------------------------------- tiny seeded random (stable "wear" per control)
function rnd(seed) {
  let h = 2166136261;
  for (const c of seed) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; };
}

// ---------------------------------------------------------------- glyphs
const SVG = {
  flipH: '<svg width="34" height="14" viewBox="0 0 34 14"><path d="M2 7h30M2 7l6-5M2 7l6 5M32 7l-6-5M32 7l-6 5" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  flipV: '<svg width="12" height="26" viewBox="0 0 12 26"><path d="M6 2v22M6 2l-4 5M6 2l4 5M6 24l-4-5M6 24l4-5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  direct: '<svg width="40" height="18" viewBox="0 0 40 18"><path d="M3 9h32M35 9l-5-4M35 9l-5 4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 2.5h4.5a6.5 6.5 0 0 1 0 13H15z" fill="#2f3033" stroke="currentColor" stroke-width="2.2"/></svg>',
  tri: '<svg width="18" height="11" viewBox="0 0 18 11"><path d="M9 1l8 9H1z" fill="currentColor"/></svg>',
  triUp: '<svg width="22" height="16" viewBox="0 0 22 16"><path d="M11 2l9 12H2z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>',
  triDn: '<svg width="22" height="16" viewBox="0 0 22 16"><path d="M11 14L2 2h18z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>',
  baro: '<svg width="20" height="20" viewBox="0 0 20 20" style="margin:0 2px"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 4.5l4.5 8h-9z" fill="currentColor"/></svg>',
  upArrow: '<svg width="10" height="16" viewBox="0 0 10 16"><path d="M5 15V2M5 2L1.5 6M5 2l3.5 4" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>',
};

// ---------------------------------------------------------------- bezel definitions
// all coordinates = centres in design units
function g1000(P) {
  const items = [];
  const L = (x, y, html, cls = 'sm') => items.push({ t: 'lbl', x, y, html, cls });
  const K = (x, y, w, h, html, cmd, cls = '') => items.push({ t: 'key', x, y, w, h, html, cmd: P + cmd, cls });

  items.push({ t: 'recess', x: 214, y: 44, w: 1112, h: 908 });
  items.push({ t: 'screen', x: 245, y: 66, w: 1040, h: 780 });
  // screws
  [[22, 22, 20], [1518, 22, 70], [22, 934, 110], [1518, 934, 160]].forEach(([x, y, r]) => items.push({ t: 'screw', x, y, r }));

  // ---- left column
  items.push({ t: 'knob', x: 92, y: 62, r: 25, single: [P + 'nvol_up', P + 'nvol_dn'], push: P + 'nvol' });
  L(70, 104, 'VOL <span style="font-size:8px;vertical-align:4px">PUSH<br>ID</span>');
  K(160, 112, 58, 32, SVG.flipH, 'nav_ff');
  L(102, 150, 'NAV', 'md');
  items.push({ t: 'knob', x: 102, y: 206, r: 44, ri: 27, outer: [P + 'nav_outer_up', P + 'nav_outer_down'], inner: [P + 'nav_inner_up', P + 'nav_inner_down'], push: P + 'nav12' });
  L(104, 272, 'PUSH<br><span style="font-size:15px">1-2</span>', 'sm stack');
  L(104, 312, 'HDG', 'md');
  items.push({ t: 'knob', x: 104, y: 368, r: 38, single: [P + 'hdg_up', P + 'hdg_down'], push: P + 'hdg_sync' });
  L(104, 428, 'PUSH<br>HDG SYNC', 'sm stack');

  if (opts.ap) {
    const rows = [['AP', 'ap', 'FD', 'fd'], ['HDG', 'hdg', 'ALT', 'alt'], ['NAV', 'nav', 'VNV', 'vnv'],
                  ['APR', 'apr', 'BC', 'bc'], ['VS', 'vs', '<small style="font-size:9px;display:block">NOSE</small>UP', 'nose_up'],
                  ['FLC', 'flc', '<small style="font-size:9px;display:block">NOSE</small>DN', 'nose_down']];
    rows.forEach((r, i) => {
      const y = 488 + i * 54;
      K(62, y, 64, 38, r[0], r[1]);
      K(144, y, 64, 38, r[2], r[3]);
    });
  }
  L(96, 826, 'ALT', 'md');
  items.push({ t: 'knob', x: 76, y: 890, r: 44, ri: 27, outer: [P + 'alt_outer_up', P + 'alt_outer_down'], inner: [P + 'alt_inner_up', P + 'alt_inner_down'] });
  items.push({ t: 'cell', x: 166, y: 856, r: 7 });

  // ---- right column
  items.push({ t: 'knob', x: 1448, y: 56, r: 25, single: [P + 'cvol_up', P + 'cvol_dn'], push: P + 'cvol' });
  L(1470, 100, 'VOL <span style="font-size:8px;vertical-align:4px">PUSH<br>SQ</span>');
  K(1378, 112, 58, 32, SVG.flipH, 'com_ff');
  L(1368, 150, SVG.upArrow + '<br>EMERG', 'sm stack');
  L(1440, 146, 'COM', 'md');
  items.push({ t: 'knob', x: 1440, y: 206, r: 44, ri: 27, outer: [P + 'com_outer_up', P + 'com_outer_down'], inner: [P + 'com_inner_up', P + 'com_inner_down'], push: P + 'com12' });
  L(1440, 272, 'PUSH<br><span style="font-size:15px">1-2</span>', 'sm stack');
  L(1438, 314, 'CRS' + SVG.baro + 'BARO', 'md');
  items.push({ t: 'knob', x: 1440, y: 374, r: 44, ri: 27, outer: [P + 'baro_up', P + 'baro_down'], inner: [P + 'crs_up', P + 'crs_down'], push: P + 'crs_sync' });
  L(1440, 440, 'PUSH<br>CRS CTR', 'sm stack');
  L(1438, 480, 'RANGE', 'md');
  items.push({ t: 'arcs', x: 1438, y: 540, r: 52 });
  items.push({ t: 'knob', x: 1438, y: 540, r: 32, single: [P + 'range_up', P + 'range_down'], push: P + 'pan_push', pan: P + 'pan_', knurlFine: true });
  L(1438, 600, 'PUSH<br><span style="font-size:15px">PAN</span>', 'sm stack');

  const kx = [1398, 1478], ky = [660, 716, 772];
  K(kx[0], ky[0], 62, 38, SVG.direct, 'direct'); K(kx[1], ky[0], 62, 38, 'MENU', 'menu');
  K(kx[0], ky[1], 62, 38, 'FPL', 'fpl');         K(kx[1], ky[1], 62, 38, 'PROC', 'proc');
  K(kx[0], ky[2], 62, 38, 'CLR', 'clr');         K(kx[1], ky[2], 62, 38, 'ENT', 'ent');
  L(1376, 818, 'DFLT MAP', 'sm');
  L(1450, 816, 'FMS', 'md');
  items.push({ t: 'knob', x: 1450, y: 880, r: 44, ri: 27, outer: [P + 'fms_outer_up', P + 'fms_outer_down'], inner: [P + 'fms_inner_up', P + 'fms_inner_down'], push: P + 'cursor' });
  L(1450, 942, 'PUSH CRSR', 'sm');

  // ---- softkeys
  for (let i = 0; i < 12; i++) {
    const x = 296 + i * 86.5;
    items.push({ t: 'tick', x, y: 868 });
    K(x, 906, 56, 34, SVG.tri, 'softkey' + (i + 1), 'soft');
  }
  return { w: 1540, h: 956, items };
}

function gns530(P) {
  // layout after the reference photo (front view), design units 1000 x 760
  const items = [];
  const L = (x, y, html, cls = 'sm') => items.push({ t: 'lbl', x, y, html, cls });
  const K = (x, y, w, h, html, cmd, cls = '') => items.push({ t: 'key', x, y, w, h, html, cmd: cmd && P + cmd, cls });
  const pocket = (x, y, w, h) => items.push({ t: 'pocket', x, y, w, h });

  items.push({ t: 'recess', x: 188, y: 48, w: 664, h: 506 });
  items.push({ t: 'screen', x: 200, y: 60, w: 640, h: 482 });
  L(904, 24, 'GNS 530', 'md');

  // ---- left: flip-flop keys in pockets that run into the screen frame, tiny volume knobs
  // pockets hug the keys (14 px margin) and stay clear of the screen frame
  pocket(100, 67, 80, 102);
  K(140, 118, 52, 74, 'C<br>' + SVG.flipV, 'com_ff', 'tall');
  items.push({ t: 'knob', x: 88, y: 196, r: 16, hitR: 34, single: [P + 'cvol_up', P + 'cvol_dn'], push: P + 'cvol', capText: '.C' });
  L(70, 254, '<span style="font-size:10px">PWR</span><br><span style="font-size:14px">VOL</span><br><span style="font-size:10px">PUSH</span><br><span style="font-size:14px">SQ</span>', 'sm stack');
  pocket(100, 207, 80, 102);
  K(140, 258, 52, 74, 'V<br>' + SVG.flipV, 'nav_ff', 'tall');
  items.push({ t: 'knob', x: 84, y: 334, r: 16, hitR: 34, single: [P + 'vvol_up', P + 'vvol_dn'], push: P + 'vvol', capText: '.V' });
  L(96, 380, '<span style="font-size:14px">VOL</span><span style="font-size:10px;vertical-align:7px">PUSH</span><br><span style="margin-left:30px;font-size:14px">ID</span>', 'sm stack');

  L(120, 566, 'COM<span style="font-size:24px;font-weight:400;margin:0 1px">/</span><span style="font-size:13px">VLOC</span>', 'md');
  items.push({ t: 'knob', x: 128, y: 658, r: 60, ri: 37, outer: [P + 'coarse_up', P + 'coarse_down'], inner: [P + 'fine_up', P + 'fine_down'], push: P + 'nav_com_tog', plain: true });

  // ---- bottom: raised key strip
  // strip ends well before both knobs (left knob edge 188, right knob edge 858)
  items.push({ t: 'strip', x: 220, y: 584, w: 608, h: 92 });
  [['CDI', 'cdi'], ['OBS', 'obs'], ['MSG', 'msg'], ['FPL', 'fpl'], ['VNAV', 'vnav'], ['PROC', 'proc']]
    .forEach(([t, c], i) => K(279 + i * 98, 630, 72, 42, t, c));

  // ---- right: RNG rocker + keys, each in its own pocket
  pocket(866, 54, 92, 158);
  items.push({ t: 'rockerV', x: 912, y: 133, w: 64, h: 138, up: P + 'zoom_out', dn: P + 'zoom_in' });
  [[SVG.direct, 'direct', 262], ['MENU', 'menu', 328], ['CLR', 'clr', 394], ['ENT', 'ent', 460]].forEach(([t, c, y]) => {
    pocket(866, y - 30, 92, 60);
    K(912, y, 74, 44, t, c);
  });
  items.push({ t: 'bracket', x: 962, y1: 394, y2: 492 });
  L(948, 506, 'DEFAULT', 'sm'); L(970, 522, 'NAV', 'sm');
  L(904, 548, 'GPS', 'md');
  items.push({ t: 'knob', x: 918, y: 658, r: 60, ri: 37, outer: [P + 'chapter_up', P + 'chapter_dn'], inner: [P + 'page_up', P + 'page_dn'], push: P + 'cursor', plain: true });
  return { w: 1000, h: 760, items };
}

function gns430(P) {
  const items = [];
  const L = (x, y, html, cls = 'sm') => items.push({ t: 'lbl', x, y, html, cls });
  const K = (x, y, w, h, html, cmd, cls = '') => items.push({ t: 'key', x, y, w, h, html, cmd: cmd && P + cmd, cls });
  const pocket = (x, y, w, h) => items.push({ t: 'pocket', x, y, w, h });

  items.push({ t: 'recess', x: 262, y: 20, w: 648, h: 410 });
  items.push({ t: 'screen', x: 272, y: 30, w: 628, h: 390 });
  L(1118, 18, 'GNS 430', 'md');

  // ---- left
  items.push({ t: 'knob', x: 80, y: 70, r: 20, hitR: 38, single: [P + 'cvol_up', P + 'cvol_dn'], push: P + 'cvol', capText: '.C' });
  L(80, 122, '<span style="font-size:10px">PWR</span> <span style="font-size:10px;vertical-align:4px">PUSH</span><br><span style="font-size:14px">VOL&nbsp;&nbsp;SQ</span>', 'sm stack');
  items.push({ t: 'knob', x: 84, y: 184, r: 20, hitR: 38, single: [P + 'vvol_up', P + 'vvol_dn'], push: P + 'vvol', capText: '.V' });
  L(90, 230, '<span style="font-size:14px">VOL</span><span style="font-size:10px;vertical-align:7px">PUSH</span><br><span style="margin-left:30px;font-size:14px">ID</span>', 'sm stack');
  pocket(156, 55, 80, 106);
  K(196, 108, 52, 78, 'C<br>' + SVG.flipV, 'com_ff', 'tall');
  pocket(156, 179, 80, 106);
  K(196, 232, 52, 78, 'V<br>' + SVG.flipV, 'nav_ff', 'tall');
  L(176, 312, 'COM<span style="font-size:24px;font-weight:400;margin:0 1px">/</span><span style="font-size:13px">VLOC</span>', 'md');
  items.push({ t: 'knob', x: 104, y: 404, r: 62, ri: 38, outer: [P + 'coarse_up', P + 'coarse_down'], inner: [P + 'fine_up', P + 'fine_down'], push: P + 'nav_com_tog' });

  // ---- right
  pocket(960, 38, 176, 62);
  items.push({ t: 'rockerH', x: 1048, y: 69, w: 162, h: 46, up: P + 'zoom_out', dn: P + 'zoom_in' });
  [[SVG.direct, 'direct', 992, 146], ['MENU', 'menu', 1104, 146], ['CLR', 'clr', 992, 218], ['ENT', 'ent', 1104, 218]].forEach(([t, c, x, y]) => {
    pocket(x - 46, y - 30, 92, 60);
    K(x, y, 74, 44, t, c);
  });
  L(992, 272, SVG.upArrow + '<br>DEFAULT<br>NAV', 'sm stack');
  L(1104, 296, 'GPS', 'md');
  items.push({ t: 'knob', x: 1080, y: 404, r: 62, ri: 38, outer: [P + 'chapter_up', P + 'chapter_dn'], inner: [P + 'page_up', P + 'page_dn'], push: P + 'cursor' });

  // ---- bottom strip
  items.push({ t: 'strip', x: 262, y: 440, w: 648, h: 54 });
  [['CDI', 'cdi'], ['OBS', 'obs'], ['MSG', 'msg'], ['FPL', 'fpl'], ['PROC', 'proc']]
    .forEach(([t, c], i) => K(338 + i * 124, 467, 74, 40, t, c));
  return { w: 1180, h: 506, items };
}

// ---------------------------------------------------------------- FMS units (Laminar built-in CDU / MCDU)
// Layouts follow Laminar's own CDU and MCDU (X-Plane FMS / Airbus MCDU manuals); keys use sim/FMS/* (unit 1)
// and sim/FMS2/* (unit 2), names taken from the default 737-800 and A330 cockpit manipulators.
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXY'.split('');
const BOXED = { E: 1, N: 1, S: 1, W: 1 };   // marked keys, as on the real units

function fmsCommon(items, P, top, screen) {
  items.push({ t: 'recess', x: screen.x - 12, y: screen.y - 12, w: screen.w + 24, h: screen.h + 24 });
  items.push({ t: 'screen', x: screen.x, y: screen.y, w: screen.w, h: screen.h, fit: 'contain' });
  // 6 line select keys per side, aligned with the CDU's 14-line layout (rows 2,4,…,12)
  const lh = screen.h / 14;
  for (let i = 0; i < 6; i++) {
    const y = screen.y + (2 * i + 2.5) * lh;   // data rows 2,4,…,12
    items.push({ t: 'lsktick', x: screen.x - 30, y, w: 22 }, { t: 'lsktick', x: screen.x + screen.w + 8, y, w: 22 });
    items.push({ t: 'key', x: screen.x - 70, y, w: 56, h: 34, html: '<i class="dash"></i>', cmd: P + 'ls_' + (i + 1) + 'l', cls: 'lsk' });
    items.push({ t: 'key', x: screen.x + screen.w + 70, y, w: 56, h: 34, html: '<i class="dash"></i>', cmd: P + 'ls_' + (i + 1) + 'r', cls: 'lsk' });
  }
}

function keypad(items, P, x0, y0, dy, d = 56, dx = 68) {
  // numeric 3x4 (round keys); y0 = centre of the first row
  const num = [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['.', '0', '+/-']];
  const ncmd = { '.': 'key_period', '+/-': 'key_minus' };
  num.forEach((row, r) => row.forEach((k, c) => items.push({ t: 'key', x: x0 + c * dx, y: y0 + r * dy, w: d, h: d,
    html: k === '.' ? '•' : k, cmd: P + (ncmd[k] || 'key_' + k), cls: 'round' })));
}

function alphaPad(items, P, x0, y0, dy, last) {
  ALPHA.forEach((k, i) => items.push({ t: 'key', x: x0 + (i % 5) * 70, y: y0 + Math.floor(i / 5) * dy, w: 58, h: 52,
    html: BOXED[k] ? `<b class="boxed">${k}</b>` : k, cmd: P + 'key_' + k, cls: 'alpha' }));
  last.forEach(([html, cmd], i) => items.push({ t: 'key', x: x0 + i * 70, y: y0 + 5 * dy, w: 58, h: 52, html, cmd: P + cmd, cls: 'alpha small' }));
}

function cduBoeing(P, b737) {
  const items = [];
  const K = (x, y, html, cmd, w = 84, h = 46, cls = 'fn') => items.push({ t: 'key', x, y, w, h, html, cmd: P + cmd, cls });
  [[34, 34], [766, 34], [34, 1030], [766, 1030]].forEach(([x, y], i) => items.push({ t: 'screw', x, y, r: 20 + i * 40 }));
  fmsCommon(items, P, 0, { x: 150, y: 70, w: 500, h: 420 });
  // function keys (labels as in the Laminar 737 cockpit; MD-82 uses the generic INDEX / FPLN names)
  const r1 = 560, r2 = 618, r3 = 678, r4 = 738, cx = [120, 214, 308, 402, 496];
  K(cx[0], r1, b737 ? 'INIT<br>REF' : 'INDEX', 'index'); K(cx[1], r1, b737 ? 'RTE' : 'FPLN', 'fpln');
  K(cx[2], r1, 'CLB', 'clb'); K(cx[3], r1, 'CRZ', 'crz'); K(cx[4], r1, 'DES', 'des');
  items.push({ t: 'lbl', x: 600, y: r1 - 4, html: 'BRT', cls: 'md' });
  items.push({ t: 'knob', x: 668, y: r1, r: 22, hitR: 34, single: [null, null], plain: true });
  K(cx[0], r2, 'DIR<br>INTC', 'dir_intc'); K(cx[1], r2, 'LEGS', 'legs'); K(cx[2], r2, 'DEP<br>ARR', 'dep_arr');
  K(cx[3], r2, 'HOLD', 'hold'); K(cx[4], r2, 'PROG', 'prog');
  items.push({ t: 'execbar', x: 652, y: r2 - 30 });
  K(652, r2 + 6, 'EXEC', 'exec');
  K(cx[0], r3, 'FIX', 'fix'); K(cx[1], r3, 'NAV<br>RAD', 'navrad');
  K(cx[0], r4, 'PREV<br>PAGE', 'prev'); K(cx[1], r4, 'NEXT<br>PAGE', 'next');
  items.push({ t: 'panel', x: 72, y: r1 - 32, w: 486, h: 2 * 58 + 6 }, { t: 'panel', x: 72, y: r3 - 30, w: 190, h: 2 * 60 });
  keypad(items, P, 98, r3 + 2 * 60, 60);
  alphaPad(items, P, 336, r3, 60, [['Z', 'key_Z'], ['SP', 'key_space'], ['DEL', 'key_delete'], ['/', 'key_slash'], ['CLR', 'key_clear']]);
  items.push({ t: 'slotlight', x: 30, y: 760, h: 170, txt: 'CALL&nbsp;&nbsp;FAIL' }, { t: 'slotlight', x: 770, y: 760, h: 170, txt: 'MSG&nbsp;&nbsp;OFST' });
  return { w: 800, h: 1062, items };
}

// ToLiss names its MCDU commands differently (AirbusFBW/MCDU1LSK1L, …/MCDU1KeyA, …) – read from the ToLiss plugin
const TLCMD = { key_period: 'KeyDecimal', key_minus: 'KeyPM', key_slash: 'KeySlash', key_space: 'KeySpace', key_overfly: 'KeyOverfly',
  key_clear: 'KeyClear', dir_intc: 'DirTo', prog: 'Prog', perf: 'Perf', index: 'Init', data: 'Data', fpln: 'Fpln', navrad: 'RadNav',
  fuel_pred: 'FuelPred', sec_fpln: 'SecFpln', atc_comm: 'ATC', menu: 'Menu', airport: 'Airport', prev: 'SlewLeft', next: 'SlewRight',
  up: 'SlewUp', down: 'SlewDown', brt: 'KeyBright', dim: 'KeyDim' };
function tlCmd(c) {
  let m;
  if ((m = /^ls_(\d)([lr])$/.exec(c))) return 'LSK' + m[1] + m[2].toUpperCase();
  if ((m = /^key_([A-Z0-9])$/.exec(c))) return 'Key' + m[1];
  return TLCMD[c] || c;
}
function mcduAirbus(P, tl) {
  // Airbus A320-family MCDU, measured from a photo of a real unit (housing 693 x 1083 px -> 800 x 1250 units).
  // Mid-grey housing, matt black keys with white lettering, raised frame around the function keys.
  const items = [];
  const cmdOf = (c) => !c ? null : tl ? P + tlCmd(c) : (c === 'brt' || c === 'dim') ? null : P + c;
  const K = (x, y, html, cmd, w = 76, h = 48, cls = 'fn') => items.push({ t: 'key', x, y, w, h, html, cmd: cmdOf(cmd), cls });
  // front plate (raised) over a lower outer flange; round cut-outs around the 6 mounting holes,
  // stepped lower corners and a side step that kinks at AIRPORT height – traced from the photo
  const FP = 'M0 0 H800 V62 H766 A28 28 0 0 0 766 118 H800 V619 H755 Q745 619 745 629 V688 Q745 698 755 698 H800 V755 C800 775 788 770 788 790 V1135 H748 Q742 1135 742 1141 V1230 Q742 1236 736 1236 ' +
             'H64 Q58 1236 58 1230 V1141 Q58 1135 52 1135 H12 V790 C12 770 0 775 0 755 V698 H45 Q55 698 55 688 V629 Q55 619 45 619 H0 V118 H34 A28 28 0 0 0 34 62 H0 Z';
  // raised block around the function keys + AIRPORT/arrow keys (~4 mm proud)
  const PL = 'M92 584 H676 Q682 584 682 590 V716 Q682 722 676 722 H295 Q289 722 289 728 V918 Q289 924 283 924 H98 Q92 924 92 918 V590 Q92 584 98 584 Z';
  items.push({ t: 'svg', html:
    '<defs><linearGradient id="fpg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6a737a"/><stop offset=".55" stop-color="#5f686f"/><stop offset="1" stop-color="#535b62"/></linearGradient>' +
    '<linearGradient id="plg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#707a81"/><stop offset="1" stop-color="#626b72"/></linearGradient>' +
    // SVG filters (Safari ignores CSS filter on SVG shapes, so the relief must come from real SVG filters)
    '<filter id="fpSh" x="-5%" y="-5%" width="110%" height="112%"><feDropShadow dx="0" dy="2" stdDeviation=".6" flood-color="#000" flood-opacity=".55"/><feDropShadow dx="0" dy="4" stdDeviation="2.5" flood-color="#000" flood-opacity=".35"/></filter>' +
    '<filter id="wallSh" x="-5%" y="-5%" width="110%" height="120%"><feDropShadow dx="0" dy="5" stdDeviation="2.5" flood-color="#000" flood-opacity=".6"/><feDropShadow dx="0" dy="1" stdDeviation=".6" flood-color="#000" flood-opacity=".7"/></filter>' +
    '<filter id="topHi" x="-5%" y="-5%" width="110%" height="110%"><feDropShadow dx="0" dy="-2" stdDeviation="0" flood-color="#fff" flood-opacity=".34"/><feDropShadow dx="-1" dy="0" stdDeviation="0" flood-color="#fff" flood-opacity=".12"/></filter></defs>' +
    `<path d="${FP}" fill="url(#fpg)" class="fp" filter="url(#fpSh)"/>` +
    `<path d="${PL}" transform="translate(0 7)" class="pl-wall" filter="url(#wallSh)"/>` +
    `<path d="${PL}" fill="url(#plg)" class="pl-top" filter="url(#topHi)"/>` });
  [[767, 90], [31, 652], [769, 652], [32, 1172], [768, 1172]].forEach(([x, y]) => items.push({ t: 'hole', x, y }));   // top-left hole -> MENU key
  for (let i = 0; i < 5; i++) items.push({ t: 'oval', x: 194 + i * 103, y: 31 });
  items.push({ t: 'mbezel', x: 88, y: 77, w: 625, h: 459 });   // slope: 21 top/bottom, 31 sides (photo)
  // line select keys on ledges + white tick marks
  // keys point at the data rows 2,4,…,12 of the 14-row MCDU page
  [0, 1, 2, 3, 4, 5].map((i) => Math.round(98 + (2 * i + 2.5) * 417 / 14)).forEach((y, i) => {
    items.push({ t: 'ledge', x: 6, y: y + 22, w: 78 }, { t: 'ledge', x: 716, y: y + 22, w: 78 });
    items.push({ t: 'lsktick', x: 95, y, w: 18 }, { t: 'lsktick', x: 688, y, w: 18 });
    K(46, y, '<i class="dash"></i>', 'ls_' + (i + 1) + 'l', 51, 35, 'lsk');
    K(755, y, '<i class="dash"></i>', 'ls_' + (i + 1) + 'r', 51, 35, 'lsk');
  });
  items.push({ t: 'slotlight', x: 43, y: 846, h: 228, txt: '' }, { t: 'slotlight', x: 757, y: 846, h: 228, txt: '' });
  // plastic surface: gaussian-like grain, light fall-off from above, greasy hand-worn sheen
  items.push({ t: 'grain' }, { t: 'grease', zones: [[400, 1000, 380, 300, .11], [400, 700, 330, 110, .07], [190, 830, 120, 130, .08], [400, 1236, 360, 40, .09], [46, 320, 50, 200, .05], [755, 320, 50, 200, .05]] });
  items.push({ t: 'screen', x: 119, y: 98, w: 562, h: 417, fit: 'contain' });
  [[32, 27], [768, 27], [29, 575], [771, 575], [44, 1099], [756, 1099]].forEach(([x, y], i) => items.push({ t: 'screw', x, y, r: 20 + i * 37 }));
  // function keys
  const cx = [134, 232, 331, 430, 529, 627], r1 = 613, r2 = 685;
  K(cx[0], r1, 'DIR', 'dir_intc'); K(cx[1], r1, 'PROG', 'prog'); K(cx[2], r1, 'PERF', 'perf');
  K(cx[3], r1, 'INIT', 'index'); K(cx[4], r1, 'DATA', 'data'); K(cx[5], r1, '', null);
  K(cx[0], r2, 'F-PLN', 'fpln'); K(cx[1], r2, 'RAD<br>NAV', 'navrad'); K(cx[2], r2, 'FUEL<br>PRED', 'fuel_pred');
  K(cx[3], r2, 'SEC<br>F-PLN', 'sec_fpln'); K(cx[4], r2, 'ATC<br>COMM', 'atc_comm'); K(cx[5], r2, 'MCDU<br>MENU', 'menu');
  K(704, r1 + 2, 'BRT', 'brt', 40, 52, 'fn tiny brt'); K(704, r2, 'DIM', 'dim', 40, 52, 'fn tiny dim');
  // AIRPORT + slew keys
  K(cx[0], 756, 'AIR<br>PORT', 'airport'); K(cx[1], 756, '', null);
  K(cx[0], 827, '<svg width="36" height="20" viewBox="0 0 36 20"><path d="M2 10 L13 3 V8 H34 V12 H13 V17 Z" fill="currentColor"/></svg>', 'prev'); K(cx[1], 827, '<svg width="20" height="34" viewBox="0 0 20 36"><path d="M10 2 L3 13 H8 V34 H12 V13 H17 Z" fill="currentColor"/></svg>', 'up');
  K(cx[0], 898, '<svg width="36" height="20" viewBox="0 0 36 20"><path d="M34 10 L23 3 V8 H2 V12 H23 V17 Z" fill="currentColor"/></svg>', 'next'); K(cx[1], 898, '<svg width="20" height="34" viewBox="0 0 20 36"><path d="M10 34 L3 23 H8 V2 H12 V23 H17 Z" fill="currentColor"/></svg>', 'down');
  // numeric pad (round)
  const num = [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['.', '0', '+/-']];
  const ncmd = { '.': 'key_period', '+/-': 'key_minus' };
  num.forEach((row, r) => row.forEach((k, c) => K([124, 202, 280][c], 970 + r * 72, k === '.' ? '<b class="dot"></b>' : k === '+/-' ? '<span class="pm">+/<u>&nbsp;</u></span>' : k,
    ncmd[k] || 'key_' + k, 50, 50, 'round num')));
  // alpha pad
  const ax = [360, 439, 517, 596, 674];
  ALPHA.forEach((k, i) => K(ax[i % 5], 787 + Math.floor(i / 5) * 79, BOXED[k] ? `<b class="boxed">${k}</b>` : k, 'key_' + k, 54, 54, 'alpha'));
  [['Z', 'key_Z'], ['/', 'key_slash'], ['SP', 'key_space'], ['<small>OVFY</small><br>△', 'key_overfly'], ['CLR', 'key_clear']]
    .forEach(([h, c], i) => K(ax[i], 1182, h, c, 54, 54, 'alpha' + (i > 1 ? ' small' : '')));
  return { w: 800, h: 1250, items };
}

// ---------------------------------------------------------------- rendering
// native display resolution of the real units (Garmin / SEA spec sheets) for the "real pixels" option
const NATIVE = { gns530: [320, 234], gns430: [240, 128] };

// builds one instrument into its own .panel element; returns its screen + size
function buildPanel(dev, root) {
  root.innerHTML = '';
  root.dataset.kind = dev.kind;
  let screenEl = null, imgEl = null, canvasEl = null, textEl = null;
  const b737 = /737|b738/i.test((status && (status.acf + ' ' + status.aircraft)) || '');
  const def = dev.kind === 'g1000' ? g1000(dev.prefix) : dev.kind === 'gns530' ? gns530(dev.prefix)
    : dev.kind === 'gns430' ? gns430(dev.prefix) : dev.kind === 'mcdu' ? mcduAirbus(dev.prefix, /^tl_/.test(dev.key)) : cduBoeing(dev.prefix, b737);
  if (dev.kind.startsWith('gns')) def.items.forEach((it) => { if (it.t === 'knob') it.gns = true; });
  root.style.width = def.w + 'px';
  root.style.height = def.h + 'px';
  const bz = el('div', 'bz');
  bz.style.cssText = `left:0;top:0;width:${def.w}px;height:${def.h}px`;
  root.appendChild(bz);

  for (const it of def.items) {
    const id = dev.key + ':' + it.t + ':' + it.x + ':' + it.y;
    switch (it.t) {
      case 'recess': case 'slot': case 'pocket': case 'strip': {
        const e = el('div', it.t); box(e, it.x, it.y, it.w, it.h); root.appendChild(e); break;
      }
      case 'screen': {
        const e = el('div', 'screen' + (it.fit === 'contain' ? ' contain' : '')); box(e, it.x, it.y, it.w, it.h);
        e.innerHTML = (dev.text ? '<div class="ftext"></div>' : '<img alt=""><canvas></canvas>') + `<div class="wait">${T.wait}</div><div class="glass"></div>`;
        root.appendChild(e); screenEl = e; imgEl = e.querySelector('img'); canvasEl = e.querySelector('canvas'); textEl = e.querySelector('.ftext'); if (textEl) buildText(textEl); break;
      }
      case 'screw': {
        const e = el('div', 'screw'); pos(e, it.x, it.y); e.style.setProperty('--r', it.r + 'deg'); root.appendChild(e); break;
      }
      case 'cell': {
        const e = el('div', 'cell ' + (it.cls || '')); pos(e, it.x, it.y); e.style.width = e.style.height = it.r * 2 + 'px'; root.appendChild(e); break;
      }
      case 'lsktick': { const e = el('div', 'lsktick'); e.style.cssText = `left:${it.x}px;top:${it.y}px;width:${it.w}px`; root.appendChild(e); break; }
      case 'panel': { const e = el('div', 'fmspanel'); box(e, it.x, it.y, it.w, it.h); root.appendChild(e); break; }
      case 'execbar': { const e = el('div', 'execbar'); pos(e, it.x, it.y); root.appendChild(e); break; }
      case 'oval': { const e = el('div', 'oval'); pos(e, it.x, it.y); root.appendChild(e); break; }
      case 'grain': { const e = el('div', 'grain'); box(e, 0, 0, def.w, def.h); root.appendChild(e); break; }
      case 'grease': root.appendChild(grease(def, it.zones, dev.key)); break;
      case 'hole': { const e = el('div', 'hole'); pos(e, it.x, it.y); root.appendChild(e); break; }
      case 'ledge': { const e = el('div', 'ledge'); e.style.cssText = `left:${it.x}px;top:${it.y}px;width:${it.w}px`; root.appendChild(e); break; }
      case 'mbezel': { const e = el('div', 'mbezel'); box(e, it.x, it.y, it.w, it.h); root.appendChild(e); break; }
      case 'svg': { const e = el('div'); e.innerHTML = `<svg class="deco" width="${def.w}" height="${def.h}">${it.html}</svg>`; root.appendChild(e.firstChild); break; }
      case 'collar': { const e = el('div', 'collar' + (it.round ? ' round' : '')); pos(e, it.x, it.y); e.style.width = it.w + 'px'; e.style.height = it.h + 'px'; root.appendChild(e); break; }
      case 'slotlight': {
        const e = el('div', 'slotlight'); e.style.cssText = `left:${it.x}px;top:${it.y}px;height:${it.h}px`;
        e.innerHTML = `<span>${it.txt}</span>`; root.appendChild(e); break;
      }
      case 'tick': { const e = el('div', 'tick'); e.style.left = it.x + 'px'; e.style.top = it.y + 'px'; root.appendChild(e); break; }
      case 'lbl': {
        const e = el('div', 'lbl ' + it.cls); pos(e, it.x, it.y); e.innerHTML = it.html;
        const q = rnd(id); e.style.webkitMaskPosition = e.style.maskPosition = `${(q() * 200) | 0}px ${(q() * 200) | 0}px`;
        root.appendChild(e); break;
      }
      case 'bracket': {
        const e = el('div'); e.style.cssText = `position:absolute;left:${it.x}px;top:${it.y1}px;width:10px;height:${it.y2 - it.y1}px;border:1.5px solid var(--ink);border-left:none;opacity:.6`;
        root.appendChild(e); break;
      }
      case 'arcs': root.appendChild(arcs(it)); break;
      case 'key': root.appendChild(makeKey(it, id)); break;
      case 'knob': root.appendChild(makeKnob(it, id)); break;
      case 'rockerV': case 'rockerH': root.appendChild(makeRocker(it, id)); break;
    }
  }
  // small MENU key top-left on every unit (opens the settings bar) – styled like the unit's own keys
  // (MCDU: round key in place of the top-left mounting hole; others: bottom-left corner, away from the iOS status bar)
  const MK = { g1000: [168, def.h - 26, 54, 22, ''], gns530: [44, def.h - 24, 54, 22, ''], gns430: [44, def.h - 22, 54, 20, ''],
               mcdu: [33, 90, 30, 30, ' round'], cdu: [110, def.h - 26, 58, 24, ''] }[dev.kind];
  if (MK) root.appendChild(makeKey({ x: MK[0], y: MK[1], w: MK[2], h: MK[3], html: T.menuKey, cls: 'menukey fn tiny' + MK[4], menu: true }, dev.key + ':menu'));
  // night: one darkening layer over the housing (keys, labels, knobs and screen sit above it)
  root.appendChild(el('div', 'night'));
  root.insertBefore(scuffs(def, dev.kind), bz.nextSibling);
  return { dev, screenEl, imgEl, canvasEl, textEl, w: def.w, h: def.h, el: root };
}

// lays out one or two instruments: portrait = stacked like in the panel, landscape = side by side.
// Two GNS units are drawn to the same real-world scale (both are 6.25" wide).
const GAP = 28;
function layout(devs) {
  const root = $('#bezel');
  root.innerHTML = '';
  delete root.dataset.empty;
  root.dataset.kind = devs.length === 1 ? devs[0].kind : 'multi';
  const built = devs.map((dev) => {
    const p = el('div', 'panel');
    root.appendChild(p);
    const b = buildPanel(dev, p);
    b.el = p;
    return b;
  });
  // common width for stacked GNS units: scale each to the widest design width
  const W = Math.max(...built.map((b) => b.w));
  const vertical = built.length > 1 && portrait();
  let x = 0, y = 0, totW = 0, totH = 0;
  for (const b of built) {
    const k = built.length > 1 ? W / b.w : 1;
    b.k = k;
    b.el.dataset.k = k;
    b.el.style.cssText = `left:${x}px;top:${y}px;width:${b.w}px;height:${b.h}px;transform:scale(${k})`;
    const bw = b.w * k, bh = b.h * k;
    if (vertical) { y += bh + GAP; totW = Math.max(totW, bw); totH = y - GAP; }
    else { x += bw + GAP; totW = x - GAP; totH = Math.max(totH, bh); }
  }
  // centre the smaller unit in side-by-side mode
  if (!vertical && built.length > 1) for (const b of built) b.el.style.top = (totH - b.h * b.k) / 2 + 'px';
  root.style.width = totW + 'px';
  root.style.height = totH + 'px';
  fit();
  return built;
}

// scratches, rub marks around knobs, worn print – deterministic per instrument type
function scuffs(def, seed) {
  const r = rnd('wear' + seed);
  const W = def.w, H = def.h;
  let s = `<svg width="${W}" height="${H}" style="position:absolute;left:0;top:0;pointer-events:none">`;
  s += '<defs><radialGradient id="rub"><stop offset="55%" stop-color="#fff" stop-opacity="0"/><stop offset="78%" stop-color="#fff" stop-opacity=".05"/><stop offset="100%" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>';
  // finger rub halos around knobs
  for (const it of def.items) if (it.t === 'knob') s += `<circle cx="${it.x + (r() - .5) * 4}" cy="${it.y + 2}" r="${it.r * (it.gns ? 1.3 : 1.55)}" fill="url(#rub)"/>`;
  // fine scratches, mostly near the edges and below the knobs
  for (let i = 0; i < (seed === 'mcdu' ? 0 : 46); i++) {
    const edge = r() < .65;
    let x = r() * W, y = r() * H;
    if (edge) { if (r() < .5) x = r() < .5 ? r() * 230 : W - r() * 230; else y = r() < .5 ? r() * 40 : H - r() * 60; }
    const a = r() * Math.PI, len = 6 + r() * 38, w = .5 + r() * .9, o = .04 + r() * .09;
    s += `<path d="M${x.toFixed(1)} ${y.toFixed(1)} q${(Math.cos(a) * len / 2 + (r() - .5) * 4).toFixed(1)} ${(Math.sin(a) * len / 2 + (r() - .5) * 4).toFixed(1)} ${(Math.cos(a) * len).toFixed(1)} ${(Math.sin(a) * len).toFixed(1)}" stroke="#fff" stroke-opacity="${o.toFixed(3)}" stroke-width="${w.toFixed(2)}" fill="none" stroke-linecap="round"/>`;
  }
  // a few darker dings
  for (let i = 0; i < (seed === 'mcdu' ? 0 : 10); i++) s += `<circle cx="${(r() * W).toFixed(1)}" cy="${(r() * H).toFixed(1)}" r="${(.6 + r() * 1.4).toFixed(2)}" fill="#000" fill-opacity="${(.25 + r() * .3).toFixed(2)}"/>`;
  s += '</svg>';
  const e = el('div'); e.innerHTML = s; return e.firstChild;
}

// greasy, hand-polished sheen: low-frequency blotches masked to the zones where hands touch the unit
function grease(def, zones, seed) {
  const r = rnd('grease' + seed), W = def.w, H = def.h;
  let m = '';
  zones.forEach(([x, y, rx, ry, o], i) => { m += `<radialGradient id="gz${i}"><stop offset="0" stop-color="#fff" stop-opacity="${o * 6}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient><ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="url(#gz${i})"/>`; });
  let s = `<svg class="deco grease" width="${W}" height="${H}"><defs>` +
    `<filter id="gzf" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".035 .05" numOctaves="4" seed="${(r() * 99) | 0}"/>` +
    '<feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  2.2 0 0 0 -1"/></filter>' +
    `<mask id="gzm">${m}</mask>` +
    '<linearGradient id="lfall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".07"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".16"/></linearGradient>' +
    '<radialGradient id="lspot" cx=".35" cy=".18" r=".7"><stop offset="0" stop-color="#fff" stop-opacity=".06"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>' +
    `<rect width="${W}" height="${H}" fill="url(#lfall)"/><rect width="${W}" height="${H}" fill="url(#lspot)"/>` +
    `<rect width="${W}" height="${H}" filter="url(#gzf)" mask="url(#gzm)" opacity=".28"/>`;
  // dings and small chips (no scratch lines): lighter chipped plastic with a dark lower lip
  for (let i = 0; i < 34; i++) {
    const edge = r() < .55;
    let x = r() * W, y = r() * H;
    if (edge) { if (r() < .5) x = r() < .5 ? 4 + r() * 40 : W - 4 - r() * 40; else y = r() < .4 ? 4 + r() * 30 : H - 6 - r() * 40; }
    const rx = .7 + r() * 1.8, ry = rx * (.5 + r() * .6), a = (r() * 180) | 0;
    s += `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${a})"><ellipse cx="0" cy=".7" rx="${rx.toFixed(2)}" ry="${ry.toFixed(2)}" fill="#000" fill-opacity=".35"/>` +
         `<ellipse rx="${rx.toFixed(2)}" ry="${ry.toFixed(2)}" fill="#c9d0d5" fill-opacity="${(.18 + r() * .25).toFixed(2)}"/></g>`;
  }
  s += '</svg>';
  const e = el('div'); e.innerHTML = s; return e.firstChild;
}

function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function pos(e, x, y) { e.style.left = x + 'px'; e.style.top = y + 'px'; }
function box(e, x, y, w, h) { e.style.left = x + 'px'; e.style.top = y + 'px'; e.style.width = w + 'px'; e.style.height = h + 'px'; }

function wear(e, id) {
  const r = rnd(id);
  e.style.setProperty('--wa', (0.02 + r() * 0.07).toFixed(3));
  e.style.setProperty('--wb', (0.02 + r() * 0.06).toFixed(3));
  e.style.setProperty('--pol', (0.03 + r() * 0.06).toFixed(3));
  e.style.setProperty('--px', (40 + r() * 20).toFixed(1) + '%');
  e.style.setProperty('--py', (45 + r() * 20).toFixed(1) + '%');
  e.style.setProperty('--ink-op', (0.78 + r() * 0.17).toFixed(2));
  e.style.setProperty('--mx', ((r() * 200) | 0) + 'px');
  e.style.setProperty('--my', ((r() * 200) | 0) + 'px');
}

function arcs(it) {
  const s = it.r * 2 + 20, c = s / 2, r = it.r;
  const p = (a) => [c + r * Math.cos(a * Math.PI / 180), c + r * Math.sin(a * Math.PI / 180)];
  const [x1, y1] = p(-150), [x2, y2] = p(-105), [x3, y3] = p(-75), [x4, y4] = p(-30);
  const e = el('div');
  e.style.cssText = `position:absolute;left:${it.x - c}px;top:${it.y - c}px;width:${s}px;height:${s}px;pointer-events:none;color:var(--ink);opacity:.85`;
  e.innerHTML = `<svg width="${s}" height="${s}"><defs><marker id="ah" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto"><path d="M0 0L6 3L0 6z" fill="currentColor"/></marker></defs>
    <path d="M${x2} ${y2} A${r} ${r} 0 0 0 ${x1} ${y1}" stroke="currentColor" stroke-width="2" fill="none" marker-end="url(#ah)"/>
    <path d="M${x3} ${y3} A${r} ${r} 0 0 1 ${x4} ${y4}" stroke="currentColor" stroke-width="2" fill="none" marker-end="url(#ah)"/></svg>`;
  return e;
}

// ---------------------------------------------------------------- keys
function makeKey(it, id) {
  const e = el('div', 'key ' + (it.cls || ''));
  box(e, it.x, it.y, it.w, it.h);
  e.innerHTML = `<i class="kdim"></i><span>${it.html}</span>`;
  wear(e, id);
  let timer = null, began = false, active = false;
  if (it.menu) {
    e.addEventListener('pointerdown', (ev) => { ev.preventDefault(); e.classList.add('down'); click(); });
    e.addEventListener('pointerup', () => { e.classList.remove('down'); toggleBar(); });
    e.addEventListener('pointercancel', () => e.classList.remove('down'));
    return e;
  }
  e.addEventListener('pointerdown', (ev) => {
    ev.preventDefault(); e.setPointerCapture(ev.pointerId);
    active = true; began = false; e.classList.add('down'); click();
    timer = setTimeout(() => { began = true; send(it.cmd, 'begin'); }, HOLD_MS);
  });
  const up = () => {
    if (!active) return; active = false;
    clearTimeout(timer); e.classList.remove('down');
    if (began) send(it.cmd, 'end'); else send(it.cmd, 'once');
  };
  e.addEventListener('pointerup', up);
  e.addEventListener('pointercancel', up);
  return e;
}

function makeRocker(it, id) {
  const vertical = it.t === 'rockerV';
  const wrap = el('div');
  wrap.style.cssText = `position:absolute;left:${it.x}px;top:${it.y}px;width:0;height:0`;
  const mk = (html, cmd, dx, dy, w, h) => {
    const k = makeKey({ x: dx, y: dy, w, h, html, cmd, cls: 'soft' }, id + html);
    wrap.appendChild(k); return k;
  };
  if (vertical) {
    // one tall key, split in two touch halves; RNG printed in the middle
    const k = el('div', 'key'); box(k, 0, 0, it.w, it.h); wear(k, id); k.style.flexDirection = 'column';
    k.style.justifyContent = 'space-between'; k.style.padding = '10px 0';
    k.innerHTML = `<span>${SVG.triUp}</span><span style="font-size:14px">RNG</span><span>${SVG.triDn}</span>`;
    wrap.appendChild(k);
    k.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      const r = k.getBoundingClientRect();
      const upper = ev.clientY < r.top + r.height / 2;
      k.classList.add('down'); click();
      k.style.transform = `translate(-50%,-50%) perspective(200px) rotateX(${upper ? 6 : -6}deg)`;
      send(upper ? it.up : it.dn);
    });
    const rel = () => { k.classList.remove('down'); k.style.transform = ''; };
    k.addEventListener('pointerup', rel); k.addEventListener('pointercancel', rel); k.addEventListener('pointerleave', rel);
  } else {
    const w = it.w / 3;
    mk(SVG.triDn, it.dn, -w, 0, w - 4, it.h);
    const mid = el('div', 'key'); box(mid, 0, 0, w - 4, it.h); mid.innerHTML = '<span>RNG</span>'; wear(mid, id + 'm');
    mid.style.pointerEvents = 'none'; wrap.appendChild(mid);
    mk(SVG.triUp, it.up, w, 0, w - 4, it.h);
  }
  return wrap;
}

// ---------------------------------------------------------------- knobs
function makeKnob(it, id) {
  const dual = !!it.ri;
  const R = it.r;
  const e = el('div', 'knob');
  pos(e, it.x, it.y);
  const hitR = Math.max(R * 1.45, it.hitR || 0);
  const hit = el('div', 'hit'); hit.style.width = hit.style.height = hitR * 2 + 'px';
  e.appendChild(hit);

  const ring = el('div', 'ring'); ring.style.width = ring.style.height = R * 2 + 'px';
  ring.innerHTML = '<div class="knurl"></div><div class="shade"></div>';
  let cap = null;
  if (it.gns) {
    // Garmin GNS style, top view: matte flat tops, coarse ribs show as notches on the rim
    const ribs = (el2, n, tooth) => { el2.classList.add('gnsk'); el2.style.setProperty('--tp', (360 / n) + 'deg'); el2.style.setProperty('--tooth', tooth + 'px'); };
    if (dual) {
      ribs(ring, 30, 6); e.appendChild(ring);
      cap = el('div', 'cap'); cap.style.width = cap.style.height = it.ri * 2 + 'px';
      cap.innerHTML = '<div class="knurl"></div><div class="shade"></div>';
      ribs(cap, 22, 4.5); e.appendChild(cap);
    } else {
      cap = el('div', 'cap'); cap.style.width = cap.style.height = R * 2 + 'px';
      cap.innerHTML = `<div class="knurl"></div><div class="shade"></div><div class="face gtxt" style="font-size:${Math.max(11, R * 0.62)}px">${it.capText || ''}</div>`;
      ribs(cap, 16, 2.5); e.appendChild(cap);
    }
  } else if (dual) {
    e.appendChild(ring);
    cap = el('div', 'cap'); cap.style.width = cap.style.height = it.ri * 2 + 'px';
    cap.innerHTML = `<div class="knurl"></div><div class="shade"></div><div class="face"${it.plain ? ' style="width:56%;height:56%"' : ''}><div class="rot"></div>${it.capText || ''}</div>`;
    e.appendChild(cap);
  } else {
    // single knob: knurled skirt + face (rendered as a cap)
    cap = el('div', 'cap'); cap.style.width = cap.style.height = R * 2 + 'px';
    cap.innerHTML = `<div class="knurl"></div><div class="shade"></div><div class="face" style="width:${it.plain ? 50 : 72}%;height:${it.plain ? 50 : 72}%;font-size:${Math.max(11, R * 0.5)}px"><div class="rot"></div>${it.capText || ''}</div>`;
    e.appendChild(cap);
  }
  if (it.knurlFine) e.querySelectorAll('.knurl').forEach((k) => k.style.background =
    'repeating-conic-gradient(from 0deg, #141415 0deg 2.4deg, #2f3033 2.4deg 4.2deg, #1d1e20 4.2deg 5.4deg)');

  // rotation state per part (purely visual)
  const rot = { outer: 0, inner: 0 };
  const turnVisual = (part, deg) => {
    rot[part] += deg;
    const tgt = part === 'outer' && dual ? ring : cap;
    tgt.querySelector('.knurl').style.transform = `rotate(${rot[part]}deg)`;
    const r2 = tgt.querySelector('.rot'); if (r2) r2.style.transform = `rotate(${rot[part]}deg)`;
  };
  const cmds = (part) => (dual ? it[part] : it.single);

  let st = null;
  const centre = () => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };

  e.addEventListener('pointerdown', (ev) => {
    ev.preventDefault(); e.setPointerCapture(ev.pointerId);
    const [cx, cy] = centre();
    const scale = currentScale * parseFloat(e.closest('.panel')?.dataset.k || 1);
    const d = Math.hypot(ev.clientX - cx, ev.clientY - cy) / scale;
    const part = dual ? (d > it.ri * 1.12 ? 'outer' : 'inner') : 'outer';
    st = { cx, cy, part, a: Math.atan2(ev.clientY - cy, ev.clientX - cx), acc: 0, moved: 0, t0: performance.now(),
           x0: ev.clientX, y0: ev.clientY, pan: false, panTimer: null, panDir: null, panRep: null };
    e.classList.add('active');
    (part === 'outer' && dual ? ring : cap).classList.add('on');
    if (it.pan) {
      st.panTimer = setTimeout(() => { if (st && st.moved < 8) { st.pan = true; e.classList.add('pushed'); click(.6); } }, 380);
    }
  });

  e.addEventListener('pointermove', (ev) => {
    if (!st) return;
    st.moved = Math.max(st.moved, Math.hypot(ev.clientX - st.x0, ev.clientY - st.y0));
    if (st.pan) { // joystick
      const dx = ev.clientX - st.x0, dy = ev.clientY - st.y0;
      let dir = null;
      if (Math.hypot(dx, dy) > 22) {
        const a = (Math.atan2(dy, dx) * 180 / Math.PI + 360 + 22.5) % 360;
        dir = ['right', 'down_right', 'down', 'down_left', 'left', 'up_left', 'up', 'up_right'][Math.floor(a / 45)];
      }
      if (dir !== st.panDir) {
        st.panDir = dir; clearInterval(st.panRep);
        if (dir) { send(it.pan + dir); st.panRep = setInterval(() => send(it.pan + dir), 160); }
      }
      return;
    }
    const a = Math.atan2(ev.clientY - st.cy, ev.clientX - st.cx);
    let da = (a - st.a) * 180 / Math.PI;
    if (da > 180) da -= 360; if (da < -180) da += 360;
    // ignore wild jumps when the finger passes over the centre
    const dc = Math.hypot(ev.clientX - st.cx, ev.clientY - st.cy);
    st.a = a;
    if (dc < 8) return;
    st.acc += da;
    turnVisual(st.part, da);
    const [upCmd, dnCmd] = cmds(st.part);
    while (st.acc >= DETENT) { st.acc -= DETENT; queueStep(upCmd); click(.55); }
    while (st.acc <= -DETENT) { st.acc += DETENT; queueStep(dnCmd); click(.55); }
  });

  const end = () => {
    if (!st) return;
    clearTimeout(st.panTimer); clearInterval(st.panRep);
    const tap = !st.pan && st.moved < 10 && performance.now() - st.t0 < 450;
    if (tap && it.push) {
      e.classList.add('pushed'); click(); send(it.push);
      setTimeout(() => e.classList.remove('pushed'), 220);
    }
    if (st.pan) e.classList.remove('pushed');
    e.classList.remove('active'); ring.classList.remove('on'); cap.classList.remove('on');
    st = null;
  };
  e.addEventListener('pointerup', end);
  e.addEventListener('pointercancel', end);

  // mouse wheel (desktop testing): plain wheel = outer, shift+wheel = inner
  e.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const part = dual && ev.shiftKey ? 'inner' : 'outer';
    const dir = ev.deltaY < 0 ? 0 : 1;
    queueStep(cmds(part)[dir]); turnVisual(part, dir ? -DETENT : DETENT); click(.55);
  }, { passive: false });
  return e;
}

// ---------------------------------------------------------------- scale to viewport
let currentScale = 1;
function fit() {
  const root = $('#bezel');
  const w = parseFloat(root.style.width), h = parseFloat(root.style.height);
  if (!w) return;
  const vw = window.innerWidth, vh = window.innerHeight;
  const s = Math.min(vw / w, vh / h) * 0.985;
  currentScale = s;
  root.style.transform = `scale(${s})`;
  const wrap = $('#bezel-wrap');
  wrap.style.width = w * s + 'px'; wrap.style.height = h * s + 'px';
}
window.addEventListener('resize', () => {
  fit();
  if (!status) return;
  if (opts.auto && !manualPick) { const k = pickAuto(); if (k && k !== current) { show(k); return; } }
  // two units: re-stack when the tablet is turned (portrait = above each other, landscape = side by side)
  if (current && current.includes('+') && portrait() !== layoutPortrait) show(current, false, true);
});
window.addEventListener('orientationchange', () => setTimeout(fit, 250));

// ---------------------------------------------------------------- frame stream (long-poll)
let streamGen = 0;
async function stream(p, gen) {
  if (p.dev.text) return textStream(p, gen);
  const key = p.dev.key;
  let seq = 0, frames = 0, t0 = performance.now();
  let lastUrl = null;
  const native = NATIVE[p.dev.kind];
  while (gen === streamGen) {
    try {
      const r = await fetch(`/frame/${key}?after=${seq}`, { cache: 'no-store' });
      if (gen !== streamGen) break;
      if (r.status === 200) {
        seq = parseInt(r.headers.get('X-Seq') || '0', 10);
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const pre = new Image(); pre.src = url;
        try { await pre.decode(); } catch (e) {}
        if (gen !== streamGen) { URL.revokeObjectURL(url); break; }
        const pixel = !!(opts.pixel && native);
        p.screenEl.classList.toggle('pixel', pixel);
        if (pixel) {
          // reduce to the real unit's resolution, then show it enlarged without smoothing
          const c = p.canvasEl;
          if (c.width !== native[0] || c.height !== native[1]) { c.width = native[0]; c.height = native[1]; }
          const ctx = c.getContext('2d');
          ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'medium';
          ctx.drawImage(pre, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
        } else {
          p.imgEl.src = url;
          if (lastUrl) URL.revokeObjectURL(lastUrl);
          lastUrl = url;
        }
        p.screenEl.classList.add('live');
        frames++;
        const now = performance.now();
        if (now - t0 > 2000) { streamFps = frames * 1000 / (now - t0); frames = 0; t0 = now; }
      } else if (r.status === 204) {
        streamFps = 0;
        p.screenEl.classList.remove('live');
      } else {
        await sleep(1000);
      }
    } catch (e) {
      p.screenEl && p.screenEl.classList.remove('live');
      await sleep(1000);
    }
  }
}
// add-on MCDU text: 14 rows x 24 cells, colour + small/large per cell (from /text/<key>)
function buildText(box) {
  box.innerHTML = '';
  for (let r = 0; r < 14; r++) {
    const row = el('div', 'frow');
    for (let i = 0; i < 24; i++) row.appendChild(el('span'));
    box.appendChild(row);
  }
}
function renderText(p, j) {
  const rows = p.textEl.children;
  j.lines.forEach((ln, r) => {
    const cells = rows[r].children, t = [...ln.t];
    for (let i = 0; i < 24; i++) {
      const f = ln.f ? parseInt(ln.f[i] || '0', 16) : 0;
      const c = cells[i], ch = t[i] || ' ', cls = 'c' + (ln.c[i] || 'w') + (ln.s[i] === 'S' ? ' sm' : '') + (f & 1 ? ' rv' : '') + (f & 2 ? ' fl' : '') + (f & 4 ? ' ul' : '');
      if (c.textContent !== ch) c.textContent = ch;
      if (c.className !== cls) c.className = cls;
    }
  });
  p.textEl.style.opacity = Math.max(.25, Math.min(1, j.br == null ? 1 : j.br));
}
async function textStream(p, gen) {
  let seq = 0;
  while (gen === streamGen) {
    try {
      const r = await fetch(`/text/${p.dev.key}?after=${seq}`, { cache: 'no-store' });
      if (gen !== streamGen) break;
      if (r.status === 200) {
        seq = parseInt(r.headers.get('X-Seq') || '0', 10);
        renderText(p, await r.json());
        p.screenEl.classList.add('live');
      } else if (r.status !== 204) await sleep(1000);
    } catch (e) { await sleep(1000); }
  }
}

// ---------------------------------------------------------------- key lighting / night look
// level 0..1 of the rheostat that lights this unit's keys in the loaded aircraft (from the cockpit .obj files:
// C172 G1000 instrument[0], Baron GNS instrument[3], A330 integral instrument_manual[13/14], 737 panel[0..3],
// MD-82 instrument_manual[0], ToLiss AirbusFBW/MCDUIntegBrightness). No avionics power -> unlit.
function lightLevel(dev) {
  if (!opts.lightAuto) return +opts.lightVal || 0;
  const L = status && status.light;
  if (!L) return 0;
  const a = ((status.acf || '') + ' ' + (status.aircraft || '')).toLowerCase();
  const mx = (...v) => Math.max(0, ...v.map((x) => +x || 0));
  let v;
  if (dev.text && L.tlInteg) {
    if (!L.tlPower) return 0;
    const u = /2$/.test(dev.key) ? 1 : 0;
    v = L.tlInteg[Math.min(u, L.tlInteg.length - 1)];
    if (v > 1.01) v /= 100;
  } else {
    if (!L.avionics) return 0;
    if (/a330|a333/.test(a)) v = mx(L.instMan[13], L.instMan[14]);
    else if (/737|738|b738/.test(a)) v = mx(L.panel[0], L.panel[3]);
    else if (/md-?8|md80/.test(a)) v = mx(L.instMan[0]);
    else if (/baron|b58/.test(a)) v = mx(L.inst[3]);
    else v = mx(L.inst[0]);
  }
  return Math.max(0, Math.min(1, v || 0));
}
let panels = [];
function applyLight() {
  for (const p of panels) {
    const v = lightLevel(p.dev);
    p.el.style.setProperty('--lit', v.toFixed(2));
    p.el.classList.toggle('lit', v > .02);
  }
}

let streamFps = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- device selection / status
// a "current" key can be one device ("gns530_1") or two joined with "+" ("gns530_1+gns430_2")
let layoutPortrait = null;
function show(key, byUser, force) {
  if (!status) return;
  const devs = key.split('+').map((k) => status.devices.find((d) => d.key === k));
  if (devs.some((d) => !d)) return;
  if (byUser) manualPick = true;
  if (!force && current === key && $('#bezel').children.length) { renderBar(); return; }
  current = key;
  layoutPortrait = portrait();
  const gen = ++streamGen;
  panels = layout(devs);
  document.body.classList.add('has-dev');
  panels.forEach((p) => stream(p, gen));
  applyLight();
  renderBar();
}

// GNS 530 + GNS 430 of the loaded aircraft, if it has both
function dualKey() {
  const b = (re) => PREFER.find((k) => re.test(k) && status.devices.some((d) => d.key === k && usable(d)));
  const a = b(/^gns530/), c = b(/^gns430/);
  return a && c ? a + '+' + c : null;
}
const allBound = (key) => key.split('+').every((k) => status.devices.some((d) => d.key === k && usable(d)));

function pickAuto() {
  const bound = status.devices.filter(usable);
  if (!bound.length) return null;
  if (current && allBound(current) && (manualPick || !opts.auto)) return current;
  const dk = dualKey();
  if (dk && opts.dual) return dk;
  // portrait -> FMS unit first (CDU/MCDU are upright), landscape -> displays first
  const order = portrait() ? [...PREFER.filter(isFms), ...PREFER.filter((k) => !isFms(k))] : PREFER;
  for (const k of order) if (bound.some((d) => d.key === k)) return k;
  return bound[0].key;
}

function renderBar() {
  $('#acf').textContent = status ? (status.aircraft || '—') : T.offline;
  const box = $('#devs'); box.innerHTML = '';
  if (!status) return;
  const order = PREFER.map((k) => status.devices.find((d) => d.key === k)).filter((d) => d && usable(d));
  const entries = order.map((d) => [d.key, d.name]);
  const dk = dualKey();
  if (dk) entries.unshift([dk, 'GNS 530 + 430']);
  for (const [key, name] of entries) {
    const b = el('button', key === current ? 'sel' : '');
    b.textContent = name;
    b.addEventListener('click', () => { show(key, true); });
    box.appendChild(b);
  }
}

async function poll() {
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    status = await r.json();
    if (status.acf !== lastAcf) { lastAcf = status.acf; manualPick = false; seen.clear(); if (current) toast(status.aircraft); }
    for (const d of status.devices) if (d.bound && d.drawing !== false) seen.add(d.key);
    const k = pickAuto();
    if (k && k !== current) show(k);
    else if (!k) { if (current) { current = null; streamGen++; } noDevice(); }
    renderBar();
    applyLight();
    const d = current && status.devices.find((x) => x.key === current.split('+')[0]);
    $('#stats').textContent = d ? `${d.w}×${d.h} · ${streamFps.toFixed(0)} fps · Readback ${d.readMs} ms${status.pbo ? ' (PBO)' : ''}` : '';
  } catch (e) {
    status = null; renderBar();
  }
  setTimeout(poll, 1500);
}

function noDevice() {
  const root = $('#bezel');
  if (root.dataset.empty) return;
  root.dataset.empty = '1';
  document.body.classList.remove('has-dev');
  root.innerHTML = '';
  root.style.width = '900px'; root.style.height = '300px';
  const m = el('div', 'lbl md'); pos(m, 450, 150);
  m.innerHTML = `${T.noDev}<br><br><span style="font-weight:400;opacity:.7">${T.menuHint}</span>`;
  m.style.lineHeight = '1.4'; root.appendChild(m);
  fit();
}

// ---------------------------------------------------------------- bar / toast / misc
let barTimer = null;
function openBar() {
  $('#bar').classList.remove('hidden');
  clearTimeout(barTimer); barTimer = setTimeout(() => $('#bar').classList.add('hidden'), 6000);
}
function toggleBar() { if ($('#bar').classList.contains('hidden')) openBar(); else { clearTimeout(barTimer); $('#bar').classList.add('hidden'); } }
$('#handle').addEventListener('pointerdown', (e) => { e.preventDefault(); openBar(); });
$('#bar').addEventListener('pointerdown', () => { clearTimeout(barTimer); barTimer = setTimeout(() => $('#bar').classList.add('hidden'), 6000); });

let toastTimer = null;
function toast(t) {
  const e = $('#toast'); e.textContent = t; e.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => e.classList.add('hidden'), 2500);
}

document.documentElement.lang = DE ? 'de' : 'en';
$('#handle').setAttribute('aria-label', T.menu);
for (const [id, key] of [['#opt-sound', 'sound'], ['#opt-ap', 'ap'], ['#opt-auto', 'auto'], ['#opt-dual', 'dual'], ['#opt-pixel', 'pixel'], ['#opt-light', 'lightAuto']]) {
  $(id).parentElement.lastChild.textContent = ' ' + T[key];
  const c = $(id); c.checked = !!opts[key];
  c.addEventListener('change', () => {
    opts[key] = c.checked; saveOpts();
    if (key === 'ap' && current) show(current, false, true);
    if (key === 'lightAuto') { $('#opt-lightval').disabled = c.checked; applyLight(); }
    if (key === 'auto' || key === 'dual') { manualPick = false; const k = status && pickAuto(); if (k) show(k, false, true); }
  });
}

{
  const r = $('#opt-lightval');
  r.value = Math.round((+opts.lightVal || 0) * 100); r.disabled = !!opts.lightAuto;
  r.parentElement.lastChild.textContent = ' ' + T.lightMan;
  r.addEventListener('input', () => { opts.lightVal = r.value / 100; saveOpts(); applyLight(); });
}

// keep the iPad awake while the app is open
let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => (wakeLock = null)); } } catch (e) {}
}
document.addEventListener('pointerdown', keepAwake);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1 || (e.scale && e.scale !== 1)) e.preventDefault(); }, { passive: false });
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => { const n = Date.now(); if (n - lastTouchEnd < 350) e.preventDefault(); lastTouchEnd = n; }, { passive: false });
document.addEventListener('dblclick', (e) => e.preventDefault());

poll();
