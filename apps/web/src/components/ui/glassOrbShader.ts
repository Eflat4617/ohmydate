/**
 * OhMyDate's glass object (HOLO-01): three nested bands of glass turning
 * around a small core — the brand mark's ring and dot, in the round. Written
 * for this project; no library, no model file, no image goes into it.
 *
 * A fragment shader ray-marches the signed distance field of the bands. Each
 * hit is shaded as glass: a Fresnel reflection of a small studio (a soft box
 * overhead, a lime strip at the left, a cyan rim at the right), and the light
 * that enters, crosses the band and leaves again, tinted lime to cyan by how
 * much glass it crossed and split a little by colour on the way out.
 *
 * scripts/render-glass-orb.mjs reads the two sources between the markers
 * below to render the still that stands in when WebGL is missing.
 */

export const GLASS_STILL_TIME = 47;

export const GLASS_VERTEX_SHADER = /* glsl:vertex:begin */ `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
` /* glsl:vertex:end */;

export const GLASS_FRAGMENT_SHADER = /* glsl:fragment:begin */ `
precision highp float;

uniform vec2 u_res;
uniform float u_time;
uniform float u_light;

// The three bands' orientations, worked out once per pixel in main().
mat3 g_a;
mat3 g_b;
mat3 g_c;

mat3 rotX(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c);
}

mat3 rotY(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
}

mat3 rotZ(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0);
}

void orient() {
  float t = u_time;
  // The whole piece leans and turns slowly, so it is never seen edge-on.
  mat3 lean = rotY(0.3 * sin(t * 0.17)) * rotX(0.42 + 0.08 * sin(t * 0.21));
  g_a = rotX(1.05 + 0.07 * t) * rotZ(0.55 + 0.11 * t) * lean;
  g_b = rotZ(0.35 + 0.13 * t) * rotX(-0.75 - 0.09 * t) * lean;
  g_c = rotZ(1.3) * rotX(-0.5 + 0.16 * t) * rotY(0.4 + 0.1 * t) * lean;
}

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// A band: a ring whose section is a tall rounded lozenge.
float band(vec3 p, float radius, vec2 size) {
  vec2 q = vec2(length(p.xz) - radius, p.y);
  float round = size.x * 0.92;
  vec2 d = abs(q) - size + round;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - round;
}

float map(vec3 p) {
  float d = band(g_a * p, 0.9, vec2(0.078, 0.2));
  d = smin(d, band(g_b * p, 0.635, vec2(0.074, 0.17)), 0.06);
  d = smin(d, band(g_c * p, 0.4, vec2(0.07, 0.14)), 0.06);
  d = smin(d, length(p) - 0.185, 0.05);
  return d;
}

vec3 normalAt(vec3 p) {
  vec2 e = vec2(0.0028, -0.0028);
  return normalize(
    e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx) + e.yxy * map(p + e.yxy) + e.xxx * map(p + e.xxx)
  );
}

const vec3 LIME = vec3(0.66, 0.97, 0.16);
const vec3 CYAN = vec3(0.16, 0.9, 0.88);

// The studio the glass stands in: nothing but shaped lights on near-black.
vec3 env(vec3 d) {
  float top = smoothstep(0.25, 0.95, d.y);
  float strip = smoothstep(0.22, 0.0, abs(d.x + 0.5)) * smoothstep(-0.6, 0.15, d.y) * smoothstep(-0.35, 0.5, d.z);
  float rim = smoothstep(0.36, 0.0, abs(d.x - 0.78)) * smoothstep(-0.8, 0.2, d.y);
  float bounce = smoothstep(-0.1, -1.0, d.y);
  // Two broad washes give the glass its colour: lime from the upper left,
  // cyan from the lower right.
  float washL = pow(max(dot(d, normalize(vec3(-0.75, 0.55, 0.35))), 0.0), 2.0);
  float washC = pow(max(dot(d, normalize(vec3(0.7, -0.45, 0.3))), 0.0), 2.0);
  vec3 col = mix(vec3(0.01, 0.02, 0.016), vec3(0.2, 0.27, 0.23), u_light);
  col += LIME * washL * 0.55;
  col += CYAN * washC * 0.5;
  col += vec3(1.0, 1.0, 0.94) * top * mix(1.0, 1.5, u_light);
  col += mix(LIME, vec3(1.0), 0.25) * strip * 2.8;
  col += mix(CYAN, vec3(1.0), 0.12) * rim * 1.9;
  col += mix(LIME, CYAN, 0.6) * bounce * mix(0.3, 0.55, u_light);
  return col;
}

vec3 tintAt(vec3 p) {
  // Lime at the upper left, cyan at the lower right.
  return mix(LIME, CYAN, smoothstep(-0.7, 0.7, p.x * 0.8 - p.y * 0.62));
}

// What a ray that has left the glass meets next: another band (seen as a
// simpler glass, so the piece reads as layers) or, x < 0, nothing.
vec3 beyond(vec3 o, vec3 d) {
  float t = 0.03;
  bool hit = false;
  for (int i = 0; i < 24; i++) {
    float h = map(o + d * t);
    if (h < 0.0025) {
      hit = true;
      break;
    }
    t += h * 0.9;
    if (t > 2.4) break;
  }
  if (!hit) return vec3(-1.0);
  vec3 q = o + d * t;
  vec3 n = normalAt(q);
  float f = 0.05 + 0.95 * pow(1.0 - max(dot(-d, n), 0.0), 5.0);
  vec3 tint = tintAt(q);
  vec3 through = env(refract(d, n, 1.0 / 1.25)) * tint + tint * 0.2;
  return mix(through, env(reflect(d, n)), f);
}

vec3 glass(vec3 p, vec3 rd) {
  vec3 n = normalAt(p);
  float facing = max(dot(-rd, n), 0.0);
  float fresnel = 0.045 + 0.955 * pow(1.0 - facing, 5.0);
  vec3 reflected = env(reflect(rd, n));

  // Into the band, across it, to the far surface (then the crossing is
  // narrowed down, so neighbouring pixels leave at neighbouring points).
  vec3 inside = refract(rd, n, 1.0 / 1.46);
  float near = 0.012;
  float far = 0.012;
  for (int i = 0; i < 28; i++) {
    float d = -map(p + inside * far);
    if (d < 0.0) break;
    near = far;
    far += max(d * 0.85, 0.008);
    if (far > 1.5) break;
  }
  for (int i = 0; i < 5; i++) {
    float mid = 0.5 * (near + far);
    if (-map(p + inside * mid) < 0.0) far = mid;
    else near = mid;
  }
  float travel = 0.5 * (near + far);
  vec3 pe = p + inside * travel;
  vec3 ne = -normalAt(pe);

  // Out again, each colour bent a little differently.
  vec3 outR = refract(inside, ne, 1.43);
  vec3 outG = refract(inside, ne, 1.46);
  vec3 outB = refract(inside, ne, 1.5);
  vec3 bounceBack = reflect(inside, ne);
  bool leaves = dot(outG, outG) > 0.5;
  if (dot(outR, outR) < 0.5) outR = bounceBack;
  if (!leaves) outG = bounceBack;
  if (dot(outB, outB) < 0.5) outB = bounceBack;
  vec3 through = vec3(env(outR).r, env(outG).g, env(outB).b);
  if (leaves) {
    vec3 seen = beyond(pe + outG * 0.02, outG);
    if (seen.x >= 0.0) through = mix(through, seen, 0.82);
  }

  // Deeper glass, deeper colour.
  vec3 tint = tintAt(pe);
  float depth = 1.0 - exp(-travel * 4.5);
  vec3 absorbed = exp(-(1.0 - tint) * travel * 5.2);
  vec3 body = through * absorbed + tint * (0.16 + 0.12 * u_light) * depth;

  vec3 col = mix(body, reflected, fresnel);
  // A hard glint where the key light grazes an edge.
  vec3 key = normalize(vec3(-0.55, 0.7, 0.6));
  col += vec3(1.0, 1.0, 0.94) * pow(max(dot(reflect(rd, n), key), 0.0), 70.0) * 1.5;
  return col;
}

void main() {
  orient();
  vec2 uv = (gl_FragCoord.xy * 2.0 - u_res) / min(u_res.x, u_res.y);
  vec3 ro = vec3(0.0, 0.0, 3.7);
  vec3 rd = normalize(vec3(uv, -3.05));

  float t = 2.45;
  float nearest = 1e3;
  bool hit = false;
  for (int i = 0; i < 72; i++) {
    float d = map(ro + rd * t);
    nearest = min(nearest, d);
    if (d < 0.001 * t) {
      hit = true;
      break;
    }
    t += d * 0.85;
    if (t > 5.0) break;
  }

  if (hit) {
    vec3 col = glass(ro + rd * t, rd);
    col = col / (1.0 + col * 0.66);
    col = pow(col, vec3(1.0 / 2.2));
    // A little more colour than the tone curve leaves.
    float grey = dot(col, vec3(0.299, 0.587, 0.114));
    col = clamp(mix(vec3(grey), col, 1.28), 0.0, 1.0);
    gl_FragColor = vec4(col, 1.0);
  } else {
    // A soft edge and, on the dark scheme, a breath of light around the glass
    // (premultiplied: the colour never exceeds the alpha).
    float px = 2.0 / min(u_res.x, u_res.y);
    float edge = smoothstep(px * 1.6, 0.0, nearest);
    float halo = exp(-nearest * 9.0) * 0.12 * (1.0 - u_light);
    vec3 haloTint = mix(LIME, CYAN, smoothstep(-0.8, 0.8, uv.x - uv.y));
    float alpha = clamp(halo + edge, 0.0, 1.0);
    gl_FragColor = vec4(haloTint * alpha * 0.85, alpha);
  }
}
` /* glsl:fragment:end */;
