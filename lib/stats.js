'use strict';
// ---------------------------------------------------------------------------
// Small statistics helpers for group comparison (no deps).
// Student's t (paired / unpaired Welch), Cohen's d, chi-square 2x2.
// ---------------------------------------------------------------------------

function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN; }
function variance(a, sample) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - (sample ? 1 : 0));
}
function sd(a) { return Math.sqrt(variance(a, true)); }

// Welch's t-test for independent samples (two-tailed)
function ttestIndependent(x, y) {
  const n1 = x.length, n2 = y.length;
  if (n1 < 2 || n2 < 2) return { t: NaN, df: 0, p: NaN };
  const m1 = mean(x), m2 = mean(y);
  const v1 = variance(x, true), v2 = variance(y, true);
  const se = Math.sqrt(v1 / n1 + v2 / n2);
  if (!se || se === 0) return { t: NaN, df: 0, p: NaN };
  const t = (m1 - m2) / se;
  const df = Math.pow(v1 / n1 + v2 / n2, 2) /
    (Math.pow(v1 / n1, 2) / (n1 - 1) + Math.pow(v2 / n2, 2) / (n2 - 1));
  return { t, df, p: twoTailedP(Math.abs(t), df) };
}

// Paired t-test (two-tailed). x,y aligned pairwise.
function ttestPaired(x, y) {
  const n = Math.min(x.length, y.length);
  const d = [];
  for (let i = 0; i < n; i++) d.push(x[i] - y[i]);
  if (n < 2) return { t: NaN, df: 0, p: NaN };
  const md = mean(d);
  const s = sd(d);
  if (!s || s === 0) return { t: NaN, df: n - 1, p: NaN };
  const t = md / (s / Math.sqrt(n));
  return { t, df: n - 1, p: twoTailedP(Math.abs(t), n - 1) };
}

// Cohen's d (pooled SD) for independent samples
function cohensD(x, y) {
  const n1 = x.length, n2 = y.length;
  if (n1 < 2 || n2 < 2) return NaN;
  const sp = Math.sqrt(((n1 - 1) * variance(x, true) + (n2 - 1) * variance(y, true)) / (n1 + n2 - 2));
  if (!sp) return NaN;
  return (mean(x) - mean(y)) / sp;
}

// Chi-square 2x2 (Yates) for e.g. positive-rate comparison
function chiSquare2x2(a, b, c, d) {
  const n = a + b + c + d;
  if (!n) return { chi2: NaN, p: NaN };
  const num = Math.pow(Math.abs(a * d - b * c) - n / 2, 2);
  const den = (a + b) * (c + d) * (a + c) * (b + d);
  if (!den) return { chi2: NaN, p: NaN };
  const chi2 = n * num / den;
  return { chi2, p: chiSquareP(chi2, 1) };
}

// two-tailed p from |t| and df via regularized incomplete beta (Student t CDF)
function twoTailedP(t, df) {
  if (!isFinite(t) || df <= 0) return NaN;
  const x = df / (df + t * t);
  // P(T > t) = 0.5 * I_x(df/2, 1/2)
  const p = 0.5 * betacf(x, df / 2, 0.5);
  return Math.min(1, Math.max(0, p));
}
function chiSquareP(chi2, df) {
  // upper tail: Q(chi2/2, df/2) via regularized gamma
  return Math.min(1, Math.max(0, gammq(df / 2, chi2 / 2)));
}

// continued fraction for incomplete beta (Numerical Recipes betacf)
function betacf(x, a, b) {
  const MAXIT = 200, EPS = 3e-12, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h * Math.exp(a * Math.log(x) + (b) * Math.log(1 - x) - lgamma(a) - lgamma(b) - lgamma(a + b));
}
function lgamma(x) {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += cof[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
// incomplete gamma Q (upper tail) via series + continued fraction
function gammq(a, x) {
  if (x < a + 1) {
    // series
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 1; n < 1000; n++) {
      ap += 1; del *= x / ap; sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-12) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }
  // continued fraction
  const FPMIN = 1e-300, EPS = 1e-12;
  let b = x + 1 - a, c = 1 / FPMIN, d = 1 / b, h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h * Math.exp(-x + a * Math.log(x) - lgamma(a));
}

function stars(p) {
  if (p === null || p === undefined || isNaN(p)) return 'n.s.';
  if (p < 0.001) return '***';
  if (p < 0.01) return '**';
  if (p < 0.05) return '*';
  return 'n.s.';
}

function summary(arr) {
  const n = arr.length;
  const m = mean(arr);
  const s = sd(arr);
  const sorted = arr.slice().sort((a, b) => a - b);
  const q = (k) => sorted[Math.min(n - 1, Math.max(0, Math.floor(k)))];
  return {
    n, mean: m, sd: s, min: n ? sorted[0] : NaN, max: n ? sorted[n - 1] : NaN,
    q1: q(n * 0.25), median: q(n * 0.5), q3: q(n * 0.75),
    values: arr,
  };
}

module.exports = {
  mean, sd, summary,
  ttestIndependent, ttestPaired, cohensD, chiSquare2x2, stars,
  foldChange: (ctCtrl, ctTreat) => Math.pow(2, ctCtrl - ctTreat),
};