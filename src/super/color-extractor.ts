import sharp from 'sharp';

/**
 * Port of App\Services\ColorExtractor: dominant colours of a logo, then a
 * theme (primary / brand / accent with light and dark shades) derived from
 * them. sharp only decodes the image; the 80×80 downscale reproduces GD's
 * imagescale() default (IMG_BILINEAR_FIXED, 24.8 fixed point) so the sampled
 * pixels, and therefore the theme, match legacy.
 */

const SAMPLE = 80;
const BITS = 5;

export type Theme = Record<
  | 'primary'
  | 'primary_dark'
  | 'primary_light'
  | 'brand'
  | 'brand_mid'
  | 'brand_lift'
  | 'accent',
  string
>;

const DEFAULTS: Theme = {
  primary: '#C49560',
  primary_dark: '#A87840',
  primary_light: '#FDF4E8',
  brand: '#2A0E13',
  brand_mid: '#3D1520',
  brand_lift: '#52202E',
  accent: '#06B6D4',
};

/** PHP round(): half away from zero. */
const round = (n: number) => Math.sign(n) * Math.round(Math.abs(n));
const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((c) => c.toString(16).toUpperCase().padStart(2, '0')).join('')}`;
const rgb = (h: string) =>
  [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];

const luma = (h: string) => {
  const [r, g, b] = rgb(h);
  return 0.299 * r + 0.587 * g + 0.114 * b;
};
const saturation = (h: string) => {
  const [r, g, b] = rgb(h);
  const max = Math.max(r, g, b);
  return max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
};
const distance = (a: string, b: string) => {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
};

/** Mix with white (+) or black (−); pct is −100..+100. */
export function shade(h: string, pct: number): string {
  let [r, g, b] = rgb(h);
  pct = Math.max(-100, Math.min(100, pct));
  if (pct >= 0) {
    const f = pct / 100;
    [r, g, b] = [r, g, b].map((c) => Math.trunc(round(c + (255 - c) * f)));
  } else {
    const f = 1 + pct / 100;
    [r, g, b] = [r, g, b].map((c) => Math.trunc(round(c * f)));
  }
  return hex(r, g, b);
}

function liftBrightness(h: string, target: number) {
  const current = luma(h);
  if (current >= target) return h;
  if (current < 5) return shade(h, +60);
  const f = target / Math.max(current, 1);
  const [r, g, b] = rgb(h).map((c) => Math.min(255, Math.trunc(round(c * f))));
  return hex(r, g, b);
}

function nearGreyscale(r: number, g: number, b: number) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max < 30 || min > 235) return true;
  return max - min < 18;
}

/** GD truecolour pixels (alpha 0 = opaque … 127 = transparent), row-major. */
type GdImage = {
  w: number;
  h: number;
  r: Uint8Array;
  g: Uint8Array;
  b: Uint8Array;
  a: Uint8Array;
};

async function decode(image: Buffer): Promise<GdImage | null> {
  try {
    const { data, info } = await sharp(image, { animated: false })
      .ensureAlpha()
      .raw({ depth: 'uchar' })
      .toBuffer({ resolveWithObject: true });
    const n = info.width * info.height;
    const img: GdImage = {
      w: info.width,
      h: info.height,
      r: new Uint8Array(n),
      g: new Uint8Array(n),
      b: new Uint8Array(n),
      a: new Uint8Array(n),
    };
    for (let i = 0; i < n; i++) {
      img.r[i] = data[i * 4];
      img.g[i] = data[i * 4 + 1];
      img.b[i] = data[i * 4 + 2];
      img.a[i] = 127 - (data[i * 4 + 3] >> 1); // how GD stores PNG alpha
    }
    return img;
  } catch {
    return null;
  }
}

/**
 * gdImageScaleBilinear (truecolour), as imagescale($img, w, h) runs it:
 * 24.8 fixed-point weights, neighbours past the edge repeat the top-left one.
 */
function gdScaleBilinear(im: GdImage, dw: number, dh: number): GdImage {
  const itofx = (x: number) => x * 256;
  const ftofx = (x: number) => Math.trunc(x * 256);
  const mulfx = (x: number, y: number) => Math.floor((x * y) / 256);
  const fxtoi = (x: number) => Math.floor(x / 256);
  const fdx = ftofx(Math.fround(Math.fround(im.w) / Math.fround(dw)));
  const fdy = ftofx(Math.fround(Math.fround(im.h) / Math.fround(dh)));
  const f1 = itofx(1);
  const n = dw * dh;
  const out: GdImage = {
    w: dw,
    h: dh,
    r: new Uint8Array(n),
    g: new Uint8Array(n),
    b: new Uint8Array(n),
    a: new Uint8Array(n),
  };
  const at = (x: number, y: number, fallback: number) =>
    x >= 0 && y >= 0 && x < im.w && y < im.h ? y * im.w + x : fallback;
  for (let i = 0; i < dh; i++) {
    for (let j = 0; j < dw; j++) {
      const fa = mulfx(itofx(i), fdy);
      const fb = mulfx(itofx(j), fdx);
      const m = fxtoi(fa);
      const nn = fxtoi(fb);
      const ff = fa - itofx(m);
      const fg = fb - itofx(nn);
      const w1 = mulfx(f1 - ff, f1 - fg);
      const w2 = mulfx(f1 - ff, fg);
      const w3 = mulfx(ff, f1 - fg);
      const w4 = mulfx(ff, fg);
      const p1 = at(nn, m, -1);
      const p2 = at(nn + 1, m, p1);
      const p3 = at(nn, m + 1, p1);
      const p4 = at(nn + 1, m + 1, p1);
      const mix = (ch: Uint8Array) => {
        const v = (p: number) => (p < 0 ? 0 : itofx(ch[p]));
        return (
          fxtoi(
            mulfx(w1, v(p1)) +
              mulfx(w2, v(p2)) +
              mulfx(w3, v(p3)) +
              mulfx(w4, v(p4)),
          ) & 0xff
        );
      };
      const o = i * dw + j;
      out.r[o] = mix(im.r);
      out.g[o] = mix(im.g);
      out.b[o] = mix(im.b);
      out.a[o] = mix(im.a) & 0x7f;
    }
  }
  return out;
}

/** Top-N dominant colours, most frequent first, skipping greys and transparent pixels. */
export async function dominantColours(
  image: Buffer,
  top = 5,
): Promise<string[]> {
  const img = await decode(image);
  if (!img) return [];
  const px = gdScaleBilinear(img, SAMPLE, SAMPLE);
  const shift = 8 - BITS;
  // Insertion order matters: PHP's uasort is stable, so ties keep scan order.
  const counts = new Map<string, [number, number, number, number]>();
  for (let i = 0; i < SAMPLE * SAMPLE; i++) {
    const [r, g, b] = [px.r[i], px.g[i], px.b[i]];
    if (px.a[i] > 80 || nearGreyscale(r, g, b)) continue;
    const key = `${r >> shift}-${g >> shift}-${b >> shift}`;
    const c = counts.get(key) ?? [0, 0, 0, 0];
    c[0] += r;
    c[1] += g;
    c[2] += b;
    c[3]++;
    counts.set(key, c);
  }
  const buckets = [...counts.values()].sort((x, y) => y[3] - x[3]);
  const out: string[] = [];
  for (const [r, g, b, n] of buckets.slice(0, top * 3)) {
    const h = hex(
      Math.trunc(round(r / n)),
      Math.trunc(round(g / n)),
      Math.trunc(round(b / n)),
    );
    if (!out.some((o) => distance(h, o) < 36)) {
      out.push(h);
      if (out.length >= top) break;
    }
  }
  return out;
}

/** ColorExtractor::deriveTheme. */
export function deriveTheme(dominant: string[]): Theme {
  if (!dominant.length) return { ...DEFAULTS };
  const score = (h: string) => {
    const fit = 1 - Math.min(1, Math.abs(luma(h) - 115) / 115);
    return saturation(h) * (0.4 + 0.6 * fit);
  };
  const sorted = [...dominant].sort((a, b) => score(b) - score(a));
  let primary = sorted[0];
  if (luma(primary) < 80) primary = liftBrightness(primary, 110);
  if (luma(primary) > 200) primary = shade(primary, -25);

  const darkest = [...dominant].sort((a, b) => luma(a) - luma(b))[0];
  const brand =
    darkest && distance(darkest, primary) > 50 ? darkest : shade(primary, -70);
  const accent =
    sorted.slice(1).find((c) => distance(c, primary) > 60) ??
    shade(primary, +40);

  return {
    primary,
    primary_dark: shade(primary, -25),
    primary_light: shade(primary, +75),
    brand,
    brand_mid: shade(brand, +15),
    brand_lift: shade(brand, +30),
    accent,
  };
}

export async function themeFromImage(image: Buffer): Promise<Theme> {
  return deriveTheme(await dominantColours(image, 5));
}
