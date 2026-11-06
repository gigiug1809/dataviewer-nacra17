/* Lettura dei metadati MP4/MOV e della telemetria GoPro (GPMF).
   Legge solo l'intestazione e i piccoli blocchi di telemetria: mai il video intero,
   così funziona anche con capitoli GoPro da 12 GB. */
(function (root) {
  'use strict';
  const MAC_EPOCH = 2082844800; // secondi tra 1904-01-01 e 1970-01-01

  // reader: { size, read(offset, length) -> Promise<Uint8Array> }
  function fileReader(file) {
    return {
      size: file.size,
      read: async (off, len) => new Uint8Array(await file.slice(off, off + len).arrayBuffer())
    };
  }

  const fourcc = (u8, p) => String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
  const u32 = (u8, p) => ((u8[p] << 24) >>> 0) + (u8[p + 1] << 16) + (u8[p + 2] << 8) + u8[p + 3];
  const u64 = (u8, p) => u32(u8, p) * 4294967296 + u32(u8, p + 4);
  const u16 = (u8, p) => (u8[p] << 8) + u8[p + 1];

  async function topBoxes(reader) {
    const out = [];
    let p = 0;
    while (p + 8 <= reader.size && out.length < 200) {
      const h = await reader.read(p, 16);
      let size = u32(h, 0), hdr = 8;
      const type = fourcc(h, 4);
      if (size === 1) { size = u64(h, 8); hdr = 16; } else if (size === 0) size = reader.size - p;
      if (size < 8) break;
      out.push({ type, start: p, size, hdr });
      p += size;
    }
    return out;
  }

  function children(u8, s, e) {
    const out = [];
    let p = s;
    while (p + 8 <= e) {
      let size = u32(u8, p), hdr = 8;
      const type = fourcc(u8, p + 4);
      if (size === 1) { size = u64(u8, p + 8); hdr = 16; } else if (size === 0) size = e - p;
      if (size < 8 || p + size > e) break;
      out.push({ type, start: p, end: p + size, data: p + hdr });
      p += size;
    }
    return out;
  }
  const find = (list, t) => list.find(b => b.type === t);
  const kids = (u8, b) => children(u8, b.data, b.end);
  function path(u8, box, ...types) {
    let b = box;
    for (const t of types) { if (!b) return null; b = find(kids(u8, b), t); }
    return b;
  }

  function parseMvhd(u8, b) {
    const p = b.data, v = u8[p];
    if (v === 1) return { created: u64(u8, p + 4), timescale: u32(u8, p + 20), duration: u64(u8, p + 24) };
    return { created: u32(u8, p + 4), timescale: u32(u8, p + 12), duration: u32(u8, p + 16) };
  }
  const parseMdhd = parseMvhd;

  function sampleTable(u8, stbl) {
    const k = kids(u8, stbl);
    const stsz = find(k, 'stsz'), stsc = find(k, 'stsc'), stco = find(k, 'stco'), co64 = find(k, 'co64'), stts = find(k, 'stts');
    if (!stsz || !stsc || !(stco || co64)) return null;
    let p = stsz.data;
    const fixed = u32(u8, p + 4), n = u32(u8, p + 8);
    const sizes = new Array(n);
    for (let i = 0; i < n; i++) sizes[i] = fixed || u32(u8, p + 12 + i * 4);
    const chunks = [];
    if (stco) { p = stco.data; const c = u32(u8, p + 4); for (let i = 0; i < c; i++) chunks.push(u32(u8, p + 8 + i * 4)); }
    else { p = co64.data; const c = u32(u8, p + 4); for (let i = 0; i < c; i++) chunks.push(u64(u8, p + 8 + i * 8)); }
    p = stsc.data;
    const sc = [], scn = u32(u8, p + 4);
    for (let i = 0; i < scn; i++) sc.push([u32(u8, p + 8 + i * 12), u32(u8, p + 12 + i * 12)]);
    const offsets = new Array(n);
    let s = 0;
    for (let c = 0; c < chunks.length && s < n; c++) {
      let per = 1;
      for (let j = sc.length - 1; j >= 0; j--) if (sc[j][0] <= c + 1) { per = sc[j][1]; break; }
      let off = chunks[c];
      for (let q = 0; q < per && s < n; q++) { offsets[s] = off; off += sizes[s]; s++; }
    }
    const deltas = [];
    if (stts) {
      p = stts.data; const c = u32(u8, p + 4);
      for (let i = 0; i < c; i++) { const cnt = u32(u8, p + 8 + i * 8), d = u32(u8, p + 12 + i * 8); for (let q = 0; q < cnt && deltas.length < n; q++) deltas.push(d); }
    }
    return { sizes, offsets, deltas, n };
  }

  async function probe(reader) {
    const top = await topBoxes(reader);
    const moov = find(top, 'moov');
    if (!moov) throw new Error('Non trovo l\'indice del video (moov): il file è incompleto o non è un MP4/MOV.');
    if (moov.size > 400e6) throw new Error('Indice del video troppo grande.');
    const u8 = await reader.read(moov.start, moov.size);
    const root = { type: 'moov', start: 0, end: u8.length, data: moov.hdr };
    const mvhdB = path(u8, root, 'mvhd');
    const mv = mvhdB ? parseMvhd(u8, mvhdB) : { created: 0, timescale: 1000, duration: 0 };
    const info = {
      duration: mv.timescale ? mv.duration / mv.timescale : 0,
      created: mv.created > MAC_EPOCH ? (mv.created - MAC_EPOCH) * 1000 : null, // come scritto nel file (UTC nominale)
      width: 0, height: 0, codec: '', fps: 0, gpmd: null
    };
    for (const trak of kids(u8, root).filter(b => b.type === 'trak')) {
      const mdia = path(u8, trak, 'mdia');
      if (!mdia) continue;
      const hdlr = path(u8, mdia, 'hdlr'), mdhd = path(u8, mdia, 'mdhd'), stbl = path(u8, mdia, 'minf', 'stbl');
      if (!hdlr || !stbl) continue;
      const handler = fourcc(u8, hdlr.data + 8);
      const md = mdhd ? parseMdhd(u8, mdhd) : { timescale: 1, duration: 0 };
      const stsd = path(u8, stbl, 'stsd');
      const fmt = stsd ? fourcc(u8, stsd.data + 12) : '';
      if (handler === 'vide' && !info.codec) {
        info.codec = fmt;
        const tkhd = path(u8, trak, 'tkhd');
        if (tkhd) { const v = u8[tkhd.data], q = tkhd.data + (v === 1 ? 88 : 76); info.width = u32(u8, q) / 65536; info.height = u32(u8, q + 4) / 65536; }
        const st = sampleTable(u8, stbl);
        if (st && md.duration) info.fps = st.n / (md.duration / md.timescale);
      } else if (handler === 'meta' && fmt === 'gpmd') {
        const st = sampleTable(u8, stbl);
        if (st) info.gpmd = { timescale: md.timescale, ...st };
      }
    }
    return info;
  }

  /* ---------- GPMF (telemetria GoPro) ---------- */
  const TYPE_SIZE = { b: 1, B: 1, c: 1, s: 2, S: 2, l: 4, L: 4, f: 4, d: 8, J: 8, j: 8, q: 4, Q: 8 };
  function readNum(dv, p, t) {
    switch (t) {
      case 'b': return dv.getInt8(p); case 'B': return dv.getUint8(p); case 'c': return dv.getUint8(p);
      case 's': return dv.getInt16(p); case 'S': return dv.getUint16(p);
      case 'l': return dv.getInt32(p); case 'L': return dv.getUint32(p);
      case 'f': return dv.getFloat32(p); case 'd': return dv.getFloat64(p);
      case 'q': return dv.getInt32(p) / 65536; case 'Q': return dv.getUint32(p) + dv.getUint32(p + 4) / 4294967296;
      case 'J': return dv.getUint32(p) * 4294967296 + dv.getUint32(p + 4);
      case 'j': return dv.getInt32(p) * 4294967296 + dv.getUint32(p + 4);
    }
    return NaN;
  }
  function klv(u8, dv, s, e, cb) {
    let p = s;
    while (p + 8 <= e) {
      const key = fourcc(u8, p), type = String.fromCharCode(u8[p + 4]), ss = u8[p + 5], rep = u16(u8, p + 6);
      const len = ss * rep, d = p + 8;
      if (d + len > e) break;
      cb(key, type, ss, rep, d, len);
      p = d + ((len + 3) & ~3);
    }
  }
  function gpsuToMs(str) {
    const m = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(?:\.(\d+))?/.exec(str);
    if (!m) return null;
    return Date.UTC(2000 + +m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7] ? Math.round(Number('0.' + m[7]) * 1000) : 0);
  }
  function parsePayload(buf) {
    const u8 = buf, dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const res = { gpsu: null, fix: null, dop: null, pts: [], fmt: null, device: '', grav: [], accl: [] };
    const walk = (s, e, ctx) => klv(u8, dv, s, e, (key, type, ss, rep, d, len) => {
      if (type === '\0') {
        if (key === 'DEVC' || key === 'STRM') walk(d, d + len, key === 'STRM' ? {} : ctx);
        return;
      }
      if (key === 'DVNM' && type === 'c') { res.device = new TextDecoder().decode(u8.subarray(d, d + len)).replace(/\0+$/, ''); return; }
      if (key === 'SCAL') { const n = TYPE_SIZE[type] ? len / TYPE_SIZE[type] : 0; ctx.scal = []; for (let i = 0; i < n; i++) ctx.scal.push(readNum(dv, d + i * TYPE_SIZE[type], type)); return; }
      if (key === 'TYPE') { ctx.type = new TextDecoder().decode(u8.subarray(d, d + len)).replace(/\0+$/, ''); return; }
      if (key === 'GPSU') { res.gpsu = gpsuToMs(new TextDecoder().decode(u8.subarray(d, d + len))); return; }
      if (key === 'GPSF') { res.fix = readNum(dv, d, type); return; }
      if (key === 'GPSP') { res.dop = readNum(dv, d, type) / 100; return; }
      if ((key === 'GRAV' || key === 'ACCL') && (type === 's' || type === 'S')) {
        const sc = (ctx.scal && ctx.scal[0]) || 1, arr = key === 'GRAV' ? res.grav : res.accl;
        for (let r = 0; r < rep; r++) { const q = d + r * ss; arr.push([dv.getInt16(q) / sc, dv.getInt16(q + 2) / sc, dv.getInt16(q + 4) / sc]); }
        return;
      }
      if (key === 'GPS5' && type === 'l') {
        const sc = ctx.scal || [1, 1, 1, 1, 1];
        res.fmt = 'GPS5';
        for (let r = 0; r < rep; r++) {
          const q = d + r * ss, v = [];
          for (let i = 0; i < 5; i++) v.push(dv.getInt32(q + i * 4) / (sc[i] || sc[0] || 1));
          res.pts.push({ lat: v[0], lon: v[1], alt: v[2], s2d: v[3] });
        }
        return;
      }
      if (key === 'GPS9' && type === '?') {
        const tp = ctx.type || 'lllllllSS', sc = ctx.scal || [];
        res.fmt = 'GPS9';
        for (let r = 0; r < rep; r++) {
          let q = d + r * ss; const v = [];
          for (let i = 0; i < tp.length; i++) { const t = tp[i]; v.push(readNum(dv, q, t) / (sc[i] || 1)); q += TYPE_SIZE[t] || 4; }
          // giorni dal 2000-01-01 e secondi dalla mezzanotte (UTC)
          const t = Date.UTC(2000, 0, 1) + v[5] * 86400000 + v[6] * 1000;
          res.pts.push({ lat: v[0], lon: v[1], alt: v[2], s2d: v[3], t, dop: v[7], fix: v[8] });
        }
      }
    });
    walk(0, u8.length, {});
    return res;
  }

  // Estrae dalla telemetria GoPro: traccia GPS, ora UTC esatta dell'inizio del video (dal GPS),
  // assetto della camera dal vettore gravità (10 Hz) e picchi di accelerazione (10 Hz).
  async function goproTelemetry(reader, info, onProgress) {
    const g = info.gpmd;
    if (!g || !g.n) return null;
    const pts = [], deltas = [], att = [], acc = [];
    let vt = 0, device = '';
    const RAD = 180 / Math.PI;
    for (let i = 0; i < g.n; i++) {
      const dur = (g.deltas[i] || g.timescale) / g.timescale;
      let pl;
      try { pl = parsePayload(await reader.read(g.offsets[i], g.sizes[i])); } catch (e) { vt += dur; continue; }
      if (pl.device) device = pl.device;
      const n = pl.pts.length;
      for (let k = 0; k < n; k++) {
        const p = pl.pts[k], fix = p.fix != null ? p.fix : pl.fix, dop = p.dop != null ? p.dop : pl.dop;
        const tv = vt + k / n * dur; // secondi dall'inizio del video
        if (fix != null && fix < 2) continue;
        if (dop != null && dop > 6) continue;
        if (!p.lat && !p.lon) continue;
        pts.push({ vt: tv, lat: p.lat, lon: p.lon, alt: p.alt, sog: p.s2d });
        if (p.t) deltas.push(p.t - tv * 1000);
      }
      if (pl.gpsu && n && (pl.fix == null || pl.fix >= 2)) deltas.push(pl.gpsu - vt * 1000);
      // gravità: Y = verticale della camera, X = laterale, Z = avanti/indietro
      const G = pl.grav, ng = G.length, per = Math.max(1, Math.round(ng / (dur * 10)));
      for (let k = 0; k + per <= ng; k += per) {
        let x = 0, y = 0, z = 0;
        for (let q = k; q < k + per; q++) { x += G[q][0]; y += G[q][1]; z += G[q][2]; }
        att.push([vt + (k + per / 2) / ng * dur, Math.atan2(x, y) * RAD, Math.atan2(z, y) * RAD]);
      }
      const A = pl.accl, na = A.length, pa = Math.max(1, Math.round(na / (dur * 10)));
      for (let k = 0; k + pa <= na; k += pa) {
        let m = 0;
        for (let q = k; q < k + pa; q++) { const a = A[q], v = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); if (v > m) m = v; }
        acc.push([vt + (k + pa / 2) / na * dur, m / 9.80665]);
      }
      vt += dur;
      if (onProgress && i % 50 === 0) onProgress(i / g.n);
    }
    deltas.sort((a, b) => a - b);
    return { device, pts, att, acc, start: deltas.length ? deltas[deltas.length >> 1] : null };
  }

  const MP4 = { fileReader, probe, goproTelemetry, parsePayload };
  root.MP4 = MP4;
  if (typeof module !== 'undefined') module.exports = MP4;
})(typeof window !== 'undefined' ? window : globalThis);
