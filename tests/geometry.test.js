// Builds every generator from a synthetic two-colour image and checks that each printed part is a
// closed, consistently wound solid, and that the Orca 3MF carries the filament slots.
//   npm install && npm test
const assert = require('assert');
const THREE = require('three');
const C = require('../src/core.js');

// 400x400 test art: a dark ring around a light disc with a dark dot, on white
const W = 400, H = 400, data = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const r = Math.hypot(x - 200, y - 200), i = (y * W + x) * 4;
  let c = [255, 255, 255];
  if (r < 170) c = [30, 30, 40];
  if (r < 150) c = [240, 160, 40];
  if (Math.hypot(x - 200, y - 160) < 25) c = [30, 30, 40];
  data.set([...c, 255], i);
}
const img = { data, width: W, height: H };
const { mask } = C.removeBackground(img, 40);
const prep = C.cropAndScale(img, mask, 600, false);
let { labels, k } = C.kmeans(prep, prep.mask, 2);
labels = C.modeFilter(labels, prep.width, prep.height, k, 2); prep.labels = labels;
const st = C.regionStats(prep, labels, k);
const layerOf = st.map(s => s.index), layers = st.map(s => ({ id: s.index, height: 1 }));
const tri = (o, hs) => THREE.ShapeUtils.triangulateShape(o.map(p => new THREE.Vector2(p[0], p[1])), hs.map(h => h.map(p => new THREE.Vector2(p[0], p[1]))));

function closed(mesh) {
  const cnt = new Map();
  for (let t = 0; t < mesh.indices.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = mesh.indices[t + e], b = mesh.indices[t + (e + 1) % 3], key = a < b ? a + ',' + b : b + ',' + a;
    const v = cnt.get(key) || [0, 0]; v[0]++; v[1] += a < b ? 1 : -1; cnt.set(key, v);
  }
  for (const [, v] of cnt) if (v[0] !== 2 || v[1] !== 0) return false;
  return true;
}
function check(name, res) {
  assert(res.parts.length >= (name === 'coin engrave' ? 1 : 2), name + ': too few parts');
  for (const p of res.parts) for (const m of (p.shells || [p.mesh])) assert(closed(m), `${name}: part ${p.id} is not a closed solid`);
  console.log('ok', name, res.parts.length, 'parts');
}

const flat = { thicknessMM: 3.5, colorDepthMM: 1.5, marginMM: 2, fillGapsMM: 2, smoothMM: 0.15, minLineMM: 0.8, layerOf, layers, marginLayer: -1 };
check('tray', C.buildTray(prep, { heightMM: 60, rimMM: 2, roundMM: 0, smoothMM: 0.35, baseMM: 2, layerOf, layers, rimLayer: -1, gapLayer: -1 }, tri));
for (const mode of ['raise', 'engrave', 'inlay'])
  check('coin ' + mode, C.buildCoin(prep, { diameterMM: 40, thicknessMM: 3, rimWidthMM: 2, rimHeightMM: 1, marginMM: 1, mode, depthMM: 1, smoothMM: 0.2, layerOf, layers, rimLayer: -1 }, tri));
check('keychain', C.buildKeychain(prep, { ...flat, shape: 'outline', sizeMM: 50, holePos: 'top', holeDiaMM: 4, ringWallMM: 2.5 }, tri));
for (const shape of ['circle', 'square', 'star', 'cloud', 'hexagon'])
  check('keychain ' + shape, C.buildKeychain(prep, { ...flat, shape, sizeMM: 50, holePos: 'none' }, tri));
check('magnet', C.buildKeychain(prep, { ...flat, shape: 'outline', sizeMM: 60, thicknessMM: 5, holePos: 'none', pockets: { count: 2, diaMM: 10.3, depthMM: 3.15, hidden: true, floorMM: 0.6 } }, tri));
check('coaster', C.buildKeychain(prep, { ...flat, shape: 'circle', sizeMM: 100, holePos: 'none', rimWidthMM: 4, rimHeightMM: 1.5, rimLayer: 32006, recess: { depthMM: 1, insetMM: 3 } }, tri));
check('bookmark + fillers', C.buildKeychain(prep, { ...flat, shape: 'rect', sizeMM: 150, rectWMM: 40, rectHMM: 150, cornerMM: 4, thicknessMM: 1.6, colorDepthMM: 1, holePos: 'none',
  tassel: { diaMM: 5, fromEdgeMM: 8 }, fill: { shape: 'mix', count: 30, minMM: 3, maxMM: 8, gapMM: 2, edgeMM: 2, seed: 1, layerId: 32007 }, layers: [...layers, { id: 32007 }] }, tri));
const cookie = C.buildCookie(prep, { sizeMM: 80, heightMM: 15, wallMM: 1.2, bladeMM: 0.6, lipWidthMM: 3, lipHeightMM: 1.6, fillGapsMM: 4, smoothMM: 0.2, layerOf,
  lineLayers: [st.slice().sort((a, b) => a.lightness - b.lightness)[0].index], stamp: { plateId: 32008, clearanceMM: 1, thicknessMM: 3, reliefMM: 2.5, boostMM: 0.4 } }, tri);
check('cookie cutter + stamp', cookie);

// Orca 3MF: one object, each part on its slot
const files = C.orca3MFFiles(cookie.parts.map((p, i) => ({ name: 'Part ' + i, extruder: i + 1, mesh: p.mesh })), 'Test');
const cfg = new TextDecoder().decode(files.find(f => f.name === 'Metadata/model_settings.config').data);
cookie.parts.forEach((p, i) => assert(cfg.includes(`<metadata key="name" value="Part ${i}"/>\n      <metadata key="extruder" value="${i + 1}"/>`), 'slot missing for part ' + i));
console.log('ok orca 3mf slots');

// Paint a model: the art painted onto a cylinder, written as Orca paint strings. Decode each string the way
// Orca's TriangleSelector::deserialize reads it and check every tree is complete and only uses known states.
{
  const n = 48, P = [0, 0, 0, 0, 0, 30], I = [];
  for (let i = 0; i < n; i++) { const a = i / n * 2 * Math.PI; P.push(15 * Math.cos(a), 15 * Math.sin(a), 0, 15 * Math.cos(a), 15 * Math.sin(a), 30); }
  for (let i = 0; i < n; i++) { const j = (i + 1) % n, b0 = 2 + 2 * i, t0 = 3 + 2 * i, b1 = 2 + 2 * j, t1 = 3 + 2 * j; I.push(0, b1, b0, 1, t0, t1, b0, b1, t1, b0, t1, t0); }
  const mesh = { positions: new Float32Array(P), indices: new Uint32Array(I) };
  const r = C.paintMesh(mesh, { art: prep, stateOf: prep.labels ? st.map((_, i) => i + 1) : [], mmPerPx: 40 / prep.width, kind: 'wrap', axis: [0, 0], radius: 15, zc: 15, minEdge: 0.3 });
  assert(r.painted > 0, 'paint: nothing painted');
  const strings = C.paintStrings(r.trees, st.map((_, i) => i + 2).concat([0]).reduce((a, v, i) => (a[i + 1] = v, a), [0]));
  for (const s of strings) {
    if (!s) continue;
    const bits = []; for (let k = s.length - 1; k >= 0; k--) { const d = parseInt(s[k], 16); for (let b = 0; b < 4; b++) bits.push((d >> b) & 1); }
    let p = 0; const nib = () => { const v = bits[p] | bits[p + 1] << 1 | bits[p + 2] << 2 | bits[p + 3] << 3; p += 4; return v; };
    const walk = () => {
      const code = nib(), sides = code & 3;
      if (sides === 0) { if ((code & 12) === 12) { const st2 = nib() + 3; assert(st2 <= 17, 'paint: bad state'); } return; }
      assert(sides === 3 || (code >> 2) !== 3, 'paint: bad split code');
      for (let c = 0; c <= sides; c++) walk();
    };
    walk();
    assert(p === bits.length, 'paint: string has leftover bits');
  }
  console.log('ok paint', r.painted, 'triangles painted');
}
