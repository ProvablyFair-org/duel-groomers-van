/**
 * Statistical helpers for the Monte Carlo simulator.
 *
 * Implements:
 *   - chiSquaredPValue (regularized incomplete gamma — exact, no Wilson-Hilferty)
 *   - lag1Autocorrelation (per-spin payout serial correlation)
 *   - waldWolfowitzRunsP (runs test for randomness)
 *   - bonferroniCriticalZ (FWER-corrected z threshold from per-test alpha)
 *   - inverseStandardNormalCDF (probit, for converting alpha → z-critical)
 *   - poolTailBins (chi-squared sub-5 binning)
 *   - meanStd (one-pass)
 */

// ── Regularised incomplete gamma → chi-squared p-value ──────────────────────

/**
 * Regularised lower incomplete gamma γ(s, x) / Γ(s) using a power-series
 * for x < s+1 and continued-fraction otherwise. Numerically stable for
 * the chi-squared survival function we use to convert (chi², df) →
 * p-value. NO Wilson-Hilferty approximation.
 */
function lowerIncompleteGammaRegularised(s: number, x: number): number {
  if (x < 0 || s <= 0) return Number.NaN;
  if (x === 0) return 0;
  if (x < s + 1) {
    // Power series
    let sum  = 1 / s;
    let term = sum;
    for (let n = 1; n < 1000; n++) {
      term *= x / (s + n);
      sum  += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
    }
    return sum * Math.exp(-x + s * Math.log(x) - logGamma(s));
  } else {
    return 1 - upperIncompleteGammaRegularised(s, x);
  }
}

function upperIncompleteGammaRegularised(s: number, x: number): number {
  // Lentz continued fraction for Γ(s,x) / Γ(s).
  const FPMIN = 1e-300;
  let b = x + 1 - s;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - s);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return h * Math.exp(-x + s * Math.log(x) - logGamma(s));
}

/** Lanczos log-gamma (g=7, n=9). */
export function logGamma(z: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** χ² survival function (p-value): P(X >= chi2 | df). */
export function chiSquaredPValue(chi2: number, df: number): number {
  if (chi2 <= 0) return 1;
  if (df <= 0)  return Number.NaN;
  return 1 - lowerIncompleteGammaRegularised(df / 2, chi2 / 2);
}

// ── Tail-bin pooling for chi-squared ───────────────────────────────────────

/**
 * Pool consecutive bins from the front and the back into adjacent bins
 * until every retained bin's expected count ≥ minExpected (default 5).
 * Returns the pooled (observed, expected) arrays.
 */
export function poolTailBins(
  observed: number[], expected: number[], minExpected = 5,
): { observed: number[]; expected: number[] } {
  let o = observed.slice(), e = expected.slice();
  // Front pass
  while (e.length > 1 && e[0] < minExpected) {
    e[1] += e[0]; o[1] += o[0];
    e = e.slice(1); o = o.slice(1);
  }
  // Back pass
  while (e.length > 1 && e[e.length - 1] < minExpected) {
    e[e.length - 2] += e[e.length - 1]; o[o.length - 2] += o[o.length - 1];
    e = e.slice(0, -1); o = o.slice(0, -1);
  }
  // Walk middle, merging any below-min into the next
  for (let i = 0; i < e.length - 1; i++) {
    if (e[i] < minExpected) {
      e[i + 1] += e[i]; o[i + 1] += o[i];
      e.splice(i, 1); o.splice(i, 1);
      i--;
    }
  }
  return { observed: o, expected: e };
}

// ── Lag-1 autocorrelation ──────────────────────────────────────────────────

export function lag1Autocorrelation(values: number[]): { rho: number; z: number } {
  const n = values.length;
  if (n < 3) return { rho: 0, z: 0 };
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;

  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] - mean;
    den += d * d;
    if (i + 1 < n) num += d * (values[i + 1] - mean);
  }
  const rho = den > 0 ? num / den : 0;
  // Standard error of rho under null: 1/sqrt(n)
  const z = rho * Math.sqrt(n);
  return { rho, z };
}

// ── Wald-Wolfowitz runs test ────────────────────────────────────────────────

/**
 * Test a binary sequence (e.g. above-median / below-median) for runs.
 * Returns the p-value under the null hypothesis of independence.
 */
export function waldWolfowitzRunsP(values: number[]): { runs: number; expected: number; z: number; p: number } {
  const median = (() => {
    const s = values.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  })();

  const above: boolean[] = values.map(v => v > median);
  let n1 = 0, n2 = 0;
  for (const v of above) if (v) n1++; else n2++;
  if (n1 === 0 || n2 === 0) return { runs: 1, expected: 1, z: 0, p: 1 };

  let runs = 1;
  for (let i = 1; i < above.length; i++) if (above[i] !== above[i - 1]) runs++;

  const expected = (2 * n1 * n2) / (n1 + n2) + 1;
  const variance = (2 * n1 * n2 * (2 * n1 * n2 - n1 - n2)) / ((n1 + n2) * (n1 + n2) * (n1 + n2 - 1));
  const z = (runs - expected) / Math.sqrt(variance);
  // Two-sided p
  const p = 2 * (1 - standardNormalCDF(Math.abs(z)));
  return { runs, expected, z, p };
}

// ── Standard normal CDF + inverse ──────────────────────────────────────────

/** Φ(z) using Abramowitz & Stegun 26.2.17 (max error ~7.5e-8). */
export function standardNormalCDF(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-(z * z) / 2);
  const cdf = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - cdf : cdf;
}

/** Beasley-Springer-Moro inverse normal CDF. Used for FWER z-thresholds. */
export function inverseStandardNormalCDF(p: number): number {
  if (p <= 0 || p >= 1) return Number.NaN;
  const a = [-3.969683028665376e+01,  2.209460984245205e+02,
             -2.759285104469687e+02,  1.383577518672690e+02,
             -3.066479806614716e+01,  2.506628277459239e+00];
  const b = [-5.447609879822406e+01,  1.615858368580409e+02,
             -1.556989798598866e+02,  6.680131188771972e+01,
             -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01,
             -2.400758277161838e+00, -2.549732539343734e+00,
              4.374664141464968e+00,  2.938163982698783e+00];
  const d = [ 7.784695709041462e-03,  3.224671290700398e-01,
              2.445134137142996e+00,  3.754408661907416e+00];
  const plow = 0.02425, phigh = 1 - plow;
  let q: number, r: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= phigh) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
}

/**
 * Bonferroni-corrected critical |z| for a two-sided test family of N
 * with family-wise error rate α. (Per-test α' = α / N.)
 */
export function bonferroniCriticalZ(alpha: number, N: number): number {
  return Math.abs(inverseStandardNormalCDF(alpha / (2 * N)));
}

// ── Mean / sample standard deviation ────────────────────────────────────────

export function meanStd(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 0 };
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  let sq = 0;
  for (const v of values) { const d = v - mean; sq += d * d; }
  const std = values.length > 1 ? Math.sqrt(sq / (values.length - 1)) : 0;
  return { mean, std };
}

// ── Fisher's combined p-value ──────────────────────────────────────────────

/**
 * Combine K independent p-values into a single test. T = -2 Σ ln(p_i) ~
 * χ²(2K) under the null. Used for multi-stream chi-squared aggregation.
 */
export function fishersCombinedPValue(pvalues: number[]): { T: number; df: number; p: number } {
  let T = 0;
  for (const p of pvalues) T += -2 * Math.log(Math.max(p, 1e-300));
  const df = 2 * pvalues.length;
  return { T, df, p: chiSquaredPValue(T, df) };
}
