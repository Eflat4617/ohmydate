// OhMyDate's glass object (HOLO-05), in three.js: the brand mark in the round.
//
// An open ring of glass (the O of OhMyDate, a day) with a bead of glass in its
// opening (the date, now), and a second, smaller band turning inside it. The
// glass is physically based — light goes through it across a real thickness
// (transmission, thickness, an index of refraction), with a little thin-film
// iridescence — lit lime from the upper left and cyan from the lower right in
// a small studio made in code. A small glowing core sits inside, so there is
// something for the glass to bend.
//
// This file is the only place that imports three.js, and it is loaded with a
// dynamic import (components/ui/GlassOrb.vue), so three is its own chunk and
// arrives only where a live object is about to be drawn. No model, no texture
// file and no network request goes into the scene. scripts/render-glass-orb.mjs
// renders the still image from this same module.
import {
  ACESFilmicToneMapping,
  BackSide,
  BufferAttribute,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PMREMGenerator,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  SRGBColorSpace,
  Scene,
  SphereGeometry,
  TorusGeometry,
  WebGLRenderer,
} from 'three';
import { GLASS_MATERIAL } from './glassOrb';

// The two lights of the system, as the scene's own light colours.
const LIME = 0xc8f560;
const CYAN = 0x6fe0dc;

function glass(tint, extra = {}) {
  return new MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: GLASS_MATERIAL.roughness,
    transmission: GLASS_MATERIAL.transmission,
    thickness: GLASS_MATERIAL.thickness,
    ior: GLASS_MATERIAL.ior,
    dispersion: GLASS_MATERIAL.dispersion,
    iridescence: GLASS_MATERIAL.iridescence,
    iridescenceIOR: GLASS_MATERIAL.iridescenceIOR,
    iridescenceThicknessRange: [140, 460],
    clearcoat: GLASS_MATERIAL.clearcoat,
    clearcoatRoughness: 0.06,
    attenuationColor: new Color(tint),
    // Clear glass with a tint, not coloured plastic: light keeps most of itself across the band.
    attenuationDistance: 1.7,
    envMapIntensity: 1,
    ...extra,
  });
}

/**
 * The studio the glass reflects, made in code: a dark room with a lime soft
 * box at the upper left, a cyan one at the lower right, a white strip
 * overhead and a faint fill behind the camera. No image goes into it.
 */
function studio(pmrem) {
  const room = new Scene();
  const disposables = [];
  const add = (geometry, material) => {
    disposables.push(geometry, material);
    const mesh = new Mesh(geometry, material);
    room.add(mesh);
    return mesh;
  };
  add(new SphereGeometry(30, 16, 12), new MeshBasicMaterial({ color: 0x06090a, side: BackSide }));
  const panel = (colour, strength, width, height, at) => {
    const mesh = add(
      new PlaneGeometry(width, height),
      new MeshBasicMaterial({ color: new Color(colour).multiplyScalar(strength), side: DoubleSide, toneMapped: false }),
    );
    mesh.position.set(at[0], at[1], at[2]);
    mesh.lookAt(0, 0, 0);
  };
  panel(LIME, 9, 7, 7, [-9, 7, 5]);
  panel(CYAN, 8, 7, 7, [9, -6, 4]);
  panel(0xffffff, 5, 12, 2.4, [0, 11, 1]);
  panel(0xffffff, 0.9, 16, 16, [0, 0, 14]);
  panel(CYAN, 2.2, 5, 9, [-10, -5, -6]);
  panel(LIME, 2.2, 5, 9, [10, 6, -6]);
  const target = pmrem.fromScene(room, 0.03);
  for (const item of disposables) item.dispose();
  return target;
}

/** A small glowing core, lime at its upper left to cyan at its lower right: what the glass bends. */
function core() {
  const geometry = new SphereGeometry(0.4, 40, 28);
  const position = geometry.getAttribute('position');
  const colours = new Float32Array(position.count * 3);
  const lime = new Color(LIME);
  const cyan = new Color(CYAN);
  const mixed = new Color();
  for (let index = 0; index < position.count; index += 1) {
    // −1 at the lower right … +1 at the upper left.
    const side = (position.getY(index) - position.getX(index)) / 0.57;
    mixed.copy(cyan).lerp(lime, Math.max(0, Math.min(1, side * 0.5 + 0.5)));
    colours[index * 3] = mixed.r;
    colours[index * 3 + 1] = mixed.g;
    colours[index * 3 + 2] = mixed.b;
  }
  geometry.setAttribute('color', new BufferAttribute(colours, 3));
  return new Mesh(geometry, new MeshBasicMaterial({ vertexColors: true }));
}

/**
 * Build the scene on `canvas` (its width and height are the backing size).
 * Returns null when WebGL will not give a context.
 */
export function createGlassScene(canvas) {
  let renderer;
  try {
    renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  } catch {
    return null;
  }
  renderer.setPixelRatio(1);
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const environment = studio(pmrem);
  scene.environment = environment.texture;

  const camera = new PerspectiveCamera(30, canvas.width / Math.max(1, canvas.height), 0.1, 60);
  camera.position.set(0, 0, 8.2);

  const lime = new PointLight(LIME, 40, 30);
  lime.position.set(-3.4, 3, 3.6);
  const cyan = new PointLight(CYAN, 34, 30);
  cyan.position.set(3.6, -2.8, 3);
  scene.add(lime, cyan);

  const form = new Group();
  scene.add(form);

  // The ring: open, like the mark's — the opening is where the bead sits.
  const OPENING = Math.PI * 0.36;
  const ringGeometry = new TorusGeometry(1.3, 0.3, 64, 200, Math.PI * 2 - OPENING);
  const ringMaterial = glass(LIME);
  const ring = new Mesh(ringGeometry, ringMaterial);
  const beadAngle = Math.PI * 0.22;
  ring.rotation.z = beadAngle + OPENING / 2;
  form.add(ring);
  // Its two ends are rounded off (a cut torus is hollow).
  const capGeometry = new SphereGeometry(0.3, 40, 28);
  for (const angle of [beadAngle + OPENING / 2, beadAngle - OPENING / 2]) {
    const cap = new Mesh(capGeometry, ringMaterial);
    cap.position.set(Math.cos(angle) * 1.3, Math.sin(angle) * 1.3, 0);
    form.add(cap);
  }

  // The bead in the opening.
  const beadGeometry = new SphereGeometry(0.3, 48, 32);
  const beadMaterial = glass(CYAN, { iridescence: 0.75, thickness: 0.6, attenuationDistance: 0.8 });
  const bead = new Mesh(beadGeometry, beadMaterial);
  bead.position.set(Math.cos(beadAngle) * 1.3, Math.sin(beadAngle) * 1.3, 0);
  form.add(bead);

  // A smaller band inside, on its own axis.
  const bandGeometry = new TorusGeometry(0.72, 0.13, 40, 160);
  const bandMaterial = glass(CYAN, { thickness: 0.5, attenuationDistance: 0.9 });
  const band = new Mesh(bandGeometry, bandMaterial);
  form.add(band);

  // The core the glass bends (opaque, so it is in what is refracted).
  const heart = core();
  form.add(heart);

  return {
    draw(timeSec, light) {
      // A slow turn, never a spin: the ring leans back and forth while it turns.
      form.rotation.y = -0.5 + Math.sin(timeSec * 0.21) * 0.62;
      form.rotation.x = 0.32 + Math.sin(timeSec * 0.16 + 1.1) * 0.2;
      form.rotation.z = Math.sin(timeSec * 0.11) * 0.12;
      band.rotation.x = 1.2 + timeSec * 0.27;
      band.rotation.y = timeSec * -0.18;
      heart.rotation.z = timeSec * 0.12;
      // The studio is brighter on the light scheme, where the object sits on a pale ground.
      renderer.toneMappingExposure = 1 + light * 0.2;
      scene.environmentIntensity = 1 + light * 0.25;
      renderer.render(scene, camera);
    },
    dispose() {
      for (const geometry of [ringGeometry, capGeometry, beadGeometry, bandGeometry, heart.geometry]) geometry.dispose();
      for (const material of [ringMaterial, beadMaterial, bandMaterial, heart.material]) material.dispose();
      environment.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}
