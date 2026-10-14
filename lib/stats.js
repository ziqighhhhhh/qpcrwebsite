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
  const num = Math.pow(Math.max(0, Math.abs(a * d - b * c) - n / 2), 2);
  const den = (a + b) * (c + d) * (a + c) * (b + d);
  if (!den) return { chi2: NaN, p: NaN };
  const chi2 = n * num / den;
  return { chi2, p: chiSquareP(chi2, 1) };
}

// two-tailed p from |t| and df via regularized incomplete beta (Student t CDF)
function twoTailedP(t, df) {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return NaN;
  if (t === 0) return 1;
  const x = df / (df + t * t);
  if (x === 0) return 0;
  if (x === 1) return 1;
  const a = df / 2, b = 0.5;
  const front = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) +
    a * Math.log(x) + b * Math.log1p(-x));
  const p = x < (a + 1) / (a + b + 2)
    ? front * betacf(x, a, b) / a
    : 1 - front * betacf(1 - x, b, a) / b;
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
  return h;
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
  if (x === 0) return 1;
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

// Exact conditional permutation test for <= 20 observations (ties included).
// Larger samples use average ranks, tie variance and continuity correction.
function mannWhitneyU(x, y) {
  if (![x, y].every(a => Array.isArray(a) && a.length && a.every(Number.isFinite))) {
    throw new TypeError('Mann Whitney requires nonempty finite numeric samples');
  }
  const n1 = x.length, n2 = y.length, n = n1 + n2;
  const sorted = [...x.map(v => ({v, group: 0})), ...y.map(v => ({v, group: 1}))]
    .sort((a, b) => a.v - b.v);
  const ranks = [];
  let rankSum = 0, tieSum = 0;
  for (let i = 0; i < n;) {
    let j = i + 1;
    while (j < n && sorted[j].v === sorted[i].v) j++;
    const rank = (i + 1 + j) / 2, count = j - i;
    tieSum += count ** 3 - count;
    for (let k = i; k < j; k++) {
      ranks.push(rank * 2);
      if (sorted[k].group === 0) rankSum += rank;
    }
    i = j;
  }
  const u1 = rankSum - n1 * (n1 + 1) / 2, u2 = n1 * n2 - u1;
  const u = Math.min(u1, u2);
  if (n <= 20) {
    const p = exactRankP(ranks, n1, rankSum * 2);
    return {u, u1, u2, n1, n2, p, method: 'exact', alternative: 'two-sided'};
  }
  const variance = n1 * n2 / 12 * (n + 1 - tieSum / (n * (n - 1)));
  const z = variance > 0 ? Math.max(0, Math.abs(u1 - n1 * n2 / 2) - 0.5) / Math.sqrt(variance) : 0;
  return {u, u1, u2, n1, n2, p: chiSquareP(z * z, 1), method: 'asymptotic', alternative: 'two-sided'};
}

function exactRankP(ranks, sampleSize, observed) {
  // Doubled ranks keep average ranks integral; counts preserve tied permutations.
  let distributions = Array.from({length: sampleSize + 1}, () => new Map());
  distributions[0].set(0, 1);
  for (const rank of ranks) {
    distributions = distributions.map((previous, k) => {
      const next = new Map(previous);
      if (k > 0) for (const [sum, count] of distributions[k - 1]) {
        next.set(sum + rank, (next.get(sum + rank) || 0) + count);
      }
      return next;
    });
  }
  let total = 0, lower = 0, upper = 0;
  for (const [sum, count] of distributions[sampleSize]) {
    total += count;
    if (sum <= observed) lower += count;
    if (sum >= observed) upper += count;
  }
  return Math.min(1, 2 * Math.min(lower, upper) / total);
}

function stars(p) {
  if (p === null || p === undefined || isNaN(p)) return 'n.s.';
  if (p < 0.001) return '***';
  if (p < 0.01) return '**';
  if (p < 0.05) return '*';
  return 'n.s.';
}

// Two-sided critical value: returns t > 0 with twoTailedP(t, df) = alpha.
// Bisection on the (monotone decreasing) tail probability — no inverse-beta needed.
function tQuantile(alpha, df) {
  if (!(alpha > 0 && alpha < 1) || !(df > 0)) return NaN;
  let lo = 0, hi = 1e6;
  for (let i = 0; i < 200 && hi - lo > 1e-10; i++) {
    const mid = (lo + hi) / 2;
    if (twoTailedP(mid, df) > alpha) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
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

const statistics = {
  mean, sd, summary,
  ttestIndependent, ttestPaired, twoTailedP, tQuantile, cohensD, chiSquare2x2, mannWhitneyU, stars,
  foldChange: (ctCtrl, ctTreat) => Math.pow(2, ctCtrl - ctTreat),
};
if (typeof module !== 'undefined' && module.exports) module.exports = statistics;
if (typeof window !== 'undefined') window.QpcrStats = statistics;
