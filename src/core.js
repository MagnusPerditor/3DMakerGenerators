(function (root) {
  'use strict';

  // ---------- color helpers ----------
  function srgbToLin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function rgbToLab(r, g, b) {
    const R = srgbToLin(r), G = srgbToLin(g), B = srgbToLin(b);
    let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    let y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
    let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    x = f(x); y = f(y); z = f(z);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }
  function hex(r, g, b) { return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }

  // ---------- 1. background removal ----------
  // Flood fill from the border through pixels close to the sampled background color.
  // Transparent pixels always count as background. Returns Uint8 mask (1 = subject).
  function removeBackground(img, tol) {
    const { data, width: w, height: h } = img;
    const N = w * h, bg = new Uint8Array(N);
    const border = [];
    for (let x = 0; x < w; x++) { border.push(x, (h - 1) * w + x); }
    for (let y = 0; y < h; y++) { border.push(y * w, y * w + w - 1); }
    // median border color among opaque pixels
    const rs = [], gs = [], bs = [];
    for (const i of border) if (data[i * 4 + 3] > 127) { rs.push(data[i * 4]); gs.push(data[i * 4 + 1]); bs.push(data[i * 4 + 2]); }
    const med = a => { if (!a.length) return 0; a.sort((p, q) => p - q); return a[a.length >> 1]; };
    const br = med(rs), bgc = med(gs), bb = med(bs);
    const t2 = tol * tol;
    // mostly transparent border (SVGs, cut-out PNGs): transparency alone marks background
    const alphaOnly = rs.length < border.length / 2;
    const isBg = i => {
      if (data[i * 4 + 3] <= 127) return true;
      if (alphaOnly) return false;
      const dr = data[i * 4] - br, dg = data[i * 4 + 1] - bgc, db = data[i * 4 + 2] - bb;
      return dr * dr + dg * dg + db * db <= t2;
    };
    const stack = new Int32Array(N); let sp = 0;
    for (const i of border) if (!bg[i] && isBg(i)) { bg[i] = 1; stack[sp++] = i; }
    while (sp) {
      const i = stack[--sp], x = i % w, y = (i / w) | 0;
      if (x > 0 && !bg[i - 1] && isBg(i - 1)) { bg[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < w - 1 && !bg[i + 1] && isBg(i + 1)) { bg[i + 1] = 1; stack[sp++] = i + 1; }
      if (y > 0 && !bg[i - w] && isBg(i - w)) { bg[i - w] = 1; stack[sp++] = i - w; }
      if (y < h - 1 && !bg[i + w] && isBg(i + w)) { bg[i + w] = 1; stack[sp++] = i + w; }
    }
    const mask = new Uint8Array(N);
    for (let i = 0; i < N; i++) mask[i] = bg[i] ? 0 : 1;
    // keep only the largest connected subject blob plus anything it encloses
    keepLargestComponent(mask, w, h);
    return { mask, bgColor: hex(br, bgc, bb) };
  }

  function keepLargestComponent(mask, w, h) {
    const N = w * h, comp = new Int32Array(N).fill(-1), stack = new Int32Array(N);
    let best = -1, bestSize = 0, id = 0;
    for (let s = 0; s < N; s++) {
      if (!mask[s] || comp[s] >= 0) continue;
      let sp = 0, size = 0; stack[sp++] = s; comp[s] = id;
      while (sp) {
        const i = stack[--sp]; size++;
        const x = i % w, y = (i / w) | 0;
        const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
        for (const j of nb) if (j >= 0 && mask[j] && comp[j] < 0) { comp[j] = id; stack[sp++] = j; }
      }
      if (size > bestSize) { bestSize = size; best = id; }
      id++;
    }
    for (let i = 0; i < N; i++) if (mask[i] && comp[i] !== best) mask[i] = 0;
  }

  // Crop image+mask to the subject's bounding box, resampled so the long side <= maxSide.
  function cropAndScale(img, mask, maxSide, mirror) {
    const { width: w, height: h, data } = img;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x1 < 0) throw new Error('No subject found. Lower the background tolerance.');
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    const s = Math.min(1, maxSide / Math.max(cw, ch));
    const W = Math.max(1, Math.round(cw * s)), H = Math.max(1, Math.round(ch * s));
    const out = new Uint8ClampedArray(W * H * 4), m = new Uint8Array(W * H);
    for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
      const sx = x0 + Math.min(cw - 1, Math.floor((X + 0.5) / s));
      const sy = y0 + Math.min(ch - 1, Math.floor((Y + 0.5) / s));
      const dX = mirror ? W - 1 - X : X;
      const si = sy * w + sx, di = Y * W + dX;
      m[di] = mask[si];
      out.set(data.subarray(si * 4, si * 4 + 4), di * 4);
    }
    return { data: out, width: W, height: H, mask: m };
  }

  // ---------- 2. color regions ----------
  function kmeans(img, mask, k, seed) {
    const { data, width: w, height: h } = img, N = w * h;
    const idx = []; for (let i = 0; i < N; i++) if (mask[i]) idx.push(i);
    let rng = seed || 12345; const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const stride = Math.max(1, Math.floor(idx.length / 30000));
    const S = []; for (let j = 0; j < idx.length; j += stride) { const i = idx[j]; S.push(rgbToLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2])); }
    k = Math.min(k, S.length);
    const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    // k-means++ init
    const C = [S[Math.floor(rand() * S.length)].slice()];
    const D = new Float64Array(S.length).fill(Infinity);
    while (C.length < k) {
      let sum = 0; const c = C[C.length - 1];
      for (let j = 0; j < S.length; j++) { D[j] = Math.min(D[j], d2(S[j], c)); sum += D[j]; }
      let r = rand() * sum, j = 0; while (j < S.length - 1 && (r -= D[j]) > 0) j++;
      C.push(S[j].slice());
    }
    const assign = new Int32Array(S.length);
    for (let it = 0; it < 20; it++) {
      const acc = C.map(() => [0, 0, 0, 0]);
      for (let j = 0; j < S.length; j++) {
        let b = 0, bd = Infinity; for (let c = 0; c < k; c++) { const d = d2(S[j], C[c]); if (d < bd) { bd = d; b = c; } }
        assign[j] = b; const a = acc[b]; a[0] += S[j][0]; a[1] += S[j][1]; a[2] += S[j][2]; a[3]++;
      }
      let moved = 0;
      for (let c = 0; c < k; c++) if (acc[c][3]) { const n = [acc[c][0] / acc[c][3], acc[c][1] / acc[c][3], acc[c][2] / acc[c][3]]; moved += d2(n, C[c]); C[c] = n; }
      if (moved < 0.01) break;
    }
    // label every subject pixel
    const labels = new Int16Array(N).fill(-1);
    const cache = new Map();
    for (const i of idx) {
      const key = (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2];
      let b = cache.get(key);
      if (b === undefined) {
        const L = rgbToLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]); let bd = Infinity; b = 0;
        for (let c = 0; c < k; c++) { const d = d2(L, C[c]); if (d < bd) { bd = d; b = c; } }
        cache.set(key, b);
      }
      labels[i] = b;
    }
    return { labels, k };
  }

  // Majority filter over subject pixels: removes anti-aliasing fringes.
  function modeFilter(labels, w, h, k, passes) {
    let cur = labels;
    const cnt = new Int32Array(k);
    for (let p = 0; p < passes; p++) {
      const nxt = new Int16Array(cur);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x; if (cur[i] < 0) continue;
        cnt.fill(0);
        for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= w) continue; const l = cur[yy * w + xx]; if (l >= 0) cnt[l]++; } }
        let b = cur[i], bc = cnt[b]; for (let c = 0; c < k; c++) if (cnt[c] > bc) { bc = cnt[c]; b = c; }
        nxt[i] = b;
      }
      cur = nxt;
    }
    return cur;
  }

  // Clean up k-means output: drop clusters that are only thin fringes (anti-aliasing, JPEG noise
  // around lines: almost none of their pixels have all 8 neighbours in the same cluster), and merge
  // clusters whose average colors are nearly the same. Returns compacted labels and the new count.
  function simplifyClusters(img, labels, w, h, k, opts) {
    const minInterior = opts && opts.minInterior != null ? opts.minInterior : 0.12;
    const mergeDE = opts && opts.mergeDE != null ? opts.mergeDE : 12;
    const N = w * h, lab = new Float32Array(N * 3), d = img.data;
    for (let i = 0; i < N; i++) if (labels[i] >= 0) { const L = rgbToLab(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]); lab[i * 3] = L[0]; lab[i * 3 + 1] = L[1]; lab[i * 3 + 2] = L[2]; }
    const alive = new Uint8Array(k).fill(1);
    const stats = () => {
      const c = Array.from({ length: k }, () => [0, 0, 0, 0, 0]);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, l = labels[i]; if (l < 0) continue;
        const s = c[l]; s[0] += lab[i * 3]; s[1] += lab[i * 3 + 1]; s[2] += lab[i * 3 + 2]; s[3]++;
        let inner = x > 0 && y > 0 && x < w - 1 && y < h - 1;
        for (let dy = -1; inner && dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (labels[i + dy * w + dx] !== l) { inner = false; break; }
        if (inner) s[4]++;
      }
      return c.map(s => ({ n: s[3], L: s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : null, interior: s[3] ? s[4] / s[3] : 0 }));
    };
    const reassign = (from) => {
      for (let i = 0; i < N; i++) if (labels[i] === from) {
        let b = -1, bd = Infinity;
        for (let c = 0; c < k; c++) if (alive[c] && cs[c].L) { const q = cs[c].L, dd = (lab[i * 3] - q[0]) ** 2 + (lab[i * 3 + 1] - q[1]) ** 2 + (lab[i * 3 + 2] - q[2]) ** 2; if (dd < bd) { bd = dd; b = c; } }
        labels[i] = b;
      }
    };
    let cs = stats();
    for (let guard = 0; guard < 4 * k; guard++) {
      const live = [...Array(k).keys()].filter(c => alive[c] && cs[c].n);
      if (live.length <= 1) break;
      // 1) thinnest fringe cluster goes first
      let thin = -1; for (const c of live) if (cs[c].interior < minInterior && (thin < 0 || cs[c].interior < cs[thin].interior)) thin = c;
      if (thin >= 0) { alive[thin] = 0; reassign(thin); cs = stats(); continue; }
      // 2) then the closest pair of near-identical colors
      let pa = -1, pb = -1, pd = mergeDE * mergeDE;
      for (let x = 0; x < live.length; x++) for (let y = x + 1; y < live.length; y++) {
        const p = cs[live[x]].L, q = cs[live[y]].L, dd = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
        if (dd < pd) { pd = dd; pa = live[x]; pb = live[y]; }
      }
      if (pa < 0) break;
      const keep = cs[pa].n >= cs[pb].n ? pa : pb, drop = keep === pa ? pb : pa;
      for (let i = 0; i < N; i++) if (labels[i] === drop) labels[i] = keep;
      alive[drop] = 0; cs = stats();
    }
    const map = new Int16Array(k).fill(-1); let n = 0;
    for (let c = 0; c < k; c++) if (alive[c] && cs[c].n) map[c] = n++;
    for (let i = 0; i < N; i++) if (labels[i] >= 0) labels[i] = map[labels[i]];
    return { labels, k: n };
  }

  // Merge connected components smaller than minArea into their most common neighbor label.
  function mergeSmall(labels, w, h, k, minArea) {
    const N = w * h;
    for (let round = 0; round < 3; round++) {
      const comp = new Int32Array(N).fill(-1), stack = new Int32Array(N);
      let changed = 0, id = 0;
      for (let s = 0; s < N; s++) {
        if (labels[s] < 0 || comp[s] >= 0) continue;
        const L = labels[s], members = []; const nbc = new Int32Array(k);
        let sp = 0; stack[sp++] = s; comp[s] = id;
        while (sp) {
          const i = stack[--sp]; members.push(i);
          const x = i % w, y = (i / w) | 0;
          const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
          for (const j of nb) { if (j < 0) continue; const lj = labels[j];
            if (lj === L) { if (comp[j] < 0) { comp[j] = id; stack[sp++] = j; } } else if (lj >= 0) nbc[lj]++; }
        }
        if (members.length < minArea) {
          let b = -1, bc = 0; for (let c = 0; c < k; c++) if (nbc[c] > bc) { bc = nbc[c]; b = c; }
          if (b >= 0) { for (const i of members) labels[i] = b; changed++; }
        }
        id++;
      }
      if (!changed) break;
    }
    return labels;
  }

  function regionStats(img, labels, k) {
    const acc = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let i = 0; i < labels.length; i++) { const l = labels[i]; if (l < 0) continue; const a = acc[l];
      a[0] += img.data[i * 4]; a[1] += img.data[i * 4 + 1]; a[2] += img.data[i * 4 + 2]; a[3]++; }
    return acc.map((a, i) => {
      const n = a[3] || 1, r = a[0] / n, g = a[1] / n, b = a[2] / n;
      return { index: i, color: hex(r, g, b), pixels: a[3], lightness: rgbToLab(r, g, b)[0] };
    });
  }

  // ---------- 3. distance transform (exact, Felzenszwalb) ----------
  function edt1d(f, n, d, v, z) {
    let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let s;
      while (true) { const p = v[k]; s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p); if (s <= z[k]) { k--; } else break; }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const p = v[k]; d[q] = (q - p) * (q - p) + f[p]; }
  }
  // distance (in px) from each pixel to the nearest pixel where src==1
  function edt(src, w, h) {
    const INF = 1e20, g = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = src[i] ? 0 : INF;
    const n = Math.max(w, h), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    for (let x = 0; x < w; x++) { for (let y = 0; y < h; y++) f[y] = g[y * w + x]; edt1d(f, h, d, v, z); for (let y = 0; y < h; y++) g[y * w + x] = d[y]; }
    for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) f[x] = g[y * w + x]; edt1d(f, w, d, v, z); for (let x = 0; x < w; x++) g[y * w + x] = Math.sqrt(d[x]); }
    return g;
  }

  // separable Gaussian blur of a 0/1 field; turns pixel staircases into smooth iso-lines.
  // Where two regions meet their blurred fields sum to 1, so both contours land on the same curve.
  function blurField(src, w, h, sigma) {
    const out = new Float32Array(w * h);
    if (!(sigma > 0.05)) { for (let i = 0; i < w * h; i++) out[i] = src[i]; return out; }
    const R = Math.max(1, Math.ceil(sigma * 3)), k = new Float32Array(2 * R + 1);
    let sum = 0; for (let i = -R; i <= R; i++) { k[i + R] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += k[i + R]; }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) { const o = y * w;
      for (let x = 0; x < w; x++) { let a = 0;
        for (let j = -R; j <= R; j++) { const xx = x + j; if (xx >= 0 && xx < w) a += src[o + xx] * k[j + R]; }
        tmp[o + x] = a; } }
    for (let x = 0; x < w; x++)
      for (let y = 0; y < h; y++) { let a = 0;
        for (let j = -R; j <= R; j++) { const yy = y + j; if (yy >= 0 && yy < h) a += tmp[yy * w + x] * k[j + R]; }
        out[y * w + x] = a; }
    return out;
  }

  // ---------- 4. contours (marching squares, consistently oriented, linked) ----------
  // field sampled at pixel centers; inside where field > iso. Returns loops in pixel coords (y down).
  function marchingSquares(field, w, h, iso) {
    // pad by one sample of "outside" so every loop closes
    const W = w + 2, H = h + 2, F = new Float32Array(W * H).fill(iso - 1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) F[(y + 1) * W + x + 1] = field[y * w + x];
    const ins = i => F[i] > iso;
    const next = new Map(), pts = new Map();
    const edgePoint = (key, ax, ay, bx, by) => {
      if (!pts.has(key)) {
        const va = F[ay * W + ax], vb = F[by * W + bx];
        let t = (iso - va) / (vb - va); if (!isFinite(t)) t = 0.5; t = Math.max(0.001, Math.min(0.999, t));
        pts.set(key, [ax + (bx - ax) * t - 1, ay + (by - ay) * t - 1]);
      }
      return key;
    };
    for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
      const a = y * W + x, b = a + 1, c = a + W + 1, d = a + W;
      const A = ins(a), B = ins(b), Cc = ins(c), D = ins(d);
      const code = (A ? 8 : 0) | (B ? 4 : 0) | (Cc ? 2 : 0) | (D ? 1 : 0);
      if (code === 0 || code === 15) continue;
      // edge keys: top (a-b), right (b-c), bottom (d-c), left (a-d)
      const T = () => edgePoint(2 * a, x, y, x + 1, y);
      const R = () => edgePoint(2 * b + 1, x + 1, y, x + 1, y + 1);
      const Bo = () => edgePoint(2 * d, x, y + 1, x + 1, y + 1);
      const L = () => edgePoint(2 * a + 1, x, y, x, y + 1);
      // Each segment is emitted so that the inside is on the left when walking in y-down coords.
      const seg = (s, e) => next.set(s, e);
      switch (code) {
        case 8: seg(L(), T()); break;          // A
        case 4: seg(T(), R()); break;          // B
        case 2: seg(R(), Bo()); break;         // C
        case 1: seg(Bo(), L()); break;         // D
        case 12: seg(L(), R()); break;         // A B
        case 6: seg(T(), Bo()); break;         // B C
        case 3: seg(R(), L()); break;          // C D
        case 9: seg(Bo(), T()); break;         // A D
        case 7: seg(T(), L()); break;          // not A
        case 11: seg(R(), T()); break;         // not B
        case 13: seg(Bo(), R()); break;        // not C
        case 14: seg(L(), Bo()); break;        // not D
        case 10: { // A C saddle
          const center = (F[a] + F[b] + F[c] + F[d]) / 4 > iso;
          if (center) { seg(L(), Bo()); seg(R(), T()); } else { seg(L(), T()); seg(R(), Bo()); }
          break; }
        case 5: { // B D saddle
          const center = (F[a] + F[b] + F[c] + F[d]) / 4 > iso;
          if (center) { seg(T(), L()); seg(Bo(), R()); } else { seg(T(), R()); seg(Bo(), L()); }
          break; }
      }
    }
    const loops = [], used = new Set();
    for (const start of next.keys()) {
      if (used.has(start)) continue;
      const loop = []; let cur = start, guard = 0;
      while (!used.has(cur) && guard++ < 1e7) { used.add(cur); loop.push(pts.get(cur)); cur = next.get(cur); if (cur === undefined) break; }
      if (loop.length >= 3) loops.push(loop);
    }
    return loops;
  }

  function signedArea(p) { let s = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += (p[j][0] * p[i][1] - p[i][0] * p[j][1]); return s / 2; }

  // Douglas-Peucker on a closed loop
  function simplifyLoop(pts, tol) {
    if (pts.length < 8 || tol <= 0) return pts;
    // split at the two farthest-apart-ish points: index 0 and the farthest from it
    let far = 0, fd = -1; for (let i = 1; i < pts.length; i++) { const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
    const t2 = tol * tol;
    const dp = (arr) => {
      const keep = new Uint8Array(arr.length); keep[0] = keep[arr.length - 1] = 1;
      const st = [[0, arr.length - 1]];
      while (st.length) {
        const [s, e] = st.pop(); const [ax, ay] = arr[s], [bx, by] = arr[e];
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        let md = -1, mi = -1;
        for (let i = s + 1; i < e; i++) {
          const px = arr[i][0] - ax, py = arr[i][1] - ay;
          const d = L2 ? ((px * dy - py * dx) ** 2) / L2 : px * px + py * py;
          if (d > md) { md = d; mi = i; }
        }
        if (md > t2) { keep[mi] = 1; st.push([s, mi], [mi, e]); }
      }
      return arr.filter((_, i) => keep[i]);
    };
    const a = dp(pts.slice(0, far + 1)), b = dp(pts.slice(far).concat([pts[0]]));
    const out = a.concat(b.slice(1, -1));
    return out.length >= 3 ? out : pts;
  }

  function pointInPoly(pt, poly) {
    let c = false; const [x, y] = pt;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c;
    }
    return c;
  }

  // loops (px, y-down) -> shapes in mm, y-up: [{outer:[[x,y]..] CCW, holes:[[..] CW]}]
  // Remove duplicate points and zero-width spikes (a point where the outline doubles straight back on
  // itself). A spike has no area, so the triangulator leaves it out and the part ends up with a pinhole.
  function removeSpikes(p) {
    let out = p, changed = true;
    while (changed && out.length > 3) {
      changed = false; const keep = [];
      for (let i = 0; i < out.length; i++) {
        const a = keep.length ? keep[keep.length - 1] : out[out.length - 1], b = out[i], c = out[(i + 1) % out.length];
        const abx = b[0] - a[0], aby = b[1] - a[1], bcx = c[0] - b[0], bcy = c[1] - b[1];
        const dup = Math.abs(abx) < 1e-9 && Math.abs(aby) < 1e-9;
        const cr = abx * bcy - aby * bcx, dot = abx * bcx + aby * bcy, L = Math.hypot(abx, aby) * Math.hypot(bcx, bcy);
        if (dup || (L > 0 && Math.abs(cr) < 1e-6 * L && dot < 0)) { changed = true; continue; }
        keep.push(b);
      }
      if (keep.length < 3) break;
      out = keep;
    }
    return out;
  }
  function loopsToShapes(loops, heightPx, mmPerPx, tolPx, minAreaPx) {
    // segments keep the inside on the visual left (y-down), i.e. outers are CW in raw coords; flipping y makes outers CCW
    const conv = loops.map(l => removeSpikes(simplifyLoop(l, tolPx).map(([x, y]) => [x * mmPerPx, (heightPx - 1 - y) * mmPerPx])));
    const items = conv.map(p => ({ p, a: signedArea(p) })).filter(o => Math.abs(o.a) >= minAreaPx * mmPerPx * mmPerPx);
        const outers = items.filter(o => o.a > 0).sort((u, v) => u.a - v.a);
    const holes = items.filter(o => o.a < 0);
    const shapes = outers.map(o => ({ outer: o.p, holes: [], a: o.a }));
    for (const hl of holes) {
      const probe = hl.p[0];
      const host = shapes.find(s => s.a > -hl.a && pointInPoly(probe, s.outer));
      if (host) host.holes.push(hl.p);
    }
    return shapes;
  }

  // ---------- 5. extrusion to an indexed, watertight mesh ----------
  // triangulate(contour, holes) -> array of [i,j,k] into concat(contour, ...holes); injected (THREE.ShapeUtils in the browser)
  function extrudeShapes(shapes, z0, z1, triangulate) {
    const pos = [], idx = [];
    for (const s of shapes) {
      const rings = [s.outer, ...s.holes];
      const base = pos.length / 3;
      const offs = []; let n = 0;
      for (const r of rings) { offs.push(n); n += r.length; }
      for (const r of rings) for (const [x, y] of r) pos.push(x, y, z0);
      for (const r of rings) for (const [x, y] of r) pos.push(x, y, z1);
      const flat = [].concat(...rings);
      // every outline edge must end up in exactly one cap triangle; holes that nearly touch another loop can
      // make the triangulator skip a sliver, so retry with the holes nudged inward (vertex indices stay the same)
      const covered = t => {
        const used = new Map();
        for (const [i, j, k] of t) for (const [a, b] of [[i, j], [j, k], [k, i]]) { const key = a < b ? a * 1e6 + b : b * 1e6 + a; used.set(key, (used.get(key) || 0) + 1); }
        for (let r = 0; r < rings.length; r++) for (let q = 0; q < rings[r].length; q++) {
          const a = offs[r] + q, b = offs[r] + (q + 1) % rings[r].length, key = a < b ? a * 1e6 + b : b * 1e6 + a;
          if (used.get(key) !== 1) return false;
        }
        return true;
      };
      const shrink = (h, f) => { let cx = 0, cy = 0; for (const [x, y] of h) { cx += x; cy += y; } cx /= h.length; cy /= h.length; return h.map(([x, y]) => [cx + (x - cx) * (1 - f), cy + (y - cy) * (1 - f)]); };
      let tris = [], geo = flat;
      for (const f of [0, 1e-4, 1e-3, 5e-3]) {
        const hs = f ? s.holes.map(h => shrink(h, f)) : s.holes;
        try { tris = triangulate(s.outer, hs); } catch (e) { tris = []; }
        geo = [].concat(s.outer, ...hs); // orient triangles using the coordinates they were built from
        if (!s.holes.length || covered(tris)) break;
      }
      // orient each triangle CCW from above by its own area; zero-area slivers (points that happen to line up)
      // have no direction of their own, so they take the winding most of this shape's triangles came back with
      const ars = tris.map(([i, j, k]) => (geo[j][0] - geo[i][0]) * (geo[k][1] - geo[i][1]) - (geo[k][0] - geo[i][0]) * (geo[j][1] - geo[i][1]));
      let pos_ = 0, neg_ = 0; for (const v of ars) { if (v > 1e-9) pos_++; else if (v < -1e-9) neg_++; }
      const asReturned = pos_ >= neg_;
      for (let t = 0; t < tris.length; t++) {
        const [i, j, k] = tris[t], ar = ars[t];
        const keep = Math.abs(ar) > 1e-9 ? ar > 0 : asReturned;
        const [a, b, c] = keep ? [i, j, k] : [i, k, j]; // CCW from above
        idx.push(base + n + a, base + n + b, base + n + c);   // top faces up
        idx.push(base + a, base + c, base + b);               // bottom faces down
      }
      rings.forEach((r, ri) => {
        const o = offs[ri];
        for (let i = 0; i < r.length; i++) {
          const i0 = base + o + i, i1 = base + o + (i + 1) % r.length;
          idx.push(i0, i1, i1 + n, i0, i1 + n, i0 + n);
        }
      });
    }
    return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
  }

  // ---------- full build ----------
  // prep: {data,width,height,mask,labels} ; opts: sizes in mm; layerOf[k] -> layer id or -1 ; layers:[{id,height}]
  function buildTray(prep, opts, triangulate) {
    const { width: w, height: h, mask, labels } = prep;
    const mmPerPx = opts.heightMM / h;
    const rPx = opts.rimMM / mmPerPx, cPx = opts.roundMM / mmPerPx;
    const sPx = (opts.smoothMM || 0) / mmPerPx;
    const pad = Math.ceil(rPx + cPx + 3 * sPx) + 3;
    const W = w + 2 * pad, H = h + 2 * pad;
    const sil = new Uint8Array(W * H), lab = new Int16Array(W * H).fill(-1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, j = (y + pad) * W + x + pad;
      sil[j] = mask[i];
      if (mask[i] && labels[i] >= 0) lab[j] = opts.layerOf[labels[i]];
    }
    // base footprint = silhouette grown by rim, then closed by the rounding radius
    const dIn = edt(sil, W, H);
    const grown = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) grown[i] = dIn[i] <= rPx + cPx ? 1 : 0;
    const outside = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) outside[i] = grown[i] ? 0 : 1;
    const dOut = edt(outside, W, H);
    const baseMask = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) baseMask[i] = dOut[i] > cPx + 0.5 ? 1 : 0;
    // rim pixels (base but not subject) join the rim layer, if any
    // Non-art pixels inside the footprint: the band along the outer edge becomes the wall;
    // enclosed gaps (e.g. between legs) are filled by gapLayer at art height instead of growing a wall.
    // dOut - cPx is the distance to the footprint's outside edge.
    const band = rPx + 1.5;
    const hasRim = opts.rimLayer != null && opts.rimLayer >= 0, hasGap = opts.gapLayer != null && opts.gapLayer >= 0;
    for (let i = 0; i < W * H; i++) {
      if (!baseMask[i] || sil[i]) continue;
      if (dOut[i] - cPx <= band) { if (hasRim) lab[i] = opts.rimLayer; }
      else if (hasGap) lab[i] = opts.gapLayer;
    }
    for (let i = 0; i < W * H; i++) if (!baseMask[i]) lab[i] = -1;

    const tol = opts.simplifyPx == null ? 0.2 : opts.simplifyPx;
    const minA = opts.minAreaPx || 4;
    const out = [];
    const N = W * H, BG = -1, FLAT = -2;
    // every pixel gets exactly one owner: a layer, "flat" (base shows) or background
    const owner = new Int32Array(N);
    for (let i = 0; i < N; i++) owner[i] = !baseMask[i] ? BG : (lab[i] >= 0 && opts.layers.some(L => L.id === lab[i] && L.height > 0) ? lab[i] : FLAT);
    const ids = [...new Set(owner)];
    const ind = new Float32Array(N), fields = new Map();
    for (const id of ids) { for (let i = 0; i < N; i++) ind[i] = owner[i] === id ? 1 : 0; fields.set(id, blurField(ind, W, H, sPx)); }
    // top two field values per pixel; a region's edge is where it stops beating every rival,
    // so neighbouring parts share one boundary with no gaps or overlaps (unlike separate 0.5 iso-lines)
    const best = new Float32Array(N).fill(-1), second = new Float32Array(N).fill(-1), bestId = new Int32Array(N).fill(BG - 9);
    const bestSolid = new Float32Array(N).fill(-1);
    for (const [id, f] of fields) for (let i = 0; i < N; i++) {
      const v = f[i];
      if (v > best[i]) { second[i] = best[i]; best[i] = v; bestId[i] = id; } else if (v > second[i]) second[i] = v;
      if (id !== BG && v > bestSolid[i]) bestSolid[i] = v;
    }
    const d = new Float32Array(N);
    const fBG = fields.get(BG) || new Float32Array(N);
    for (let i = 0; i < N; i++) d[i] = bestSolid[i] - fBG[i];
    const bShapes = loopsToShapes(marchingSquares(d, W, H, 0), H, mmPerPx, tol, minA);
    out.push({ id: 'base', mesh: extrudeShapes(bShapes, 0, opts.baseMM, triangulate), shapes: bShapes, top: opts.baseMM });
    for (const L of opts.layers) {
      if (!(L.height > 0) || !fields.has(L.id)) continue;
      const f = fields.get(L.id);
      for (let i = 0; i < N; i++) d[i] = f[i] - (bestId[i] === L.id ? second[i] : best[i]);
      const shapes = loopsToShapes(marchingSquares(d, W, H, 0), H, mmPerPx, tol, minA);
      if (!shapes.length) continue;
      out.push({ id: L.id, mesh: extrudeShapes(shapes, opts.baseMM, opts.baseMM + L.height, triangulate), shapes, top: opts.baseMM + L.height });
    }
    // center on the build plate origin
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const o of out) { const p = o.mesh.positions; for (let i = 0; i < p.length; i += 3) { if (p[i] < minx) minx = p[i]; if (p[i] > maxx) maxx = p[i]; if (p[i + 1] < miny) miny = p[i + 1]; if (p[i + 1] > maxy) maxy = p[i + 1]; } }
    const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
    for (const o of out) { const p = o.mesh.positions; for (let i = 0; i < p.length; i += 3) { p[i] -= cx; p[i + 1] -= cy; } }
    return { parts: out, size: [maxx - minx, maxy - miny], mmPerPx, map: { cx, cy, pad, H, mmPerPx } };
  }

  // ---------- coin / token ----------
  // Distance (art px) from the art's centre to its farthest subject pixel; used to fit art in a circle.
  function artRadiusPx(prep) {
    const { width: w, height: h, mask } = prep, cx = (w - 1) / 2, cy = (h - 1) / 2;
    let m = 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { const d = Math.hypot(x - cx, y - cy) + 0.71; if (d > m) m = d; }
    return m;
  }
  function concatMeshes(ms) {
    let nv = 0, ni = 0; for (const m of ms) { nv += m.positions.length; ni += m.indices.length; }
    const P = new Float32Array(nv), I = new Uint32Array(ni); let pv = 0, pi = 0;
    for (const m of ms) { P.set(m.positions, pv); for (let k = 0; k < m.indices.length; k++) I[pi + k] = m.indices[k] + pv / 3; pv += m.positions.length; pi += m.indices.length; }
    return { positions: P, indices: I };
  }
  // opts: diameterMM, thicknessMM, rimWidthMM, rimHeightMM, marginMM, mode ('raise'|'engrave'|'inlay'),
  //       depthMM, artScale (1 = fit), offsetXMM, offsetYMM, smoothMM, layerOf[label] -> layer id | -1, layers [{id,height}], rimLayer (id|-1)
  function buildCoin(prep, opts, triangulate) {
    const D = opts.diameterMM, res = Math.max(0.08, D / 700);
    const N0 = Math.ceil(D / res) + 7, W = N0, H = N0, c = (N0 - 1) / 2, N = W * H;
    const R = D / 2 / res, rimW = Math.min(opts.rimWidthMM, D / 2 - 1), Ri = (D / 2 - rimW) / res;
    const artR = Math.max(0.5, (D / 2 - rimW - (opts.marginMM || 0)) * (opts.artScale || 1));
    const rad = artRadiusPx(prep), kArt = artR / rad; // mm per art pixel
    const aw = prep.width, ah = prep.height, acx = (aw - 1) / 2, acy = (ah - 1) / 2;
    const offX = opts.offsetXMM || 0, offY = opts.offsetYMM || 0;
    const ids = opts.layers.filter(L => L.height > 0).map(L => L.id);
    const idSet = new Set(ids);
    // soft circle coverages (1 px ramp) so circular edges trace exactly
    const cov = (rr, r) => Math.max(0, Math.min(1, rr - r + 0.5));
    const cOut = new Float32Array(N), cIn = new Float32Array(N), lab = new Int32Array(N).fill(-1);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, r = Math.hypot(x - c, y - c);
      cOut[i] = cov(R, r); cIn[i] = rimW > 0 ? cov(Ri, r) : cOut[i];
      const X = (x - c) * res, Y = (c - y) * res;
      const ax = Math.round((X - offX) / kArt + acx), ay = Math.round(acy - (Y - offY) / kArt);
      if (ax < 0 || ay < 0 || ax >= aw || ay >= ah) continue;
      const j = ay * aw + ax; if (!prep.mask[j] || prep.labels[j] < 0) continue;
      const L = opts.layerOf[prep.labels[j]]; if (L >= 0 && idSet.has(L)) lab[i] = L;
    }
    const sPx = (opts.smoothMM || 0) / res, fields = new Map(), ind = new Float32Array(N);
    const artSum = new Float32Array(N);
    for (const id of ids) {
      let any = false; for (let i = 0; i < N; i++) { const v = lab[i] === id ? 1 : 0; ind[i] = v; if (v) any = true; }
      if (!any) continue;
      const b = blurField(ind, W, H, sPx);
      for (let i = 0; i < N; i++) { b[i] *= cIn[i]; artSum[i] += b[i]; }
      fields.set(id, b);
    }
    const FIELD = -2, RIM = -3, BG = -1;
    const fField = new Float32Array(N), fRim = new Float32Array(N), fBG = new Float32Array(N);
    for (let i = 0; i < N; i++) { fField[i] = Math.max(0, cIn[i] - artSum[i]); fRim[i] = Math.max(0, cOut[i] - cIn[i]); fBG[i] = 1 - cOut[i]; }
    fields.set(FIELD, fField); if (rimW > 0) fields.set(RIM, fRim); fields.set(BG, fBG);
    // each region's edge is where it stops beating every rival (shared boundaries, no gaps)
    const best = new Float32Array(N).fill(-1), second = new Float32Array(N).fill(-1), bestId = new Int32Array(N).fill(-99);
    for (const [id, f] of fields) for (let i = 0; i < N; i++) { const v = f[i]; if (v > best[i]) { second[i] = best[i]; best[i] = v; bestId[i] = id; } else if (v > second[i]) second[i] = v; }
    const tol = opts.simplifyPx == null ? 0.2 : opts.simplifyPx, minA = opts.minAreaPx || 4, d = new Float32Array(N);
    const shapesOf = id => { const f = fields.get(id); if (!f) return []; for (let i = 0; i < N; i++) d[i] = f[i] - (bestId[i] === id ? second[i] : best[i]); return loopsToShapes(marchingSquares(d, W, H, 0), H, res, tol, minA); };
    const T = opts.thicknessMM, dep = opts.mode === 'raise' ? 0 : Math.min(opts.depthMM, T - 0.4), Tb = T - dep;
    const rimH = opts.rimHeightMM || 0;
    // disc footprint: everything that isn't background
    for (let i = 0; i < N; i++) d[i] = (1 - fBG[i]) - fBG[i];
    const discShapes = loopsToShapes(marchingSquares(d, W, H, 0), H, res, tol, minA);
    const out = [], baseMeshes = [extrudeShapes(discShapes, 0, Tb, triangulate)];
    if (dep > 0) baseMeshes.push(extrudeShapes(shapesOf(FIELD), Tb, T, triangulate));
    let rimPart = null;
    if (rimW > 0 && (dep > 0 || rimH > 0)) {
      const rs = shapesOf(RIM), m = extrudeShapes(rs, Tb, T + rimH, triangulate);
      if (opts.rimLayer != null && opts.rimLayer >= 0) rimPart = { id: opts.rimLayer, mesh: m, shapes: rs, top: T + rimH }; else baseMeshes.push(m);
    }
    out.push({ id: 'base', mesh: concatMeshes(baseMeshes), shells: baseMeshes, shapes: discShapes, top: T });
    if (rimPart) out.push(rimPart);
    if (opts.mode !== 'engrave') for (const L of opts.layers) {
      if (!fields.has(L.id)) continue;
      const sh = shapesOf(L.id); if (!sh.length) continue;
      const z0 = opts.mode === 'raise' ? T : Tb, z1 = opts.mode === 'raise' ? T + L.height : T;
      out.push({ id: L.id, mesh: extrudeShapes(sh, z0, z1, triangulate), shapes: sh, top: z1 });
    }
    const sh = (H - 1 - c) * res, sx = c * res;
    let top = T;
    for (const o of out) { const p = o.mesh.positions; for (let i = 0; i < p.length; i += 3) { p[i] -= sx; p[i + 1] -= sh; if (p[i + 2] > top) top = p[i + 2]; } }
    const toArt = (x, y) => [(x - offX) / kArt + acx, acy - (y - offY) / kArt];
    return { parts: out, size: [D, D], height: top, mmPerPx: kArt, map: { toArt } };
  }

  // ---------- keychain ----------
  // Morphology on 0/1 masks via the exact distance transform (radii in px).
  function dilateMask(m, w, h, r) { const d = edt(m, w, h), o = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) o[i] = d[i] <= r ? 1 : 0; return o; }
  function erodeMask(m, w, h, r) { const inv = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) inv[i] = m[i] ? 0 : 1; const d = edt(inv, w, h), o = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) o[i] = d[i] > r ? 1 : 0; return o; }
  function fillHoles(m, w, h) {
    const out = new Uint8Array(w * h), st = []; // out=1: background reachable from the border
    const push = i => { if (!m[i] && !out[i]) { out[i] = 1; st.push(i); } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (st.length) { const i = st.pop(), x = i % w; if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (i >= w) push(i - w); if (i < w * (h - 1)) push(i + w); }
    for (let i = 0; i < w * h; i++) out[i] = out[i] ? 0 : 1;
    return out;
  }
  // Shape outlines in mm, centred on their bounding box and scaled so the longest side is S.
  function kcShape(shape, S, o = {}) {
    if (shape === 'rect') { // bookmark: W x H rounded rectangle
      const w = o.w || S, h = o.h || S, rc = Math.max(0, Math.min(o.corner || 0, w / 2 - 0.01, h / 2 - 0.01)), hx = w / 2, hy = h / 2;
      return { w, h, inside: (x, y) => { const qx = Math.abs(x) - (hx - rc), qy = Math.abs(y) - (hy - rc); return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rc <= 0; } };
    }
    if (shape === 'circle') { const r = S / 2; return { w: S, h: S, inside: (x, y) => x * x + y * y <= r * r }; }
    if (shape === 'square') {
      const hf = S / 2, rc = 0.14 * S;
      return { w: S, h: S, inside: (x, y) => { const qx = Math.abs(x) - (hf - rc), qy = Math.abs(y) - (hf - rc); return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rc <= 0; } };
    }
    let polys = [], circles = [], rects = [];
    if (shape === 'hexagon') {
      const v = []; for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; v.push([Math.cos(a), Math.sin(a)]); } // flat top and bottom
      polys.push(v);
    } else if (shape === 'star') {
      const v = []; for (let k = 0; k < 10; k++) { const a = Math.PI / 2 + k * Math.PI / 5, r = k % 2 ? 0.5 : 1; v.push([r * Math.cos(a), r * Math.sin(a)]); }
      polys.push(v);
    } else { // cloud: flat-bottomed puffs
      circles = [[-0.50, -0.05, 0.33], [-0.12, 0.28, 0.42], [0.32, 0.22, 0.38], [0.62, -0.08, 0.30], [0.05, 0.07, 0.45]];
      rects = [[-0.50, -0.38, 0.62, -0.05]];
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
    polys.forEach(p => p.forEach(([x, y]) => grow(x, y)));
    circles.forEach(([x, y, r]) => { grow(x - r, y - r); grow(x + r, y + r); });
    rects.forEach(([a, b, c, d]) => { grow(a, b); grow(c, d); });
    const k = S / Math.max(x1 - x0, y1 - y0), mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const P = polys.map(p => p.map(([x, y]) => [(x - mx) * k, (y - my) * k]));
    const Cc = circles.map(([x, y, r]) => [(x - mx) * k, (y - my) * k, r * k]);
    const Rr = rects.map(([a, b, c, d]) => [(a - mx) * k, (b - my) * k, (c - mx) * k, (d - my) * k]);
    return { w: (x1 - x0) * k, h: (y1 - y0) * k, inside: (x, y) => P.some(p => pointInPoly([x, y], p)) || Cc.some(([a, b, r]) => (x - a) ** 2 + (y - b) ** 2 <= r * r) || Rr.some(([a, b, c, d]) => x >= a && x <= c && y >= b && y <= d) };
  }
  // filler shapes in a unit circle (u right, v up)
  const STAR4 = (() => { const v = []; for (let k = 0; k < 8; k++) { const a = Math.PI / 2 + k * Math.PI / 4, r = k % 2 ? 0.3 : 1; v.push([r * Math.cos(a), r * Math.sin(a)]); } return v; })();
  const STAR5 = (() => { const v = []; for (let k = 0; k < 10; k++) { const a = Math.PI / 2 + k * Math.PI / 5, r = k % 2 ? 0.45 : 1; v.push([r * Math.cos(a), r * Math.sin(a)]); } return v; })();
  function fillShape(kind) {
    if (kind === 'star4') return (u, v) => pointInPoly([u, v], STAR4);
    if (kind === 'star5') return (u, v) => pointInPoly([u, v], STAR5);
    if (kind === 'heart') return (u, v) => { const x = u * 1.25, y = v * 1.25 + 0.15; const a = x * x + y * y - 1; return a * a * a - x * x * y * y * y <= 0; };
    return (u, v) => u * u + v * v <= 0.72; // dot
  }
  function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  // Largest scale (mm per art px) and centre at which every outline point of the art lands where ok(X,Y) is true.
  function fitArtInShape(prep, ok, bw, bh) {
    const { width: aw, height: ah, mask } = prep, acx = (aw - 1) / 2, acy = (ah - 1) / 2, pts = [];
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
      const i = y * aw + x; if (!mask[i]) continue;
      if (x === 0 || y === 0 || x === aw - 1 || y === ah - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - aw] || !mask[i + aw]) pts.push([x - acx, acy - y]);
    }
    const step = Math.max(1, Math.floor(pts.length / 700)), P = pts.filter((_, i) => i % step === 0);
    const fits = (cx, cy, k) => P.every(([u, v]) => ok(cx + u * k, cy + v * k));
    const bestK = (cx, cy) => {
      if (!ok(cx, cy)) return 0;
      let lo = 0, hi = Math.max(bw, bh) / Math.max(aw, ah) * 1.2;
      for (let it = 0; it < 18; it++) { const mid = (lo + hi) / 2; if (fits(cx, cy, mid)) lo = mid; else hi = mid; }
      return lo;
    };
    const cands = [{ x: 0, y: 0, k: bestK(0, 0) }];
    let best = cands[0], span = Math.max(bw, bh) / 2, n = 6;
    for (let round = 0; round < 3; round++) {
      const c0 = best;
      for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
        const x = c0.x + i * span / n, y = c0.y + j * span / n, k = bestK(x, y);
        cands.push({ x, y, k }); if (k > best.k) best = { x, y, k };
      }
      span /= n / 1.5;
    }
    // near-ties: prefer the placement closest to the middle of the shape (keeps the art centred)
    const good = cands.filter(c => c.k >= best.k * 0.96);
    good.sort((a, b) => (Math.abs(a.x) + Math.abs(a.y) * 0.5) - (Math.abs(b.x) + Math.abs(b.y) * 0.5));
    return good[0] || best;
  }
  // Flat keychain: body + art colours all finish at one top height. Colours fill the top colorDepthMM.
  // opts: shape ('outline'|'circle'|'square'|'star'|'cloud'), sizeMM (longest side of the body), thicknessMM, colorDepthMM,
  //       marginMM (space around the art), fillGapsMM (outline only), artScale, offsetXMM, offsetYMM (shapes only),
  //       holePos ('top'|'top-left'|'top-right'|'left'|'right'|'none'), holeDiaMM, ringWallMM, smoothMM,
  //       layerOf[label] -> layer id | -1, layers [{id}], marginLayer (id | -1: surround prints in the base filament)
  function buildKeychain(prep, opts, triangulate) {
    const aw = prep.width, ah = prep.height, acx = (aw - 1) / 2, acy = (ah - 1) / 2;
    const S = opts.sizeMM, shape = opts.shape || 'outline', rimW = Math.max(0, opts.rimWidthMM || 0), m = Math.max(0, opts.marginMM) + rimW;
    const hole = opts.holePos && opts.holePos !== 'none';
    const Rh = (opts.holeDiaMM || 4) / 2, Ro = Rh + (opts.ringWallMM || 2.5), gap = Math.min(1.5, (Ro - Rh) * 0.5);
    let bw, bh, sh = null, kArt, artCX = 0, artCY = 0;
    if (shape === 'outline') { kArt = Math.max(0.5, S - 2 * m) / Math.max(aw, ah); bw = aw * kArt + 2 * m; bh = ah * kArt + 2 * m; }
    else { sh = kcShape(shape, S, { w: opts.rectWMM, h: opts.rectHMM, corner: opts.cornerMM }); bw = sh.w; bh = sh.h; }
    // room for the ring tab and its fillet, and for the gap-filling dilation to grow and shrink back cleanly
    const pad = Math.max(hole ? 2 * Ro + gap + 2 : 0, shape === 'outline' ? Math.max(0, opts.fillGapsMM || 0) + 1 : 0) + 3;
    const res = Math.max(0.05, (Math.max(bw, bh) + 2 * pad) / 800);
    const W = Math.ceil((bw + 2 * pad) / res) + 2, H = Math.ceil((bh + 2 * pad) / res) + 2, N = W * H, cx = (W - 1) / 2, cy = (H - 1) / 2;
    const Xof = x => (x - cx) * res, Yof = y => (cy - y) * res;
    let body = new Uint8Array(N);
    if (shape === 'outline') {
      const sil = new Uint8Array(N);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const ax = Math.round(Xof(x) / kArt + acx), ay = Math.round(acy - Yof(y) / kArt);
        if (ax >= 0 && ay >= 0 && ax < aw && ay < ah && prep.mask[ay * aw + ax]) sil[y * W + x] = 1;
      }
      const g = Math.max(0, opts.fillGapsMM || 0) / res;
      body = erodeMask(dilateMask(sil, W, H, m / res + g), W, H, g); // grow by the margin, then close gaps narrower than 2·fillGaps
      body = fillHoles(body, W, H);
    } else {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (sh.inside(Xof(x), Yof(y))) body[y * W + x] = 1;
      if (shape === 'star' || shape === 'hexagon') { const r = (shape === 'star' ? 0.035 : 0.03) * S / res; body = dilateMask(erodeMask(body, W, H, r), W, H, r); } // soften the corners
      // tassel hole punched through near the top edge (bookmarks); the art fits around it
      if (opts.tassel && opts.tassel.diaMM > 0) {
        const rr = opts.tassel.diaMM / 2, ty = bh / 2 - Math.max(rr + 1, opts.tassel.fromEdgeMM || 0), rp = rr / res, tcx = cx, tcy = cy - ty / res;
        for (let y = Math.max(0, Math.floor(tcy - rp - 1)); y <= Math.min(H - 1, Math.ceil(tcy + rp + 1)); y++)
          for (let x = Math.max(0, Math.floor(tcx - rp - 1)); x <= Math.min(W - 1, Math.ceil(tcx + rp + 1)); x++)
            if (Math.hypot(x - tcx, y - tcy) <= rp) body[y * W + x] = 0;
      }
      // fit the art's real silhouette as large as possible inside the shape (inset by the margin)
      const inv = new Uint8Array(N); for (let i = 0; i < N; i++) inv[i] = body[i] ? 0 : 1;
      const dIn = edt(inv, W, H), need = m / res;
      const fit = fitArtInShape(prep, (X, Y) => { const gx = Math.round(X / res + cx), gy = Math.round(cy - Y / res); return gx >= 0 && gy >= 0 && gx < W && gy < H && dIn[gy * W + gx] >= need; }, bw, bh);
      kArt = Math.max(1e-3, fit.k) * (opts.artScale || 1); artCX = fit.x + (opts.offsetXMM || 0); artCY = fit.y + (opts.offsetYMM || 0);
    }
    // art labels, kept a little inside the edge
    const inv2 = new Uint8Array(N); for (let i = 0; i < N; i++) inv2[i] = body[i] ? 0 : 1;
    const dInside = edt(inv2, W, H), inset = rimW > 0 ? (rimW + Math.min(Math.max(0, opts.marginMM), 1)) / res : shape === 'outline' ? 0 : Math.min(m, 1) / res;
    const idSet = new Set(opts.layers.map(L => L.id)), lab = new Int32Array(N).fill(-1);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (!body[i] || dInside[i] <= inset) continue;
      const ax = Math.round((Xof(x) - artCX) / kArt + acx), ay = Math.round(acy - (Yof(y) - artCY) / kArt);
      if (ax < 0 || ay < 0 || ax >= aw || ay >= ah) continue;
      const j = ay * aw + ax; if (!prep.mask[j] || prep.labels[j] < 0) continue;
      const L = opts.layerOf[prep.labels[j]]; if (L >= 0 && idSet.has(L)) lab[i] = L;
    }
    // minimum line width: colour features narrower than this (thin outlines, mouths, seams) are widened
    // so the nozzle can actually lay them down; wider features are left alone
    let thinFixed = 0, thinChanged = 0;
    if (opts.minLineMM > 0) {
      const r = opts.minLineMM / 2 / res, labs = [...new Set(lab)].filter(L => L >= 0);
      const inBody = new Uint8Array(N); for (let i = 0; i < N; i++) inBody[i] = body[i] && dInside[i] > inset ? 1 : 0;
      const grow = [];
      for (const L of labs) {
        const M = new Uint8Array(N); for (let i = 0; i < N; i++) M[i] = lab[i] === L ? 1 : 0;
        const opened = dilateMask(erodeMask(M, W, H, r), W, H, r + 0.5), thin = new Uint8Array(N); let any = 0;
        for (let i = 0; i < N; i++) if (M[i] && !opened[i]) { thin[i] = 1; any++; }
        if (any < 3) continue;
        // half-width of each thin pixel's stroke, then grow just enough to reach the minimum
        const inv = new Uint8Array(N); for (let i = 0; i < N; i++) inv[i] = M[i] ? 0 : 1;
        const half = edt(inv, W, H); let t = 0, n = 0; for (let i = 0; i < N; i++) if (thin[i]) { t += half[i]; n++; }
        const g = Math.max(1, r - t / n + 0.5);
        grow.push([L, dilateMask(thin, W, H, g), thin]); thinFixed += any;
      }
      // a thin line may only spread over the face or over a lighter colour (dark outlines on light fills
      // are the usual case), and never over another colour's own thin feature
      const rank = new Map((opts.darkToLight || []).map((L, i) => [L, i])), rk = L => rank.has(L) ? rank.get(L) : 1e6;
      for (const [L, G] of grow) for (let i = 0; i < N; i++) if (G[i] && inBody[i] && lab[i] !== L) {
        if (lab[i] >= 0 && rk(lab[i]) <= rk(L)) continue;
        if (lab[i] >= 0 && grow.some(([L2, , T2]) => L2 === lab[i] && T2[i])) continue;
        lab[i] = L; thinChanged++;
      }
    }
    // key-ring tab: walk in from outside along the chosen direction until the hole sits just clear of the body
    let fp = body, P = null;
    if (hole) {
      const dirs = { top: [0, 1], 'top-left': [-Math.SQRT1_2, Math.SQRT1_2], 'top-right': [Math.SQRT1_2, Math.SQRT1_2], left: [-1, 0], right: [1, 0] };
      const dv = dirs[opts.holePos] || dirs.top;
      let sx = 0, sy = 0, n = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (body[y * W + x]) { sx += Xof(x); sy += Yof(y); n++; }
      const c0 = [n ? sx / n : 0, n ? sy / n : 0], dB = edt(body, W, H), want = (Rh + gap) / res;
      for (let t = Math.max(W, H) * res; t >= 0; t -= res * 0.5) {
        const px = c0[0] + dv[0] * t, py = c0[1] + dv[1] * t, gx = Math.round(px / res + cx), gy = Math.round(cy - py / res);
        if (gx < 0 || gy < 0 || gx >= W || gy >= H) continue;
        if (dB[gy * W + gx] <= want) { P = [gx, gy]; break; }
      }
      if (P) {
        fp = new Uint8Array(body); const ro = Ro / res;
        for (let y = Math.max(0, Math.floor(P[1] - ro - 1)); y <= Math.min(H - 1, Math.ceil(P[1] + ro + 1)); y++)
          for (let x = Math.max(0, Math.floor(P[0] - ro - 1)); x <= Math.min(W - 1, Math.ceil(P[0] + ro + 1)); x++)
            if (Math.hypot(x - P[0], y - P[1]) <= ro) fp[y * W + x] = 1;
        const rf = Math.min(2, Ro * 0.7) / res; // fillet where the tab meets the body
        fp = fillHoles(erodeMask(dilateMask(fp, W, H, rf), W, H, rf), W, H);
      }
    }
    const sPx = (opts.smoothMM || 0) / res;
    const fpSoft = blurField(fp, W, H, Math.max(0.8, sPx));
    if (P) { const rh = Rh / res; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const r = Math.hypot(x - P[0], y - P[1]); if (r < rh + 1) fpSoft[y * W + x] *= 1 - Math.max(0, Math.min(1, rh - r + 0.5)); } }
    // the face inside a raised rim (no rim: the whole footprint)
    let inner = fpSoft;
    if (rimW > 0) inner = blurField(erodeMask(fp, W, H, rimW / res), W, H, Math.max(0.8, sPx));
    // filler shapes scattered over the empty face (stars, hearts, dots), as one extra colour part
    let fillers = 0;
    if (opts.fill && opts.fill.layerId != null && opts.fill.count > 0 && idSet.has(opts.fill.layerId)) {
      const F = opts.fill, FID = F.layerId, rnd = mulberry32((F.seed >>> 0) || 1);
      const edgeM = new Uint8Array(N), artM = new Uint8Array(N);
      for (let i = 0; i < N; i++) { edgeM[i] = inner[i] < 0.5 ? 1 : 0; artM[i] = lab[i] >= 0 ? 1 : 0; }
      const dEdge = edt(edgeM, W, H), dArt = edt(artM, W, H);
      const rMax = Math.max(F.minMM, F.maxMM) / 2 / res, rMin = Math.max(0.6, Math.min(F.minMM, F.maxMM)) / 2 / res;
      const gapPx = Math.max(0, F.gapMM) / res, edgePx = Math.max(0, F.edgeMM == null ? 1 : F.edgeMM) / res;
      const kinds = F.shape === 'mix' ? ['star4', 'star5', 'heart', 'dot'] : [F.shape];
      const placed = [];
      // biggest first, then smaller ones settle into the gaps that are left
      const tries = Math.min(60000, 400 * F.count);
      for (let t = 0; t < tries && placed.length < F.count; t++) {
        const r = rMax - (rMax - rMin) * Math.min(1, t / (tries * 0.6)) * (0.6 + 0.4 * rnd());
        const x = Math.floor(rnd() * W), y = Math.floor(rnd() * H), i = y * W + x;
        if (dEdge[i] < r + edgePx || dArt[i] < r + gapPx) continue;
        let ok = true;
        for (const q of placed) if ((q.x - x) ** 2 + (q.y - y) ** 2 < (q.r + r + gapPx) ** 2) { ok = false; break; }
        if (!ok) continue;
        const kind = kinds[Math.floor(rnd() * kinds.length)];
        const rot = kind === 'heart' ? (rnd() - 0.5) * 0.7 : kind === 'dot' ? 0 : rnd() * Math.PI;
        placed.push({ x, y, r, kind, rot });
      }
      for (const q of placed) {
        const inside = fillShape(q.kind), c = Math.cos(q.rot), sn = Math.sin(q.rot);
        for (let y = Math.max(0, Math.floor(q.y - q.r - 1)); y <= Math.min(H - 1, Math.ceil(q.y + q.r + 1)); y++)
          for (let x = Math.max(0, Math.floor(q.x - q.r - 1)); x <= Math.min(W - 1, Math.ceil(q.x + q.r + 1)); x++) {
            const u = ((x - q.x) * c + (y - q.y) * sn) / q.r, v = (-(x - q.x) * sn + (y - q.y) * c) / q.r;
            const i = y * W + x; if (lab[i] < 0 && inside(u, -v)) lab[i] = FID;
          }
      }
      fillers = placed.length;
    }
    // partition: each colour, the surround/face, the rim, and the background
    const fields = new Map(), ind = new Float32Array(N), artSum = new Float32Array(N);
    for (const id of idSet) {
      let any = false; for (let i = 0; i < N; i++) { const v = lab[i] === id ? 1 : 0; ind[i] = v; if (v) any = true; }
      if (!any) continue;
      const b = blurField(ind, W, H, sPx);
      for (let i = 0; i < N; i++) { b[i] *= inner[i]; artSum[i] += b[i]; }
      fields.set(id, b);
    }
    const FIELD = -2, BG = -1, RIM = -3, fF = new Float32Array(N), fB = new Float32Array(N);
    for (let i = 0; i < N; i++) { fF[i] = Math.max(0, inner[i] - artSum[i]); fB[i] = 1 - fpSoft[i]; }
    fields.set(FIELD, fF); fields.set(BG, fB);
    if (rimW > 0) { const fR = new Float32Array(N); for (let i = 0; i < N; i++) fR[i] = Math.max(0, fpSoft[i] - inner[i]); fields.set(RIM, fR); }
    const best = new Float32Array(N).fill(-1), second = new Float32Array(N).fill(-1), bestId = new Int32Array(N).fill(-99);
    for (const [id, f] of fields) for (let i = 0; i < N; i++) { const v = f[i]; if (v > best[i]) { second[i] = best[i]; best[i] = v; bestId[i] = id; } else if (v > second[i]) second[i] = v; }
    const tol = opts.simplifyPx == null ? 0.2 : opts.simplifyPx, minA = opts.minAreaPx || 4, d = new Float32Array(N);
    const shapesOf = id => { const f = fields.get(id); if (!f) return []; for (let i = 0; i < N; i++) d[i] = f[i] - (bestId[i] === id ? second[i] : best[i]); return loopsToShapes(marchingSquares(d, W, H, 0), H, res, tol, minA); };
    for (let i = 0; i < N; i++) d[i] = 2 * fpSoft[i] - 1;
    const outline = loopsToShapes(marchingSquares(d, W, H, 0), H, res, tol, minA);
    const T = opts.thicknessMM, dep = Math.max(0.2, Math.min(opts.colorDepthMM, T)), Tb = T - dep > 0.05 ? T - dep : 0;
    const out = [], baseMeshes = [], warnings = [];
    // cuts into the body below the colours: magnet pockets and a cork/felt recess
    const cuts = []; let pockets = [], pauseZ = null;
    const roof = Tb - 0.4; // keep at least 0.4 mm of body above any cut
    if (opts.pockets && opts.pockets.count > 0) {
      const pk = opts.pockets, R = pk.diaMM / 2, wall = 1.2, z0 = pk.hidden ? pk.floorMM : 0, z1 = z0 + pk.depthMM;
      if (z1 > roof) warnings.push(`Not enough thickness above the magnet. Raise the thickness to at least ${(z1 + 0.4 + dep).toFixed(1)} mm.`);
      const fpIn = new Uint8Array(N); for (let i = 0; i < N; i++) fpIn[i] = fpSoft[i] >= 0.5 ? 0 : 1;
      const dIn = edt(fpIn, W, H), need = (R + wall) / res, step = Math.max(1, Math.round(0.5 / res));
      let sx = 0, sy = 0, n = 0;
      for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) if (dIn[y * W + x] >= need) { sx += x; sy += y; n++; }
      if (!n) warnings.push('The magnet is too big for this shape. Use a smaller magnet or a bigger size.');
      else {
        const cx0 = sx / n, cy0 = sy / n;
        for (let k = 0; k < pk.count; k++) {
          let bi = -1, bs = -Infinity;
          for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
            const i = y * W + x; if (dIn[i] < need) continue;
            let sc;
            if (!pockets.length) sc = -Math.hypot(x - cx0, y - cy0) + dIn[i] * 0.25; // first magnet: near the middle
            else { let mn = Infinity; for (const [px, py] of pockets) mn = Math.min(mn, Math.hypot(x - px, y - py)); if (mn < (2 * R + 2) / res) continue; sc = mn + dIn[i] * 0.25; } // others: spread out
            if (sc > bs) { bs = sc; bi = i; }
          }
          if (bi < 0) { warnings.push(`Only room for ${pockets.length} magnet${pockets.length === 1 ? '' : 's'} at this size.`); break; }
          pockets.push([bi % W, (bi / W) | 0]);
        }
        const cov = new Float32Array(N), rp = R / res;
        for (const [px, py] of pockets) for (let y = Math.max(0, Math.floor(py - rp - 2)); y <= Math.min(H - 1, Math.ceil(py + rp + 2)); y++) for (let x = Math.max(0, Math.floor(px - rp - 2)); x <= Math.min(W - 1, Math.ceil(px + rp + 2)); x++) {
          const c = Math.max(0, Math.min(1, rp - Math.hypot(x - px, y - py) + 0.5)); if (c > cov[y * W + x]) cov[y * W + x] = c;
        }
        cuts.push({ cov, z0, z1: Math.min(z1, Math.max(z0 + 0.2, roof)) });
        if (pk.hidden) pauseZ = Math.min(z1, roof);
      }
    }
    if (opts.recess && opts.recess.depthMM > 0) {
      const rz = Math.min(opts.recess.depthMM, Math.max(0.2, roof));
      cuts.push({ cov: blurField(erodeMask(fp, W, H, opts.recess.insetMM / res), W, H, Math.max(0.8, sPx)), z0: 0, z1: rz });
    }
    // body below the colours, sliced wherever a cut starts or stops
    if (Tb > 0) {
      const zs = [...new Set([0, Tb, ...cuts.flatMap(c => [c.z0, c.z1]).filter(z => z > 0 && z < Tb)])].sort((p, q) => p - q);
      for (let k = 0; k + 1 < zs.length; k++) {
        const za = zs[k], zb = zs[k + 1], act = cuts.filter(c => c.z0 <= za + 1e-6 && c.z1 >= zb - 1e-6);
        let shp = outline;
        if (act.length) { for (let i = 0; i < N; i++) { let v = fpSoft[i]; for (const c of act) v *= 1 - c.cov[i]; d[i] = 2 * v - 1; } shp = loopsToShapes(marchingSquares(d, W, H, 0), H, res, tol, minA); }
        baseMeshes.push(extrudeShapes(shp, za, zb, triangulate));
      }
    }
    if (rimW > 0) {
      const rs = shapesOf(RIM), rtop = T + Math.max(0, opts.rimHeightMM || 0);
      if (rs.length) { const rm = extrudeShapes(rs, Tb, rtop, triangulate); if (opts.rimLayer != null && opts.rimLayer >= 0) out.push({ id: opts.rimLayer, mesh: rm, shapes: rs, top: rtop }); else baseMeshes.push(rm); }
    }
    const fieldShapes = shapesOf(FIELD);
    if (fieldShapes.length) {
      const fm = extrudeShapes(fieldShapes, Tb, T, triangulate);
      if (opts.marginLayer != null && opts.marginLayer >= 0) out.push({ id: opts.marginLayer, mesh: fm, shapes: fieldShapes, top: T });
      else baseMeshes.push(fm);
    }
    if (baseMeshes.length) out.unshift({ id: 'base', mesh: concatMeshes(baseMeshes), shells: baseMeshes, shapes: outline, top: Tb || T });
    for (const L of opts.layers) {
      if (!fields.has(L.id)) continue;
      const shp = shapesOf(L.id); if (!shp.length) continue;
      out.push({ id: L.id, mesh: extrudeShapes(shp, Tb, T, triangulate), shapes: shp, top: T });
    }
    // grid -> mm happened in loopsToShapes with y measured from the bottom row; recentre on the bounding box
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const o of out) { const p = o.mesh.positions; for (let i = 0; i < p.length; i += 3) { if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i]; if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1]; } }
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    for (const o of out) { const p = o.mesh.positions; for (let i = 0; i < p.length; i += 3) { p[i] -= mx; p[i + 1] -= my; } }
    // final mm -> grid mm: X_grid = X + mx - cx*res ; Y_grid = Y + my - (H-1-cy)*res
    const ox = mx - cx * res, oy = my - (H - 1 - cy) * res;
    const toArt = (X, Y) => [((X + ox) - artCX) / kArt + acx, acy - ((Y + oy) - artCY) / kArt];
    let zTop = T; for (const o of out) if (o.top > zTop) zTop = o.top;
    return { parts: out, size: [x1 - x0, y1 - y0], height: zTop, mmPerPx: kArt, hole: !!P, pockets: pockets.length, pauseZ, fillers, thinFixed, thinChanged, warnings, map: { toArt } };
  }

  // ---------- cookie cutter + matching stamp ----------
  // The cutter follows the art's silhouette (narrow gaps closed). Printed lip-down: a wide lip on the bed,
  // the wall above it and a thinner cutting edge at the top. The inside face of the cutter is the cut line.
  // The stamp is a plate just inside the cut line with chosen colours raised as lines, mirrored so the
  // pressed cookie reads the right way round. It sits beside the cutter.
  function buildCookie(prep, opts, triangulate) {
    const aw = prep.width, ah = prep.height, acx = (aw - 1) / 2, acy = (ah - 1) / 2;
    const S = opts.sizeMM, k = S / Math.max(aw, ah), bw = aw * k, bh = ah * k;
    const wall = Math.max(0.4, opts.wallMM), blade = Math.max(0.3, Math.min(opts.bladeMM, wall)), lipW = Math.max(0, opts.lipWidthMM || 0);
    const outer = wall + lipW, g = Math.max(0, opts.fillGapsMM || 0);
    const pad = outer + g + 3, res = Math.max(0.05, (Math.max(bw, bh) + 2 * pad) / 800);
    const W = Math.ceil((bw + 2 * pad) / res) + 2, H = Math.ceil((bh + 2 * pad) / res) + 2, N = W * H, cx = (W - 1) / 2, cy = (H - 1) / 2;
    const Xof = x => (x - cx) * res, Yof = y => (cy - y) * res;
    const sil = new Uint8Array(N), art = new Int32Array(N).fill(-1), idSet = new Set(opts.lineLayers || []);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const ax = Math.round(Xof(x) / k + acx), ay = Math.round(acy - Yof(y) / k);
      if (ax < 0 || ay < 0 || ax >= aw || ay >= ah) continue;
      const j = ay * aw + ax; if (!prep.mask[j]) continue;
      sil[y * W + x] = 1;
      if (prep.labels[j] >= 0) { const L = opts.layerOf[prep.labels[j]]; if (L >= 0 && idSet.has(L)) art[y * W + x] = L; }
    }
    const gp = g / res;
    let body = fillHoles(erodeMask(dilateMask(sil, W, H, gp), W, H, gp), W, H);
    // signed distance to the cut line in px (negative inside), lightly smoothed
    const nb = new Uint8Array(N); for (let i = 0; i < N; i++) nb[i] = body[i] ? 0 : 1;
    const dOut = edt(body, W, H), dIn = edt(nb, W, H), sd0 = new Float32Array(N);
    for (let i = 0; i < N; i++) sd0[i] = body[i] ? -(dIn[i] - 0.5) : dOut[i] - 0.5;
    const sPx = Math.max(1, (opts.smoothMM || 0) / res), sd = blurField(sd0, W, H, sPx);
    const tol = 0.2, minA = 4, d = new Float32Array(N);
    const band = (a, b) => { for (let i = 0; i < N; i++) d[i] = Math.min(sd[i] - a / res, b / res - sd[i]); return loopsToShapes(marchingSquares(d, W, H, 0), H, res, tol, minA); };
    const Hc = opts.heightMM, lipH = lipW > 0 ? Math.min(opts.lipHeightMM || 1.6, Hc / 3) : 0, tip = Math.min(3, Hc / 4);
    const shells = [];
    if (lipH > 0) shells.push(extrudeShapes(band(0, outer), 0, lipH, triangulate));
    shells.push(extrudeShapes(band(0, wall), lipH, Hc - tip, triangulate));
    shells.push(extrudeShapes(band(0, (wall + blade) / 2), Hc - tip, Hc - tip / 2, triangulate));
    shells.push(extrudeShapes(band(0, blade), Hc - tip / 2, Hc, triangulate));
    const out = [{ id: 'base', mesh: concatMeshes(shells), shells, shapes: band(0, outer), top: Hc }];
    // cut-line outline (for the size readout) and mapping
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const P0 = out[0].mesh.positions; for (let i = 0; i < P0.length; i += 3) { if (P0[i] < x0) x0 = P0[i]; if (P0[i] > x1) x1 = P0[i]; if (P0[i + 1] < y0) y0 = P0[i + 1]; if (P0[i + 1] > y1) y1 = P0[i + 1]; }
    const cutW = x1 - x0, cutH = y1 - y0;
    let stampInfo = null;
    if (opts.stamp) {
      const st = opts.stamp, clr = Math.max(0, st.clearanceMM), T = Math.max(1, st.thicknessMM), R = Math.max(0.4, st.reliefMM);
      // mirror the grid left-right: the stamp is pressed face-down
      const sdm = new Float32Array(N), artm = new Int32Array(N);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const a = y * W + x, b = y * W + (W - 1 - x); sdm[a] = sd[b]; artm[a] = art[b]; }
      for (let i = 0; i < N; i++) d[i] = -clr / res - sdm[i];
      const plate = loopsToShapes(marchingSquares(d, W, H, 0), H, res, tol, minA);
      const parts = [{ id: st.plateId, mesh: extrudeShapes(plate, 0, T, triangulate), shapes: plate, top: T }];
      // raised lines: chosen colours, thickened a little, kept inside the plate edge
      const boost = Math.max(0, st.boostMM || 0) / res, keep = (clr + 0.6) / res;
      for (const L of idSet) {
        const m = new Uint8Array(N); let any = false;
        for (let i = 0; i < N; i++) if (artm[i] === L) { m[i] = 1; any = true; }
        if (!any) continue;
        const grown = boost > 0 ? dilateMask(m, W, H, boost) : m, f = new Float32Array(N);
        for (let i = 0; i < N; i++) f[i] = grown[i] && sdm[i] < -keep ? 1 : 0;
        const b = blurField(f, W, H, Math.max(0.8, sPx * 0.6));
        for (let i = 0; i < N; i++) d[i] = 2 * b[i] - 1;
        // drop specks under ~1 mm²: too small to press a mark into dough
        const shp = loopsToShapes(marchingSquares(d, W, H, 0), H, res, tol, Math.max(minA, 1 / (res * res)));
        if (shp.length) parts.push({ id: L, mesh: extrudeShapes(shp, T, T + R, triangulate), shapes: shp, top: T + R });
      }
      // place the stamp to the right of the cutter
      let sx0 = Infinity; for (const p of parts) { const q = p.mesh.positions; for (let i = 0; i < q.length; i += 3) if (q[i] < sx0) sx0 = q[i]; }
      const shift = x1 + 8 - sx0;
      for (const p of parts) { const q = p.mesh.positions; for (let i = 0; i < q.length; i += 3) q[i] += shift; }
      out.push(...parts); stampInfo = { lines: parts.length - 1 };
    }
    // centre everything on the overall bounding box
    let X0 = Infinity, Y0 = Infinity, X1 = -Infinity, Y1 = -Infinity, zTop = 0;
    for (const o of out) { const p = o.mesh.positions; for (let i = 0; i < p.length; i += 3) { if (p[i] < X0) X0 = p[i]; if (p[i] > X1) X1 = p[i]; if (p[i + 1] < Y0) Y0 = p[i + 1]; if (p[i + 1] > Y1) Y1 = p[i + 1]; } if (o.top > zTop) zTop = o.top; }
    const MX = (X0 + X1) / 2, MY = (Y0 + Y1) / 2;
    for (const o of out) { const p = o.mesh.positions; for (let i = 0; i < p.length; i += 3) { p[i] -= MX; p[i + 1] -= MY; } }
    // final -> grid mm (cutter area only): X_grid = X + MX - cx*res ; Y_grid = Y + MY - (H-1-cy)*res
    const ox = MX - cx * res, oy = MY - (H - 1 - cy) * res;
    const toArt = (X, Y) => [(X + ox) / k + acx, acy - (Y + oy) / k];
    return { parts: out, size: [X1 - X0, Y1 - Y0], cutSize: [cutW, cutH], cookieSize: [cutW - 2 * outer, cutH - 2 * outer], height: zTop, mmPerPx: k, stamp: stampInfo, warnings: [], map: { toArt } };
  }

  // ---------- 6. file writers ----------
  function stlBinary(meshes) {
    let tri = 0; for (const m of meshes) tri += m.indices.length / 3;
    const buf = new ArrayBuffer(84 + tri * 50), dv = new DataView(buf);
    dv.setUint32(80, tri, true); let o = 84;
    for (const m of meshes) {
      const p = m.positions, I = m.indices;
      for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
        const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1;
        dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true); o += 12;
        for (const q of [a, b, c]) { dv.setFloat32(o, p[q], true); dv.setFloat32(o + 4, p[q + 1], true); dv.setFloat32(o + 8, p[q + 2], true); o += 12; }
        o += 2;
      }
    }
    return new Uint8Array(buf);
  }

  // AMF for OrcaSlicer / PrusaSlicer: ONE object, one named volume per part, each with its filament slot
  // ("slic3r.extruder", 1-based). Orca imports it as plain geometry (no project prompt), keeps the parts
  // together and applies the slots. No instance is written, so the slicer drops it on the bed centre.
  // parts: [{name, extruder, mesh}] -> UTF-8 bytes of the XML
  function amfXML(parts, objectName) {
    const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    const f = v => +v.toFixed(4);
    const out = ['<?xml version="1.0" encoding="UTF-8"?>\n<amf unit="millimeter" version="1.1">\n<metadata type="cad">3D Maker Generators</metadata>\n<object id="0">\n',
      `<metadata type="name">${esc(objectName || 'Model')}</metadata>\n<mesh>\n<vertices>\n`];
    for (const p of parts) { const P = p.mesh.positions; for (let i = 0; i < P.length; i += 3) out.push(`<vertex><coordinates><x>${f(P[i])}</x><y>${f(P[i + 1])}</y><z>${f(P[i + 2])}</z></coordinates></vertex>\n`); }
    out.push('</vertices>\n');
    let base = 0;
    for (const p of parts) {
      const I = p.mesh.indices;
      out.push(`<volume>\n<metadata type="name">${esc(p.name)}</metadata>\n<metadata type="slic3r.extruder">${Math.max(1, p.extruder | 0)}</metadata>\n`);
      for (let t = 0; t < I.length; t += 3) out.push(`<triangle><v1>${I[t] + base}</v1><v2>${I[t + 1] + base}</v2><v3>${I[t + 2] + base}</v3></triangle>\n`);
      out.push('</volume>\n');
      base += p.mesh.positions.length / 3;
    }
    out.push('</mesh>\n</object>\n</amf>\n');
    return new TextEncoder().encode(out.join(''));
  }

  // parts: [{name, color:'#rrggbb', mesh}] -> 3MF (one object with a component per color)
  function threeMF(parts) {
    const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n<metadata name="Application">Trinket Tray Maker</metadata>\n<resources>\n<basematerials id="1">\n';
    parts.forEach(p => { xml += `<base name="${esc(p.name)}" displaycolor="${p.color.toUpperCase()}FF"/>\n`; });
    xml += '</basematerials>\n';
    const chunks = [xml];
    parts.forEach((p, i) => {
      const P = p.mesh.positions, I = p.mesh.indices, v = [], t = [];
      for (let j = 0; j < P.length; j += 3) v.push(`<vertex x="${+P[j].toFixed(4)}" y="${+P[j + 1].toFixed(4)}" z="${+P[j + 2].toFixed(4)}"/>`);
      for (let j = 0; j < I.length; j += 3) t.push(`<triangle v1="${I[j]}" v2="${I[j + 1]}" v3="${I[j + 2]}"/>`);
      chunks.push(`<object id="${i + 2}" name="${esc(p.name)}" type="model" pid="1" pindex="${i}">\n<mesh>\n<vertices>\n${v.join('\n')}\n</vertices>\n<triangles>\n${t.join('\n')}\n</triangles>\n</mesh>\n</object>\n`);
    });
    const parent = parts.length + 2;
    chunks.push(`<object id="${parent}" name="Trinket tray" type="model">\n<components>\n${parts.map((_, i) => `<component objectid="${i + 2}"/>`).join('\n')}\n</components>\n</object>\n</resources>\n<build>\n<item objectid="${parent}"/>\n</build>\n</model>\n`);
    const enc = new TextEncoder();
    return zip([
      { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>') },
      { name: '_rels/.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>') },
      { name: '3D/3dmodel.model', data: enc.encode(chunks.join('')) },
    ]);
  }

  // OrcaSlicer/Bambu-style 3MF: one object whose parts carry filament slots (model_settings.config).
  // Written tag-less (no Application/OrcaSlicer metadata) so Orca imports it silently as geometry
  // and keeps the current printer/filament presets. parts: [{name, extruder (1-based), color?, mesh}]
  function orca3MF(parts, objectName, opts = {}) {
    const files = orca3MFFiles(parts, objectName), deflate = opts.deflate;
    return zip(deflate ? files.map(f => ({ ...f, deflated: deflate(f.data) })) : files);
  }
  function orca3MFFiles(parts, objectName) {
    const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    const enc = new TextEncoder(), n = parts.length, parent = n + 1;
    const chunks = ['<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n<metadata name="Title">' + esc(objectName) + '</metadata>\n<resources>\n'];
    parts.forEach((p, i) => {
      const P = p.mesh.positions, I = p.mesh.indices, v = [], t = [];
      for (let j = 0; j < P.length; j += 3) v.push(`<vertex x="${+P[j].toFixed(4)}" y="${+P[j + 1].toFixed(4)}" z="${+P[j + 2].toFixed(4)}"/>`);
      for (let j = 0; j < I.length; j += 3) t.push(`<triangle v1="${I[j]}" v2="${I[j + 1]}" v3="${I[j + 2]}"/>`);
      chunks.push(`<object id="${i + 1}" name="${esc(p.name)}" type="model">\n<mesh>\n<vertices>\n${v.join('\n')}\n</vertices>\n<triangles>\n${t.join('\n')}\n</triangles>\n</mesh>\n</object>\n`);
    });
    chunks.push(`<object id="${parent}" name="${esc(objectName)}" type="model">\n<components>\n${parts.map((_, i) => `<component objectid="${i + 1}"/>`).join('\n')}\n</components>\n</object>\n</resources>\n<build>\n<item objectid="${parent}"/>\n</build>\n</model>\n`);
    let cfg = `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <object id="${parent}">\n    <metadata key="name" value="${esc(objectName)}"/>\n    <metadata key="extruder" value="${parts[0].extruder || 1}"/>\n`;
    parts.forEach((p, i) => {
      cfg += `    <part id="${i + 1}" subtype="normal_part">\n      <metadata key="name" value="${esc(p.name)}"/>\n      <metadata key="extruder" value="${p.extruder || 1}"/>\n    </part>\n`;
    });
    cfg += '  </object>\n</config>\n';
    const f = (name, data) => ({ name, data });
    return [
      f('[Content_Types].xml', enc.encode('<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="text/xml"/></Types>')),
      f('_rels/.rels', enc.encode('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')),
      f('3D/3dmodel.model', enc.encode(chunks.join(''))),
      f('Metadata/model_settings.config', enc.encode(cfg)),
    ];
  }

  // minimal store-only ZIP
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(d) { let c = 0xFFFFFFFF; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zip(files) {
    const enc = new TextEncoder(), parts = [], central = []; let off = 0;
    for (const f of files) {
      // f.deflated (optional): raw-deflate bytes of f.data, stored with method 8
      const name = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
      const body = f.deflated || f.data, method = f.deflated ? 8 : 0, csz = body.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, method, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, csz, true); lh.setUint32(22, sz, true); lh.setUint16(26, name.length, true);
      parts.push(new Uint8Array(lh.buffer), name, body);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, method, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, csz, true); ch.setUint32(24, sz, true); ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), name);
      off += 30 + name.length + csz;
    }
    const cdSize = central.reduce((s, a) => s + a.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const total = all.reduce((s, a) => s + a.length, 0), out = new Uint8Array(total); let p = 0;
    for (const a of all) { out.set(a, p); p += a.length; }
    return out;
  }

  // pixels (4-connected) sharing the label at index i
  function componentAt(labels, w, h, i0) {
    const L = labels[i0]; if (L < 0) return null;
    const seen = new Uint8Array(w * h), out = [], stack = [i0]; seen[i0] = 1;
    while (stack.length) {
      const i = stack.pop(); out.push(i);
      const x = i % w, y = (i / w) | 0;
      if (x > 0 && !seen[i - 1] && labels[i - 1] === L) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < w - 1 && !seen[i + 1] && labels[i + 1] === L) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && !seen[i - w] && labels[i - w] === L) { seen[i - w] = 1; stack.push(i - w); }
      if (y < h - 1 && !seen[i + w] && labels[i + w] === L) { seen[i + w] = 1; stack.push(i + w); }
    }
    return Int32Array.from(out);
  }

  const api = { amfXML, orca3MF, orca3MFFiles, buildCookie, buildKeychain, buildCoin, artRadiusPx, simplifyClusters, componentAt, removeBackground, cropAndScale, kmeans, modeFilter, mergeSmall, regionStats, buildTray, stlBinary, threeMF, zip, hex, _ms: marchingSquares, _shapes: loopsToShapes, _edt: edt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TrayCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
