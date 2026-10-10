// WGSL shaders for the upscaling pipeline.
//
// Pipeline (all passes are full-screen triangles rendered on the GPU):
//   1. prep     (source res)  video frame -> denoised RGB + luma          [bilateral filter]
//   2. upscale  (output res)  anti-ringing Catmull-Rom + edge-directed smoothing along line tangents
//   3. edges    (output res)  edge-strength map (Sobel on luma)
//   4. warp     (output res)  warp-sharpen (tightens line transitions) + optional line darkening
//   5. present  (output res)  halo-free adaptive sharpen -> canvas  (+ split-screen compare)
// Passes 3-4 are skipped when both warp and lineDarken are 0.
(() => {
  const NS = (globalThis.AnimeUpscaler ||= {});
  if (NS.SHADERS) return;

  const common = /* wgsl */ `
struct Params {
  srcSize: vec2f,
  dstSize: vec2f,
  denoise: f32,
  edgeAA: f32,
  warp: f32,
  lineDarken: f32,
  sharpen: f32,
  compare: f32,
  pad0: f32,
  pad1: f32,
};

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VSOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  o.uv = vec2f(p[vi].x * 0.5 + 0.5, 0.5 - p[vi].y * 0.5);
  return o;
}

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.299, 0.587, 0.114));
}
`;

  // The video frame is normally bound as a zero-copy `texture_external`. Some GPU/driver
  // combinations can't import video that way, so a fallback copies the frame into a
  // regular texture_2d. These snippets declare `vid` + `fetchV()` for each mode.
  const videoSource = {
    external: (binding) => `
@group(0) @binding(${binding}) var vid: texture_external;
fn fetchV(p: vec2i) -> vec4f { return textureLoad(vid, p); }
`,
    copy: (binding) => `
@group(0) @binding(${binding}) var vid: texture_2d<f32>;
fn fetchV(p: vec2i) -> vec4f { return textureLoad(vid, p, 0); }
`,
  };

  // ---------------------------------------------------------------- 1. prep
  const prep = (mode) => /* wgsl */ `
@group(0) @binding(0) var<uniform> P: Params;
${videoSource[mode](1)}

fn loadV(p: vec2i, maxp: vec2i) -> vec3f {
  return fetchV(clamp(p, vec2i(0), maxp)).rgb;
}

@fragment
fn fs(fi: VSOut) -> @location(0) vec4f {
  let dims = vec2i(textureDimensions(vid));
  let maxp = dims - vec2i(1);
  let ip = clamp(vec2i(fi.uv * vec2f(dims)), vec2i(0), maxp);
  let c = loadV(ip, maxp);
  if (P.denoise <= 0.001) {
    return vec4f(c, luma(c));
  }
  // 5x5 bilateral: spatial sigma 1.5px, range sigma scales with strength.
  let sigmaR = mix(0.015, 0.10, P.denoise);
  let invR = 1.0 / (2.0 * sigmaR * sigmaR);
  var acc = vec3f(0.0);
  var wsum = 0.0;
  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      let sc = loadV(ip + vec2i(x, y), maxp);
      let d2 = f32(x * x + y * y);
      let dc = sc - c;
      let wt = exp(-d2 * 0.2222 - dot(dc, dc) * invR);
      acc += sc * wt;
      wsum += wt;
    }
  }
  let r = acc / wsum;
  return vec4f(r, luma(r));
}
`;

  // ------------------------------------------------------------- 2. upscale
  const upscale = /* wgsl */ `
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

fn S(uv: vec2f) -> vec4f {
  return textureSampleLevel(src, samp, uv, 0.0);
}

// Catmull-Rom bicubic using 9 bilinear taps.
fn catmullRom(uv: vec2f, ts: vec2f) -> vec4f {
  let sp = uv * ts;
  let tp1 = floor(sp - 0.5) + 0.5;
  let f = sp - tp1;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let o12 = w2 / w12;
  let inv = 1.0 / ts;
  let t0 = (tp1 - 1.0) * inv;
  let t3 = (tp1 + 2.0) * inv;
  let t12 = (tp1 + o12) * inv;
  var r = S(vec2f(t0.x, t0.y)) * (w0.x * w0.y);
  r += S(vec2f(t12.x, t0.y)) * (w12.x * w0.y);
  r += S(vec2f(t3.x, t0.y)) * (w3.x * w0.y);
  r += S(vec2f(t0.x, t12.y)) * (w0.x * w12.y);
  r += S(vec2f(t12.x, t12.y)) * (w12.x * w12.y);
  r += S(vec2f(t3.x, t12.y)) * (w3.x * w12.y);
  r += S(vec2f(t0.x, t3.y)) * (w0.x * w3.y);
  r += S(vec2f(t12.x, t3.y)) * (w12.x * w3.y);
  r += S(vec2f(t3.x, t3.y)) * (w3.x * w3.y);
  return r;
}

@fragment
fn fs(fi: VSOut) -> @location(0) vec4f {
  let ts = vec2f(textureDimensions(src));
  let uv = fi.uv;

  // Anti-ringing: clamp bicubic result to the 2x2 source neighbourhood.
  let maxp = vec2i(ts) - vec2i(1);
  let base = vec2i(floor(uv * ts - 0.5));
  let q0 = textureLoad(src, clamp(base, vec2i(0), maxp), 0);
  let q1 = textureLoad(src, clamp(base + vec2i(1, 0), vec2i(0), maxp), 0);
  let q2 = textureLoad(src, clamp(base + vec2i(0, 1), vec2i(0), maxp), 0);
  let q3 = textureLoad(src, clamp(base + vec2i(1, 1), vec2i(0), maxp), 0);
  let mn = min(min(q0, q1), min(q2, q3));
  let mx = max(max(q0, q1), max(q2, q3));
  var col = clamp(catmullRom(uv, ts), mn, mx);

  // Edge-directed smoothing: average along the edge tangent (never across it).
  if (P.edgeAA > 0.001) {
    let t = 1.0 / ts;
    let tl = S(uv + vec2f(-t.x, -t.y)).a;
    let tc = S(uv + vec2f(0.0, -t.y)).a;
    let tr = S(uv + vec2f(t.x, -t.y)).a;
    let ml = S(uv + vec2f(-t.x, 0.0)).a;
    let mr = S(uv + vec2f(t.x, 0.0)).a;
    let bl = S(uv + vec2f(-t.x, t.y)).a;
    let bc = S(uv + vec2f(0.0, t.y)).a;
    let br = S(uv + vec2f(t.x, t.y)).a;
    let gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
    let gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
    let mag = length(vec2f(gx, gy));
    if (mag > 0.02) {
      let nrm = vec2f(gx, gy) / mag;
      let tg = vec2f(-nrm.y, nrm.x) * t;
      let s1 = S(uv + tg * 0.6);
      let s2 = S(uv - tg * 0.6);
      let s3 = S(uv + tg * 1.3);
      let s4 = S(uv - tg * 1.3);
      let along = (col * 2.0 + s1 + s2 + (s3 + s4) * 0.5) / 5.0;
      let wgt = smoothstep(0.04, 0.25, mag) * P.edgeAA;
      col = mix(col, along, wgt);
    }
  }
  return vec4f(col.rgb, luma(col.rgb));
}
`;

  // --------------------------------------------------------------- 3. edges
  const edges = /* wgsl */ `
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var img: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

fn A(uv: vec2f) -> f32 {
  return textureSampleLevel(img, samp, uv, 0.0).a;
}

@fragment
fn fs(fi: VSOut) -> @location(0) vec4f {
  let scale = max(P.dstSize.x / P.srcSize.x, 1.0);
  let px = clamp(scale * 0.5, 1.0, 3.0) / P.dstSize;
  let uv = fi.uv;
  let tl = A(uv + vec2f(-px.x, -px.y));
  let tc = A(uv + vec2f(0.0, -px.y));
  let tr = A(uv + vec2f(px.x, -px.y));
  let ml = A(uv + vec2f(-px.x, 0.0));
  let mr = A(uv + vec2f(px.x, 0.0));
  let bl = A(uv + vec2f(-px.x, px.y));
  let bc = A(uv + vec2f(0.0, px.y));
  let br = A(uv + vec2f(px.x, px.y));
  let gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  let gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
  let e = length(vec2f(gx, gy)) * 0.25;
  return vec4f(e, 0.0, 0.0, 1.0);
}
`;

  // ---------------------------------------------------------------- 4. warp
  const warp = /* wgsl */ `
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var img: texture_2d<f32>;
@group(0) @binding(2) var edgeTex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

fn E(uv: vec2f) -> f32 {
  return textureSampleLevel(edgeTex, samp, uv, 0.0).r;
}

fn I(uv: vec2f) -> vec4f {
  return textureSampleLevel(img, samp, uv, 0.0);
}

@fragment
fn fs(fi: VSOut) -> @location(0) vec4f {
  let scale = max(P.dstSize.x / P.srcSize.x, 1.0);
  let inv = 1.0 / P.dstSize;
  let uv = fi.uv;
  var c = I(uv).rgb;

  // Warp sharpening: the edge map peaks at the centre of each transition. Sampling
  // *against* its gradient pulls colour from the flat sides, so transitions get narrower.
  if (P.warp > 0.001) {
    let g = vec2f(E(uv + vec2f(inv.x, 0.0)) - E(uv - vec2f(inv.x, 0.0)),
                  E(uv + vec2f(0.0, inv.y)) - E(uv - vec2f(0.0, inv.y))) * 0.5;
    let gl = length(g);
    if (gl > 1e-5) {
      let maxDisp = clamp(scale * 0.45, 0.35, 2.0);
      let amt = P.warp * maxDisp * smoothstep(0.0, 1.0, gl * scale * 3.0);
      let d = -(g / gl) * amt * inv;
      c = I(uv + d).rgb;
    }
  }

  // Line darkening: pixels darker than their surroundings on an edge (= outlines).
  if (P.lineDarken > 0.001) {
    let r = 1.5 * max(scale * 0.5, 1.0) * inv;
    let m = (I(uv + vec2f(r.x, r.y)).a + I(uv + vec2f(-r.x, r.y)).a +
             I(uv + vec2f(r.x, -r.y)).a + I(uv + vec2f(-r.x, -r.y)).a) * 0.25;
    let dark = max(m - luma(c), 0.0) * smoothstep(0.02, 0.15, E(uv));
    c = max(c - vec3f(dark * P.lineDarken * 1.5), vec3f(0.0));
  }
  return vec4f(c, luma(c));
}
`;

  // ------------------------------------------------------------- 5. present
  const present = (mode) => /* wgsl */ `
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var img: texture_2d<f32>;
${videoSource[mode](2)}

fn L(p: vec2i, maxp: vec2i) -> vec3f {
  return textureLoad(img, clamp(p, vec2i(0), maxp), 0).rgb;
}

@fragment
fn fs(fi: VSOut) -> @location(0) vec4f {
  // Split-screen compare: left side shows the original (browser-style bilinear) frame.
  if (P.compare > 0.0 && fi.uv.x < P.compare) {
    let dx = (P.compare - fi.uv.x) * P.dstSize.x;
    if (dx < 2.0) {
      return vec4f(1.0, 0.36, 0.66, 1.0);
    }
    let vidDims = vec2f(textureDimensions(vid));
    let ip = vec2i(fi.uv * vidDims);
    let originalColor = fetchV(ip);
    return vec4f(originalColor.rgb, 1.0);
  }

  let maxp = vec2i(textureDimensions(img)) - vec2i(1);
  let ip = vec2i(fi.pos.xy);
  let c = L(ip, maxp);
  if (P.sharpen <= 0.001) {
    return vec4f(c, 1.0);
  }
  let n = L(ip + vec2i(0, -1), maxp);
  let s = L(ip + vec2i(0, 1), maxp);
  let e = L(ip + vec2i(1, 0), maxp);
  let w = L(ip + vec2i(-1, 0), maxp);
  let ne = L(ip + vec2i(1, -1), maxp);
  let nw = L(ip + vec2i(-1, -1), maxp);
  let se = L(ip + vec2i(1, 1), maxp);
  let sw = L(ip + vec2i(-1, 1), maxp);

  let mn = min(c, min(min(min(n, s), min(e, w)), min(min(ne, nw), min(se, sw))));
  let mx = max(c, max(max(max(n, s), max(e, w)), max(max(ne, nw), max(se, sw))));

  // Unsharp mask against a 3x3 gaussian, backed off where contrast is already high,
  // and clamped to the local range so it can never create halos.
  let blur = c * 0.25 + (n + s + e + w) * 0.125 + (ne + nw + se + sw) * 0.0625;
  let detail = c - blur;
  let k = P.sharpen * 2.5 * (vec3f(1.0) - smoothstep(vec3f(0.15), vec3f(0.8), mx - mn) * 0.6);
  let r = clamp(c + detail * k, mn, mx);
  return vec4f(r, 1.0);
}
`;

  NS.SHADERS = { common, prep, upscale, edges, warp, present };
})();
