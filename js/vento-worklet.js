/* Filtro vento per l'audio dei video (GoPro soprattutto): gira in un AudioWorklet, tutto scritto qui, niente librerie.
   1. taglia i bassi dove sta il rombo del vento (sotto 200-300 Hz il vento è ~20 dB più forte della voce);
   2. riduzione del rumore adattiva: stima il fondo di rumore frequenza per frequenza (minimo degli ultimi ~1,5 s)
      e lo abbassa con un filtro di Wiener (con un pavimento, così la voce non diventa "metallica");
   3. più chiarezza: alza 1,5-4 kHz (consonanti), che nella GoPro arrivano molto smorzati;
   4. livella il volume (compressore) e non lascia saturare.
   L'audio della GoPro è uguale sui due canali: si lavora in mono e si esce in mono.
   Lo stesso codice gira anche fuori dal browser (prove sul Mac): la classe WindClean non dipende dall'AudioWorklet. */

/* filtro biquadratico (formule di R. Bristow-Johnson, le stesse dei BiquadFilterNode) */
class Biquad {
  constructor(type, fs, f0, q = Math.SQRT1_2, dB = 0) {
    const A = Math.pow(10, dB / 40), w = 2 * Math.PI * f0 / fs, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (type === 'peak') { b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; }
    else if (type === 'hshelf') {
      const sq = 2 * Math.sqrt(A) * al;
      b0 = A * ((A + 1) + (A - 1) * c + sq); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - sq);
      a0 = (A + 1) - (A - 1) * c + sq; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - sq;
    } else if (type === 'lshelf') {
      const sq = 2 * Math.sqrt(A) * al;
      b0 = A * ((A + 1) - (A - 1) * c + sq); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - sq);
      a0 = (A + 1) + (A - 1) * c + sq; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - sq;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/* FFT reale semplice (radix 2, in place su re/im) */
class FFT {
  constructor(n) {
    this.n = n; this.rev = new Uint32Array(n); this.cos = new Float64Array(n / 2); this.sin = new Float64Array(n / 2);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos(2 * Math.PI * i / n); this.sin[i] = Math.sin(2 * Math.PI * i / n); }
  }
  run(re, im, inv) {
    const n = this.n, rev = this.rev;
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = this.cos[k], wi = inv ? this.sin[k] : -this.sin[k];
          const a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

/* v42 (13 novembre 2026, "voce un po' metallica"): riduzione più dolce e guadagni lisciati nel tempo e in frequenza,
   meno acuti. Prima: vento floor -12, over 1,3, shelf +7, peak +3; forte -20, 1,8, +9, +4. */
const WIND_PRESETS = {
  // vento: taglio a 200 Hz, rumore abbassato al massimo di 9 dB, +5 dB di chiarezza
  vento: { hp: 200, floor: -9, over: 1.1, shelf: 5, peak: 2, makeup: 9 },
  // forte: taglio a 320 Hz, rumore giù fino a 15 dB, più chiarezza (la voce resta un po' più "sottile")
  forte: { hp: 320, floor: -15, over: 1.4, shelf: 7, peak: 3, makeup: 12 }
};

class WindClean {
  constructor(fs, preset = 'vento') {
    const p = WIND_PRESETS[preset] || WIND_PRESETS.vento;
    this.fs = fs; this.p = p;
    this.pre = [new Biquad('hp', fs, p.hp), new Biquad('hp', fs, p.hp), new Biquad('lshelf', fs, 600, Math.SQRT1_2, -4)];
    this.post = [new Biquad('hshelf', fs, 2000, 0.6, p.shelf), new Biquad('peak', fs, 3000, 0.8, p.peak), new Biquad('lp', fs, 7500), new Biquad('lp', fs, 7500)];
    // STFT: 1024 punti (21 ms a 48 kHz), passo 256
    const N = this.N = fs > 60000 ? 2048 : 1024, H = this.H = N / 4, K = N / 2 + 1;
    this.fft = new FFT(N);
    this.win = new Float64Array(N);
    for (let i = 0; i < N; i++) this.win[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); // radice di Hann (analisi e sintesi)
    this.inBuf = new Float64Array(N); this.outBuf = new Float64Array(N); this.fill = 0;
    this.outQ = new Float64Array(N); this.outRead = 0; this.outAvail = 0;
    this.re = new Float64Array(N); this.im = new Float64Array(N);
    this.Ps = new Float64Array(K); this.noise = new Float64Array(K).fill(1e-9); this.prevS = new Float64Array(K);
    this.G = new Float64Array(K).fill(1); this.Gs = new Float64Array(K); this.Gt = new Float64Array(K).fill(1);
    // minimo su ~1,5 s in 8 pezzi
    this.V = Math.max(4, Math.round(1.5 * fs / H / 8)); this.U = 8; this.vi = 0;
    this.subMin = []; for (let u = 0; u < this.U; u++) this.subMin.push(new Float64Array(K).fill(Infinity));
    this.curMin = new Float64Array(K).fill(Infinity); this.frames = 0;
    this.floor = Math.pow(10, p.floor / 20);
    // compressore: soglia -28 dBFS, rapporto 3:1
    this.env = 0; this.atk = Math.exp(-1 / (0.01 * fs)); this.rel = Math.exp(-1 / (0.3 * fs));
    this.makeup = Math.pow(10, p.makeup / 20); this.thr = Math.pow(10, -28 / 20); this.ratio = 3;
    this.lim = 1; this.limRel = Math.exp(-1 / (0.1 * fs));
  }
  frame() {
    const N = this.N, K = N / 2 + 1, re = this.re, im = this.im, win = this.win;
    for (let i = 0; i < N; i++) { re[i] = this.inBuf[i] * win[i]; im[i] = 0; }
    this.fft.run(re, im, false);
    const Ps = this.Ps, noise = this.noise, G = this.G, over = this.p.over, floor = this.floor;
    this.frames++;
    for (let k = 0; k < K; k++) {
      const P = re[k] * re[k] + im[k] * im[k];
      Ps[k] = this.frames === 1 ? P : 0.85 * Ps[k] + 0.15 * P;
      if (Ps[k] < this.curMin[k]) this.curMin[k] = Ps[k];
    }
    // fine di un pezzo: aggiorno il minimo degli ultimi 8 pezzi (~1,5 s) = stima del rumore
    if (++this.vi >= this.V) {
      this.vi = 0;
      this.subMin.shift(); this.subMin.push(this.curMin); this.curMin = new Float64Array(K).fill(Infinity);
      for (let k = 0; k < K; k++) {
        let m = Infinity; for (let u = 0; u < this.U; u++) if (this.subMin[u][k] < m) m = this.subMin[u][k];
        if (isFinite(m)) noise[k] = m * 1.8; // il minimo sottostima la media del rumore
      }
    } else if (this.frames < this.V) {
      for (let k = 0; k < K; k++) noise[k] = Math.max(noise[k], Ps[k] * 0.5); // primi istanti: stima grezza
    }
    // guadagno di Wiener con SNR "a priori" (decision directed): niente rumore musicale
    for (let k = 0; k < K; k++) {
      const P = re[k] * re[k] + im[k] * im[k], n = noise[k] * over + 1e-12;
      const post = P / n, prio = 0.98 * (this.prevS[k] / n) + 0.02 * Math.max(post - 1, 0);
      let g = prio / (1 + prio);
      if (g < floor) g = floor;
      G[k] = g;
      this.prevS[k] = g * g * P;
    }
    // lisciatura tra frequenze vicine (5 bin, ~190 Hz) e nel tempo: il guadagno sale subito ma scende piano (~40 ms),
    // così niente "gorgoglii" tra un istante e l'altro: è quello che fa sembrare metallica la voce
    const Gt = this.Gt;
    for (let k = 0; k < K; k++) {
      const a = G[Math.max(0, k - 2)], b = G[Math.max(0, k - 1)], c = G[Math.min(K - 1, k + 1)], d = G[Math.min(K - 1, k + 2)];
      const g = (a + 2 * b + 3 * G[k] + 2 * c + d) / 9;
      Gt[k] = g >= Gt[k] ? g : 0.88 * Gt[k] + 0.12 * g;
      this.Gs[k] = Gt[k];
    }
    for (let k = 0; k < K; k++) {
      const g = this.Gs[k]; re[k] *= g; im[k] *= g;
      if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    }
    this.fft.run(re, im, true);
    // sovrapposizione e somma (radice di Hann x2 al 75% di sovrapposizione: somma = 2)
    for (let i = 0; i < N; i++) this.outBuf[i] += re[i] * win[i] * 0.5;
  }
  process(x, y) {
    const H = this.H, N = this.N;
    for (let i = 0; i < x.length; i++) {
      let s = x[i];
      for (const f of this.pre) s = f.run(s);
      this.inBuf[N - H + this.fill] = s;
      if (++this.fill === H) {
        this.fill = 0;
        this.frame();
        // escono i primi H campioni completi
        for (let j = 0; j < H; j++) this.outQ[(this.outRead + this.outAvail + j) % N] = this.outBuf[j];
        this.outAvail += H;
        this.outBuf.copyWithin(0, H); this.outBuf.fill(0, N - H);
        this.inBuf.copyWithin(0, H);
      }
      let o = 0;
      if (this.outAvail > 0) { o = this.outQ[this.outRead]; this.outRead = (this.outRead + 1) % N; this.outAvail--; }
      for (const f of this.post) o = f.run(o);
      // compressore
      const a = Math.abs(o);
      this.env = a > this.env ? this.atk * this.env + (1 - this.atk) * a : this.rel * this.env + (1 - this.rel) * a;
      let g = 1;
      if (this.env > this.thr) g = Math.pow(this.env / this.thr, 1 / this.ratio - 1);
      o *= g * this.makeup;
      // limitatore a -1 dBFS
      const pk = Math.abs(o) * this.lim;
      if (pk > 0.89) this.lim = 0.89 / Math.abs(o); else this.lim = 1 - (1 - this.lim) * this.limRel;
      y[i] = o * this.lim;
    }
  }
}

if (typeof registerProcessor === 'function') {
  registerProcessor('filtro-vento', class extends AudioWorkletProcessor {
    constructor(opt) {
      super();
      this.mode = (opt.processorOptions && opt.processorOptions.mode) || 'vento';
      this.dsp = new WindClean(sampleRate, this.mode);
      this.mono = new Float32Array(128);
      this.port.onmessage = e => { if (e.data && e.data.mode && e.data.mode !== this.mode) { this.mode = e.data.mode; this.dsp = new WindClean(sampleRate, this.mode); } };
    }
    process(inputs, outputs) {
      const inp = inputs[0], out = outputs[0];
      if (!out || !out.length) return true;
      const n = out[0].length;
      if (this.mono.length !== n) this.mono = new Float32Array(n);
      const m = this.mono; m.fill(0);
      if (inp && inp.length) { for (const ch of inp) for (let i = 0; i < n; i++) m[i] += ch[i] / inp.length; }
      this.dsp.process(m, out[0]);
      for (let c = 1; c < out.length; c++) out[c].set(out[0]);
      return true;
    }
  });
}
if (typeof globalThis !== 'undefined') globalThis.WindClean = WindClean;
