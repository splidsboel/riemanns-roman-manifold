// riemanns-roman-manifold — semantic search 3D explorer
// Local world: full-viewport FPS scene of CLAP/UMAP points
// Global world: bottom-right cube minimap with current location + destination
// Search flow: gimbal (0.6s) → illuminate (1.0s) → travel (1.5s)
//   travel runs in parallel in local + global worlds (same duration)
//
// FUTURE: this UI is one of three planned panes (ProducerPal, Ableton,
// Semantic Search). It would be cool if the three windows could be linked
// in a fixed layout (split-pane / tiled) so resizing or repositioning one
// updates the others automatically — no per-window manual adjustment.
// Today the entire UI lives at the document root; when we move to the
// three-pane shell, the search pane should be wrappable in a single
// container (#search-root) with no fixed positioning of its own.

import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = '';
const PHASE = {
  GIMBAL_MS:     600,
  ILLUMINATE_MS: 1000,
  TRAVEL_MS:     1500,
  EXPAND_MS:     500,   // point-size expansion after arrival
};

const PT_SIZE_DEFAULT = 0.3; // base point size outside a cluster
const PT_SIZE_ARRIVED = 0.5; // point size once arrived inside a cluster
const AUTO_ROTATE_RAD_PER_SEC = 0.15; // slow yaw after arrival

const COLORS = {
  fg:      0x000000,
  bg:      0xffffff,
  accent:  0xd40000,
  muted:   0x888888,
};

const COLORS_DARK = {
  fg:      0xcdd6f4,
  bg:      0x11111b,
  accent:  0x89b4fa,
  muted:   0x6c7086,
};

let darkMode = true;
function theme() { return darkMode ? COLORS_DARK : COLORS; }

// Cluster palette via golden-ratio HSL (matches samplevec).
// Null / undefined / negative IDs are treated as HDBSCAN-style "noise" and
// dimmed to a near-background tone so they recede instead of flashing red.
// `isDark` controls the noise tone so light mode keeps a readable gray.
function clusterColor(c, isDark = false) {
  if (c === null || c === undefined || c < 0) {
    return isDark ? new THREE.Color(0.22, 0.22, 0.28)
                  : new THREE.Color(0.55, 0.55, 0.60);
  }
  const h = (c * 0.618033988749895) % 1.0;
  return new THREE.Color().setHSL(h, 0.75, 0.62);
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM refs
// ─────────────────────────────────────────────────────────────────────────────

const overlay         = document.getElementById('overlay');
const overlayMsg      = document.getElementById('overlay-msg');
const searchInput     = document.getElementById('search-input');
const searchStatus    = document.getElementById('search-status');
const crosshairLabel  = document.getElementById('crosshair-label');
const hoverLabel      = document.getElementById('hover-label');
const settingsToggle  = document.getElementById('settings-toggle');
const settingsPanel   = document.getElementById('settings-panel');
const localCanvas     = document.getElementById('canvas-local');
const globalCanvas    = document.getElementById('canvas-global');

// ─────────────────────────────────────────────────────────────────────────────
// Local world (Three.js, full viewport)
// ─────────────────────────────────────────────────────────────────────────────

const scene = new THREE.Scene();
scene.background = new THREE.Color(theme().bg);
scene.fog = null;

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.01, 5000);
camera.rotation.order = 'YXZ';

const renderer = new THREE.WebGLRenderer({ canvas: localCanvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  updateStarUniforms();
});

// ─────────────────────────────────────────────────────────────────────────────
// Point cloud — round black points on white, with shader-controlled illumination
// ─────────────────────────────────────────────────────────────────────────────

const STAR_VERT = `
attribute float aIllum;
attribute vec3  aColor;
uniform float uSize;
uniform float uScale;
varying float vIllum;
varying vec3  vColor;
varying float vDist;
void main() {
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPos;
  float dist = -mvPos.z;
  float sizeMul = 1.0 + aIllum * 0.6;
  gl_PointSize = uSize * sizeMul * (uScale / max(dist, 0.001));
  vIllum = aIllum;
  vColor = aColor;
  vDist  = dist;
}`;

const STAR_FRAG = `
uniform float uDark;
uniform vec3  uMono;
uniform vec3  uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uMinBright;
uniform float uFogStrength;
varying float vIllum;
varying vec3  vColor;
varying float vDist;

// Gaussian × rational-reach spike, only extending in the +axis direction.
// Used in dark mode to get samplevec's diffraction-spike star look.
float spike(vec2 uv, vec2 axis) {
  float along   = dot(uv, axis);
  float perp    = dot(uv, vec2(-axis.y, axis.x));
  float falloff = exp(-perp * perp * 200.0);
  float reach   = 1.0 / (1.0 + along * along * 40.0 + pow(abs(along), 0.5) * 4.0);
  return max(0.0, falloff * reach * step(0.0, along));
}

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float r = length(uv);

  // Illumination pulse ring (shared by both themes — monochrome).
  float ring = 0.0;
  if (vIllum > 0.0) {
    float ringR = mix(0.42, 0.49, vIllum);
    ring = (1.0 - smoothstep(0.005, 0.025, abs(r - ringR))) * vIllum;
  }

  // Shape — light mode: hard round disc. Dark mode: soft core + 4 spikes.
  float discMask = 1.0 - smoothstep(0.40, 0.50, r);
  float core     = pow(1.0 - smoothstep(0.0, 0.5, r), 2.0);
  float spikes   = spike(uv, vec2(1.0, 0.0))
                 + spike(uv, vec2(-1.0, 0.0))
                 + spike(uv, vec2(0.0, 1.0))
                 + spike(uv, vec2(0.0, -1.0));
  float starShape = clamp(core + spikes * 0.6, 0.0, 1.0);

  float shape = mix(discMask, starShape, uDark);
  float alpha = max(shape, ring);
  if (alpha < 0.01) discard;

  // Light: monochrome black. Dark: per-cluster colour.
  vec3 col = mix(uMono, vColor, uDark);
  col = mix(col, vec3(1.0), ring * uDark);

  // Depth cue — fade toward fog/background, but floor at uMinBright so
  // distant stars never fully vanish in dark mode.
  float fogAmt = smoothstep(uFogNear, uFogFar, vDist) * (1.0 - vIllum * 0.8);
  fogAmt = fogAmt * (1.0 - uMinBright) * uFogStrength;
  col = mix(col, uFogColor, fogAmt);

  gl_FragColor = vec4(col, alpha);
}`;

let points = [];                   // [{path, filename, x, y, z, cluster}]
let rawPos = null;                 // Float32Array (n*3)
let clusterCentroidsFlat = null;
let posFlat = null;
let illumAttr = null;              // per-point illumination (0..1)
let pathIndex = new Map();
let pointCloud = null;
let baseMaxDist = 1;
let cloudCenter = new THREE.Vector3();

// Slider state
let worldScale  = 40;
let densityMult = 3.0;
let ptsMult     = PT_SIZE_DEFAULT;
let spdMult     = 7.0;
let baseMoveSpd = 1;
let basePtSize  = 0.1;
let fogStrength = 0.0;

// Controls
let pointerLocked = false;
const keys = {};
let moveSpeed = 1.0;
let glideMult = 0.2;                        // 0 = instant stop; 1 = very slippery
const velocity = new THREE.Vector3();       // current velocity (units / sec)

// Animation state
let flyAnim    = null;  // local-world camera fly
let gimbalAnim = null;  // local-world gimbal rotation
let illumAnim  = null;  // per-point illuminate pulse
let expandAnim = null;  // point-size expansion after arrival
let autoRotateActive = false; // slow yaw after arrival, killed by any user input
let illuminatedSet = new Set();
let usingDemoData = false;

// Crosshair-based picking
const raycaster = new THREE.Raycaster();
const screenCenter = new THREE.Vector2(0, 0);
let crosshairIdx = -1;

// Audio preview — single reused element, so a new play auto-cancels the previous.
const audioEl = new Audio();
audioEl.preload = 'none';
audioEl.crossOrigin = 'anonymous';

function playSampleAt(idx) {
  if (idx < 0 || !points[idx]) return;
  if (usingDemoData) return;
  const id = points[idx].id;
  if (id === undefined || id === null) return;
  audioEl.src = API_BASE + '/audio/' + id;
  audioEl.currentTime = 0;
  audioEl.play().catch(() => {
    searchStatus.textContent = 'audio failed';
  });
  searchStatus.textContent = '▶ ' + points[idx].filename;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scale/position helpers
// ─────────────────────────────────────────────────────────────────────────────

function recomputePositions() {
  if (!rawPos || !clusterCentroidsFlat) return;
  const n = rawPos.length / 3;
  for (let i = 0; i < n; i++) {
    const cx = clusterCentroidsFlat[i*3];
    const cy = clusterCentroidsFlat[i*3+1];
    const cz = clusterCentroidsFlat[i*3+2];
    posFlat[i*3]   = (cx + (rawPos[i*3]   - cx) * densityMult) * worldScale;
    posFlat[i*3+1] = (cy + (rawPos[i*3+1] - cy) * densityMult) * worldScale;
    posFlat[i*3+2] = (cz + (rawPos[i*3+2] - cz) * densityMult) * worldScale;
  }
  if (pointCloud) {
    pointCloud.geometry.attributes.position.array.set(posFlat);
    pointCloud.geometry.attributes.position.needsUpdate = true;
    pointCloud.geometry.computeBoundingSphere();
    pointCloud.geometry.computeBoundingBox();
  }
}

function applyWorldScale(newScale) {
  const prev = worldScale;
  worldScale = newScale;
  recomputePositions();
  if (pointCloud && prev > 0 && prev !== worldScale) {
    camera.position.multiplyScalar(worldScale / prev);
  }
  const md = baseMaxDist * worldScale;
  baseMoveSpd = md * 0.002;
  moveSpeed   = baseMoveSpd * spdMult;
  basePtSize  = md * 0.012;
  if (pointCloud) updateStarUniforms();
  raycaster.params.Points = { threshold: md * 0.015 };
  camera.near = Math.max(0.01, md * 0.0005);
  camera.far  = md * 12;
  camera.updateProjectionMatrix();
}

function updateStarUniforms() {
  if (!pointCloud) return;
  const u = pointCloud.material.uniforms;
  u.uSize.value  = basePtSize * ptsMult;
  u.uScale.value = 0.5 * renderer.domElement.height * camera.projectionMatrix.elements[5];
  const md = baseMaxDist * worldScale;
  u.uFogNear.value = md * 0.4;
  u.uFogFar.value  = md * 2.5;
  u.uFogColor.value.setHex(theme().bg);
}

// ─────────────────────────────────────────────────────────────────────────────
// Build local scene
// ─────────────────────────────────────────────────────────────────────────────

function buildLocalScene(data) {
  points = data.points;
  const n = points.length;
  rawPos  = new Float32Array(n * 3);
  posFlat = new Float32Array(n * 3);
  illumAttr = new Float32Array(n);
  pathIndex.clear();

  let cx = 0, cy = 0, cz = 0;
  const clusterSums = new Map();
  for (let i = 0; i < n; i++) {
    const p = points[i];
    rawPos[i*3] = p.x; rawPos[i*3+1] = p.y; rawPos[i*3+2] = p.z;
    cx += p.x; cy += p.y; cz += p.z;
    pathIndex.set(p.path, i);
    if (p.cluster >= 0) {
      if (!clusterSums.has(p.cluster)) clusterSums.set(p.cluster, {x:0,y:0,z:0,count:0});
      const s = clusterSums.get(p.cluster);
      s.x += p.x; s.y += p.y; s.z += p.z; s.count++;
    }
  }
  cx /= n; cy /= n; cz /= n;
  cloudCenter.set(cx, cy, cz);

  const clusterCentroids = new Map();
  for (const [id, s] of clusterSums) {
    clusterCentroids.set(id, { x: s.x/s.count, y: s.y/s.count, z: s.z/s.count });
  }

  clusterCentroidsFlat = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const cl = points[i].cluster;
    const cent = cl >= 0 ? clusterCentroids.get(cl)
                         : { x: rawPos[i*3], y: rawPos[i*3+1], z: rawPos[i*3+2] };
    clusterCentroidsFlat[i*3]   = cent.x;
    clusterCentroidsFlat[i*3+1] = cent.y;
    clusterCentroidsFlat[i*3+2] = cent.z;
  }

  baseMaxDist = 0;
  for (let i = 0; i < n; i++) {
    const dx = rawPos[i*3]-cx, dy = rawPos[i*3+1]-cy, dz = rawPos[i*3+2]-cz;
    const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (d > baseMaxDist) baseMaxDist = d;
  }

  const colorAttr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const c = clusterColor(points[i].cluster, darkMode);
    colorAttr[i*3] = c.r; colorAttr[i*3+1] = c.g; colorAttr[i*3+2] = c.b;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('aIllum',   new THREE.BufferAttribute(illumAttr, 1));
  geo.setAttribute('aColor',   new THREE.BufferAttribute(colorAttr, 3));

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSize:     { value: basePtSize * ptsMult },
      uScale:    { value: 1.0 },
      uDark:     { value: darkMode ? 1.0 : 0.0 },
      uMono:     { value: new THREE.Color(0x000000) },
      uFogColor: { value: new THREE.Color(theme().bg) },
      uFogNear:  { value: baseMaxDist * worldScale * 0.4 },
      uFogFar:   { value: baseMaxDist * worldScale * 2.5 },
      uMinBright:{ value: darkMode ? 0.25 : 0.0 },
      uFogStrength: { value: fogStrength },
    },
    vertexShader:   STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent:    true,
    depthWrite:     false,
    blending:       darkMode ? THREE.AdditiveBlending : THREE.NormalBlending,
  });

  pointCloud = new THREE.Points(geo, mat);
  scene.add(pointCloud);

  applyWorldScale(worldScale);

  // Start further from the cloud so the initial view has real breathing room.
  camera.position.set(
    cx * worldScale,
    cy * worldScale,
    cz * worldScale + baseMaxDist * worldScale * 2.0,
  );

  buildGlobalScene();
  overlay.classList.add('hidden');
}

function setIllumination(indices, value) {
  if (!illumAttr) return;
  for (const i of indices) illumAttr[i] = value;
  pointCloud.geometry.attributes.aIllum.needsUpdate = true;
}

function clearIllumination() {
  if (!illumAttr) return;
  illumAttr.fill(0);
  pointCloud.geometry.attributes.aIllum.needsUpdate = true;
  illuminatedSet.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Global world (mini cube minimap)
// ─────────────────────────────────────────────────────────────────────────────

const globalScene = new THREE.Scene();
globalScene.background = new THREE.Color(theme().bg);

const globalCamera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
// More side-on viewing angle (slight elevation instead of corner-isometric)
globalCamera.position.set(0, 0.3, 3.0);
globalCamera.lookAt(0, 0, 0);

const globalRenderer = new THREE.WebGLRenderer({ canvas: globalCanvas, antialias: true, alpha: true });
globalRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
globalRenderer.setSize(220, 220);

const globalGroup = new THREE.Group();
globalScene.add(globalGroup);

let globalCube = null;
let globalCurrentMarker = null;  // accent-color sphere — current location
let globalDestMarker    = null;  // accent-color sphere — destination
let globalTravelLine    = null;  // line from current to destination
let globalMiniCloud     = null;  // static UMAP-reduced points inside the cube

function buildGlobalScene() {
  const cubeGeo = new THREE.BoxGeometry(1, 1, 1);
  const edges = new THREE.EdgesGeometry(cubeGeo);
  globalCube = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: theme().fg }));
  globalGroup.add(globalCube);

  const sphereGeo = new THREE.SphereGeometry(0.04, 16, 16);
  const markerMat = new THREE.MeshBasicMaterial({ color: theme().accent });
  globalCurrentMarker = new THREE.Mesh(sphereGeo, markerMat);
  globalGroup.add(globalCurrentMarker);

  buildGlobalMiniCloud();
}

// Static mini-representation of all embeddings, normalized into [-0.5, 0.5]^3.
// Built once from rawPos (the raw UMAP coords), independent of worldScale.
function buildGlobalMiniCloud() {
  if (!rawPos) return;
  if (globalMiniCloud) {
    globalGroup.remove(globalMiniCloud);
    globalMiniCloud.geometry.dispose();
    globalMiniCloud.material.dispose();
    globalMiniCloud = null;
  }
  const n = rawPos.length / 3;
  let maxAbs = 0;
  for (let i = 0; i < n; i++) {
    const x = rawPos[i*3]   - cloudCenter.x;
    const y = rawPos[i*3+1] - cloudCenter.y;
    const z = rawPos[i*3+2] - cloudCenter.z;
    const m = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
    if (m > maxAbs) maxAbs = m;
  }
  const scale = maxAbs > 0 ? 0.48 / maxAbs : 1;

  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i*3]   = (rawPos[i*3]   - cloudCenter.x) * scale;
    pos[i*3+1] = (rawPos[i*3+1] - cloudCenter.y) * scale;
    pos[i*3+2] = (rawPos[i*3+2] - cloudCenter.z) * scale;
    const c = clusterColor(points[i].cluster);
    col[i*3] = c.r; col[i*3+1] = c.g; col[i*3+2] = c.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.012,
    sizeAttenuation: true,
    vertexColors: darkMode,
    color: darkMode ? 0xffffff : theme().fg,
    transparent: true,
    opacity: darkMode ? 0.9 : 0.65,
    depthWrite: false,
  });
  globalMiniCloud = new THREE.Points(geo, mat);
  globalGroup.add(globalMiniCloud);
}

// Map a local-world position into the global cube ([-0.5..0.5]^3)
function localToGlobal(pos) {
  const md = baseMaxDist * worldScale;
  if (md <= 0) return new THREE.Vector3();
  const cx = cloudCenter.x * worldScale;
  const cy = cloudCenter.y * worldScale;
  const cz = cloudCenter.z * worldScale;
  const v = new THREE.Vector3(
    (pos.x - cx) / (2 * md),
    (pos.y - cy) / (2 * md),
    (pos.z - cz) / (2 * md),
  );
  // Clamp to cube
  v.x = Math.max(-0.5, Math.min(0.5, v.x));
  v.y = Math.max(-0.5, Math.min(0.5, v.y));
  v.z = Math.max(-0.5, Math.min(0.5, v.z));
  return v;
}

function updateGlobalScene() {
  if (!globalCube || !pointCloud) return;
  // Constant slow yaw for "spatial feel"; tiny tilt only — viewed from side.
  globalGroup.rotation.y += 0.0025;
  globalGroup.rotation.x = 0.08;

  // Position current marker based on camera position in local world
  const localPos = localToGlobal(camera.position);
  globalCurrentMarker.position.copy(localPos);

  // Dynamically shrink travel line — its "from" vertex follows current marker,
  // so the line shortens as we approach destination, then clears on arrival.
  if (globalTravelLine && globalDestMarker) {
    const positions = globalTravelLine.geometry.attributes.position;
    positions.setXYZ(0, localPos.x, localPos.y, localPos.z);
    positions.needsUpdate = true;
    if (localPos.distanceTo(globalDestMarker.position) < 0.04) {
      removeGlobalDestination();
    }
  }
}

function setGlobalDestination(localTarget) {
  // Add destination marker + line from current → destination
  removeGlobalDestination();
  const dest = localToGlobal(localTarget);
  const start = localToGlobal(camera.position);

  const sphereGeo = new THREE.SphereGeometry(0.04, 16, 16);
  const markerMat = new THREE.MeshBasicMaterial({ color: theme().accent });
  globalDestMarker = new THREE.Mesh(sphereGeo, markerMat);
  globalDestMarker.position.copy(dest);
  globalGroup.add(globalDestMarker);

  const lineGeo = new THREE.BufferGeometry().setFromPoints([start, dest]);
  const lineMat = new THREE.LineBasicMaterial({ color: theme().fg });
  globalTravelLine = new THREE.Line(lineGeo, lineMat);
  globalGroup.add(globalTravelLine);
}

function removeGlobalDestination() {
  if (globalDestMarker) {
    globalGroup.remove(globalDestMarker);
    globalDestMarker.geometry.dispose();
    globalDestMarker.material.dispose();
    globalDestMarker = null;
  }
  if (globalTravelLine) {
    globalGroup.remove(globalTravelLine);
    globalTravelLine.geometry.dispose();
    globalTravelLine.material.dispose();
    globalTravelLine = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Easing
// ─────────────────────────────────────────────────────────────────────────────

function easeInOut(t) {
  return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

// ─────────────────────────────────────────────────────────────────────────────
// Destination cloud — dark radial haze around target cluster.
// Appears right after gimbal; fades in briefly, then fades out based on the
// camera's distance to the target as the user approaches.
// ─────────────────────────────────────────────────────────────────────────────

let destCloud = null;
let cloudTexLight = null;
let cloudTexDark  = null;

function makeCloudTexture(rgb) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
  g.addColorStop(0.00, `rgba(${rgb},0.55)`);
  g.addColorStop(0.35, `rgba(${rgb},0.20)`);
  g.addColorStop(1.00, `rgba(${rgb},0.00)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

function ensureCloudTexture() {
  if (darkMode) return cloudTexDark  ||= makeCloudTexture('205,214,244');
  return          cloudTexLight ||= makeCloudTexture('0,0,0');
}

function spawnDestCloud(centroid, radius) {
  removeDestCloud();
  const mat = new THREE.SpriteMaterial({
    map: ensureCloudTexture(),
    opacity: 0,
    transparent: true,
    depthWrite: false,
    // Disable scene fog on the cloud — white fog would fade the dark haze to
    // invisibility exactly when we need it to be visible (distant destination).
    fog: false,
  });
  destCloud = new THREE.Sprite(mat);
  destCloud.userData.radius    = radius;
  destCloud.userData.spawnTime = performance.now();
  destCloud.scale.set(radius * 5, radius * 5, 1);
  destCloud.position.copy(centroid);
  scene.add(destCloud);
}

function removeDestCloud() {
  if (!destCloud) return;
  scene.remove(destCloud);
  destCloud.material.dispose();
  destCloud = null;
}

function updateDestCloud() {
  if (!destCloud) return;
  const r    = destCloud.userData.radius;
  const age  = performance.now() - destCloud.userData.spawnTime;
  const dist = camera.position.distanceTo(destCloud.position);
  // Fade in over 300ms
  const fadeIn = Math.min(age / 300, 1);
  // Fade out by distance: visible at >3r, gone inside r.
  const distFade = Math.max(0, Math.min(1, (dist - r) / (r * 2)));
  destCloud.material.opacity = 0.72 * fadeIn * distFade;
  if (destCloud.material.opacity < 0.01 && fadeIn >= 1) removeDestCloud();
}

// ─────────────────────────────────────────────────────────────────────────────
// Pointer lock + movement
// ─────────────────────────────────────────────────────────────────────────────

renderer.domElement.addEventListener('click', () => {
  if (pointerLocked) {
    if (crosshairIdx >= 0) playSampleAt(crosshairIdx);
    return;
  }
  renderer.domElement.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === renderer.domElement;
});

document.addEventListener('mousemove', (e) => {
  if (pointerLocked) {
    if (e.movementX || e.movementY) autoRotateActive = false;
    camera.rotation.y -= e.movementX * 0.0022;
    camera.rotation.x -= e.movementY * 0.0022;
    camera.rotation.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, camera.rotation.x));
  }
});

document.addEventListener('keydown', (e) => {
  // Don't capture keys while typing in the search input
  if (document.activeElement === searchInput) return;
  keys[e.code] = true;
  if (e.code === 'Escape' && pointerLocked) document.exitPointerLock();
  if (pointerLocked && (e.code === 'Space' || e.code.startsWith('Arrow'))) e.preventDefault();
  if (e.code === 'KeyE' && crosshairIdx >= 0) playSampleAt(crosshairIdx);
});

document.addEventListener('keyup', (e) => { delete keys[e.code]; });

renderer.domElement.addEventListener('wheel', (e) => {
  moveSpeed = Math.max(0.005, Math.min(60, moveSpeed * (e.deltaY > 0 ? 1.25 : 0.8)));
}, { passive: true });

function updateMovement(dt) {
  const active = pointerLocked && (
    keys['KeyW'] || keys['KeyS'] || keys['KeyA'] || keys['KeyD'] ||
    keys['Space'] || keys['ShiftLeft'] || keys['ShiftRight'] ||
    keys['ArrowUp'] || keys['ArrowDown'] || keys['ArrowLeft'] || keys['ArrowRight']);
  if (active) autoRotateActive = false;

  const sy = Math.sin(camera.rotation.y);
  const cy = Math.cos(camera.rotation.y);
  let dx = 0, dy = 0, dz = 0;

  if (active) {
    if (keys['KeyW'] || keys['ArrowUp'])    { dx -= sy; dz -= cy; }
    if (keys['KeyS'] || keys['ArrowDown'])  { dx += sy; dz += cy; }
    if (keys['KeyA'] || keys['ArrowLeft'])  { dx -= cy; dz += sy; }
    if (keys['KeyD'] || keys['ArrowRight']) { dx += cy; dz -= sy; }
    if (keys['Space'])                       dy += 1;
    if (keys['ShiftLeft'] || keys['ShiftRight']) dy -= 1;
    const len = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
    dx /= len; dy /= len; dz /= len;
  }

  // Desired velocity (units/sec). moveSpeed is per-frame at ~60fps, so scale.
  const targetSpd = moveSpeed * 60;
  const tx = dx * targetSpd, ty = dy * targetSpd, tz = dz * targetSpd;

  if (glideMult <= 0.0001) {
    // No glide — legacy instant stop, step by per-frame moveSpeed
    velocity.set(0, 0, 0);
    camera.position.x += dx * moveSpeed;
    camera.position.y += dy * moveSpeed;
    camera.position.z += dz * moveSpeed;
    return;
  }

  // Exponential damping toward target velocity. tau grows with glideMult so the
  // camera feels progressively more like "ice in Minecraft".
  //   glide=0.05 → tau≈0.05s (snappy);  glide=1.0 → tau≈1.2s (very slippery)
  const tau = 0.05 + glideMult * 1.15;
  const k   = 1 - Math.exp(-dt / tau);
  velocity.x += (tx - velocity.x) * k;
  velocity.y += (ty - velocity.y) * k;
  velocity.z += (tz - velocity.z) * k;

  camera.position.x += velocity.x * dt;
  camera.position.y += velocity.y * dt;
  camera.position.z += velocity.z * dt;
}

// ─────────────────────────────────────────────────────────────────────────────
// Crosshair picking — what's at screen center
// ─────────────────────────────────────────────────────────────────────────────

function updateCrosshair() {
  if (!pointCloud) { crosshairIdx = -1; return; }
  raycaster.setFromCamera(screenCenter, camera);
  const hits = raycaster.intersectObject(pointCloud);
  if (hits.length > 0) {
    crosshairIdx = hits[0].index;
    const name = points[crosshairIdx].filename;
    crosshairLabel.textContent = name;
    crosshairLabel.classList.add('visible');
    hoverLabel.textContent = name;
    hoverLabel.classList.add('visible');
  } else {
    crosshairIdx = -1;
    crosshairLabel.classList.remove('visible');
    hoverLabel.textContent = '';
    hoverLabel.classList.remove('visible');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Search flow: gimbal → illuminate → travel
// ─────────────────────────────────────────────────────────────────────────────

async function doSearch() {
  const q = searchInput.value.trim();
  if (!q || !posFlat) return;

  searchStatus.textContent = 'searching…';

  let resultPaths = [];
  if (usingDemoData) {
    // No backend — pick a random cluster from the demo cloud as "results"
    // so the animation flow (gimbal → illuminate → travel) can be exercised.
    resultPaths = pickDemoMatches(q, 20);
  } else {
    try {
      const resp = await fetch(API_BASE + '/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, k: 20 }),
      });
      if (!resp.ok) throw new Error(resp.status);
      const data = await resp.json();
      resultPaths = (data.results || []).map(r => r.path);
    } catch (e) {
      searchStatus.textContent = 'search failed';
      return;
    }
  }

  // Resolve to indices in current layout
  const matchIndices = [];
  for (const p of resultPaths) {
    const i = pathIndex.get(p);
    if (i !== undefined) matchIndices.push(i);
  }
  if (matchIndices.length === 0) {
    searchStatus.textContent = 'no matches in layout';
    return;
  }

  // Centroid + radius of matches
  let cx = 0, cy = 0, cz = 0;
  for (const i of matchIndices) {
    cx += posFlat[i*3]; cy += posFlat[i*3+1]; cz += posFlat[i*3+2];
  }
  cx /= matchIndices.length; cy /= matchIndices.length; cz /= matchIndices.length;
  const target = new THREE.Vector3(cx, cy, cz);

  let radius = 0;
  for (const i of matchIndices) {
    const dx = posFlat[i*3]   - cx;
    const dy = posFlat[i*3+1] - cy;
    const dz = posFlat[i*3+2] - cz;
    const d  = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (d > radius) radius = d;
  }
  radius = Math.max(radius, baseMaxDist * worldScale * 0.04);

  searchStatus.textContent = `${matchIndices.length} results · navigating`;
  searchInput.blur();

  // Broadcast to other users so their local copy of this avatar replays
  // the same gimbal+travel flight. Illumination stays personal.
  sendSearch(target, radius * 0.3);

  // Any previous arrival-state is cancelled
  autoRotateActive = false;

  // Auto-enter local mode (density bump only — pt size / speed applied at arrival).
  // If already on, leave the user's density as-is; arrival step still applies.
  if (!localModeActive) enterLocalMode({ applyArrival: false });

  // Reset point size to default pre-travel (expand phase will animate to the final
  // arrival size, which is smaller when local mode is active).
  if (!localModeActive) setPointSize(PT_SIZE_DEFAULT);

  // ── Phase 1: Gimbal — rotate camera toward target without moving
  await runGimbal(target);

  // ── Destination cloud appears right after gimbal, signalling "there"
  spawnDestCloud(target, radius);

  // ── Phase 2: Illuminate — per-point pulse (~1s). Cloud is visible alongside.
  await runIlluminate(matchIndices);

  // ── Phase 3: Travel — camera approaches; cloud fades with distance.
  //             Offset = small fraction of cluster radius so we land INSIDE
  //             the cluster (not parked outside it).
  await runTravel(target, radius * 0.3);

  // ── Arrival cleanup
  removeGlobalDestination();
  removeDestCloud();
  clearIllumination();

  // ── Phase 4: Expand point size 1.7 → 2.1 over ~0.5s (inside cluster)
  //            In local mode, expand toward the smaller LOCAL_PT_SIZE instead
  //            so the final size matches "exploration" settings, then snap move
  //            speed down as well.
  await runExpand(localModeActive ? LOCAL_PT_SIZE : PT_SIZE_ARRIVED);
  if (localModeActive) applySpd(LOCAL_MOVE_SPEED);

  // ── Phase 5: Auto-rotation from FPV, so the user can see nearby points.
  //            Killed by any movement, mouse-look, or new search.
  autoRotateActive = true;

  searchStatus.textContent = `arrived · ${matchIndices.length} results`;
}

function setPointSize(v) {
  ptsMult = v;
  const sld = document.getElementById('sld-pts');
  const val = document.getElementById('val-pts');
  if (sld) sld.value = String(v);
  if (val) val.textContent = v.toFixed(1);
  if (pointCloud) updateStarUniforms();
}

function runGimbal(target) {
  return new Promise(resolve => {
    // Compute target rotation by aiming a temporary camera at the target
    const tmp = new THREE.Object3D();
    tmp.rotation.order = 'YXZ';
    tmp.position.copy(camera.position);
    tmp.lookAt(target);

    // Wrap target yaw to nearest equivalent angle to avoid long-way rotations
    let targetYaw   = tmp.rotation.y;
    const startYaw  = camera.rotation.y;
    while (targetYaw - startYaw >  Math.PI) targetYaw -= Math.PI * 2;
    while (targetYaw - startYaw < -Math.PI) targetYaw += Math.PI * 2;
    const startPitch  = camera.rotation.x;
    const targetPitch = Math.max(-Math.PI/2, Math.min(Math.PI/2, tmp.rotation.x));

    gimbalAnim = {
      start: performance.now(),
      dur:   PHASE.GIMBAL_MS,
      startYaw, startPitch,
      targetYaw, targetPitch,
      onDone: resolve,
    };
  });
}

function updateGimbal(now) {
  if (!gimbalAnim) return;
  const t = Math.min((now - gimbalAnim.start) / gimbalAnim.dur, 1);
  const e = easeInOut(t);
  camera.rotation.y = gimbalAnim.startYaw   + (gimbalAnim.targetYaw   - gimbalAnim.startYaw)   * e;
  camera.rotation.x = gimbalAnim.startPitch + (gimbalAnim.targetPitch - gimbalAnim.startPitch) * e;
  if (t >= 1) {
    const done = gimbalAnim.onDone;
    gimbalAnim = null;
    done && done();
  }
}

function runIlluminate(matchIndices) {
  return new Promise(resolve => {
    illuminatedSet = new Set(matchIndices);
    illumAnim = {
      start: performance.now(),
      dur:   PHASE.ILLUMINATE_MS,
      indices: matchIndices,
      onDone: resolve,
    };
  });
}

function updateIlluminate(now) {
  if (!illumAnim) return;
  const t = Math.min((now - illumAnim.start) / illumAnim.dur, 1);
  // Pulse: ramp up then hold near max
  const v = t < 0.6 ? easeOutCubic(t / 0.6) : 1.0;
  for (const i of illumAnim.indices) illumAttr[i] = v;
  pointCloud.geometry.attributes.aIllum.needsUpdate = true;
  if (t >= 1) {
    const done = illumAnim.onDone;
    illumAnim = null;
    done && done();
  }
}

function runTravel(target, offset) {
  return new Promise(resolve => {
    // `offset` is the distance we stop at from the centroid, on the camera side.
    // Pass cluster radius * small factor to actually LAND INSIDE the cluster
    // rather than parking at a generic cloud-relative distance.
    const dir = new THREE.Vector3().subVectors(camera.position, target).normalize();
    const finalPos = new THREE.Vector3().copy(target).add(dir.multiplyScalar(offset));

    setGlobalDestination(target);

    flyAnim = {
      from:  camera.position.clone(),
      to:    finalPos,
      start: performance.now(),
      dur:   PHASE.TRAVEL_MS,
      onDone: resolve,
    };
  });
}

function updateFly(now) {
  if (!flyAnim) return;
  const t = Math.min((now - flyAnim.start) / flyAnim.dur, 1);
  camera.position.lerpVectors(flyAnim.from, flyAnim.to, easeInOut(t));
  if (t >= 1) {
    const done = flyAnim.onDone;
    flyAnim = null;
    done && done();
  }
}

function runExpand(targetPts) {
  return new Promise(resolve => {
    expandAnim = {
      start:   performance.now(),
      dur:     PHASE.EXPAND_MS,
      fromPts: ptsMult,
      toPts:   targetPts,
      onDone:  resolve,
    };
  });
}

function updateExpand(now) {
  if (!expandAnim) return;
  const t = Math.min((now - expandAnim.start) / expandAnim.dur, 1);
  const e = easeOutCubic(t);
  const v = expandAnim.fromPts + (expandAnim.toPts - expandAnim.fromPts) * e;
  setPointSize(v);
  if (t >= 1) {
    const done = expandAnim.onDone;
    expandAnim = null;
    done && done();
  }
}

function updateAutoRotate(dt) {
  if (!autoRotateActive) return;
  camera.rotation.y -= AUTO_ROTATE_RAD_PER_SEC * dt;
}

searchInput.addEventListener('keydown', (e) => {
  // Enter submits; Shift+Enter inserts a newline (chat-like behavior).
  if (e.code === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    doSearch();
  }
  e.stopPropagation();
});
searchInput.addEventListener('focus', () => {
  if (pointerLocked) document.exitPointerLock();
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings panel
// ─────────────────────────────────────────────────────────────────────────────

settingsToggle.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
});

// ─────────────────────────────────────────────────────────────────────────────
// Theme toggle — light (monochrome) ↔ dark (samplevec palette, cluster colors)
// ─────────────────────────────────────────────────────────────────────────────

const themeToggle = document.getElementById('theme-toggle');

function applyTheme() {
  document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
  themeToggle.textContent = darkMode ? '[ light ]' : '[ dark ]';

  const t = theme();
  scene.background.setHex(t.bg);
  globalScene.background.setHex(t.bg);

  if (pointCloud) {
    const mat = pointCloud.material;
    mat.uniforms.uDark.value = darkMode ? 1.0 : 0.0;
    mat.uniforms.uFogColor.value.setHex(t.bg);
    mat.uniforms.uMinBright.value = darkMode ? 0.25 : 0.0;
    mat.blending = darkMode ? THREE.AdditiveBlending : THREE.NormalBlending;
    mat.needsUpdate = true;
    // Re-derive per-vertex cluster colours so the noise tint tracks the theme.
    const colorAttr = pointCloud.geometry.attributes.aColor;
    for (let i = 0; i < points.length; i++) {
      const c = clusterColor(points[i].cluster, darkMode);
      colorAttr.array[i*3]   = c.r;
      colorAttr.array[i*3+1] = c.g;
      colorAttr.array[i*3+2] = c.b;
    }
    colorAttr.needsUpdate = true;
  }
  if (globalCube) globalCube.material.color.setHex(t.fg);
  if (globalCurrentMarker) globalCurrentMarker.material.color.setHex(t.accent);
  if (globalDestMarker)    globalDestMarker.material.color.setHex(t.accent);
  if (globalTravelLine)    globalTravelLine.material.color.setHex(t.fg);
  if (globalMiniCloud) {
    globalMiniCloud.material.vertexColors = darkMode;
    globalMiniCloud.material.color.setHex(darkMode ? 0xffffff : t.fg);
    globalMiniCloud.material.opacity = darkMode ? 0.9 : 0.65;
    globalMiniCloud.material.needsUpdate = true;
  }
  // Remotes live in a let-binding declared later in the file; on first call
  // (boot) they are still in TDZ, so guard with try/catch rather than typeof.
  try {
    const avatarHex = darkMode ? 0xffffff : 0x000000;
    for (const r of remotes.values()) {
      r.sphere.material.color.setHex(avatarHex);
      r.fwdLine.material.color.setHex(avatarHex);
      r.haloMat.color.setHex(avatarHex);
      r.haloMat.blending = darkMode ? THREE.AdditiveBlending : THREE.NormalBlending;
      r.haloMat.needsUpdate = true;
      r.beaconMat.color.setHex(avatarHex);
      updateAvatarLabel(r, r.handle);
    }
  } catch {}
}

themeToggle.addEventListener('click', () => {
  darkMode = !darkMode;
  applyTheme();
});
applyTheme();

// ── Local exploration mode ─────────────────────────────────────────────────
// Toggle to make dense clusters easier to explore:
//   on enter: CLUSTER DENSITY *= 1.5 (clamped ≤ 2.0) so points spread apart
//   on arrival (or on manual toggle mid-flight): POINT SIZE → 0.15, MOVE SPEED → 1.0
//   on exit: restore the sliders to the values captured on entry
// Auto-activates when a semantic search is triggered (if not already on).

const LOCAL_DENSITY_VALUE = 6.5;
const LOCAL_PT_SIZE       = 0.15;
const LOCAL_MOVE_SPEED    = 1.0;

const localToggle = document.getElementById('local-toggle');
let localModeActive = false;
let localSaved = null; // { density, pts, spd }

function setSliderValue(id, valId, v, decimals = 1) {
  const sld = document.getElementById(id);
  const val = document.getElementById(valId);
  if (sld) sld.value = String(v);
  if (val) val.textContent = v.toFixed(decimals);
}

function applyDensity(v) {
  densityMult = v;
  setSliderValue('sld-density', 'val-density', v);
  recomputePositions();
}
function applyPts(v) {
  ptsMult = v;
  setSliderValue('sld-pts', 'val-pts', v);
  if (pointCloud) updateStarUniforms();
}
function applySpd(v) {
  spdMult = v;
  setSliderValue('sld-spd', 'val-spd', v);
  moveSpeed = baseMoveSpd * spdMult;
}

function enterLocalMode(opts = { applyArrival: true }) {
  if (localModeActive) return;
  localModeActive = true;
  localSaved = { density: densityMult, pts: ptsMult, spd: spdMult };
  applyDensity(LOCAL_DENSITY_VALUE);
  if (opts.applyArrival) {
    applyPts(LOCAL_PT_SIZE);
    applySpd(LOCAL_MOVE_SPEED);
  }
  localToggle.classList.add('active');
  localToggle.textContent = '[ local: on ]';
}

function applyLocalArrival() {
  if (!localModeActive) return;
  applyPts(LOCAL_PT_SIZE);
  applySpd(LOCAL_MOVE_SPEED);
}

function exitLocalMode() {
  if (!localModeActive) return;
  localModeActive = false;
  if (localSaved) {
    applyDensity(localSaved.density);
    applyPts(localSaved.pts);
    applySpd(localSaved.spd);
    localSaved = null;
  }
  localToggle.classList.remove('active');
  localToggle.textContent = '[ local: off ]';
}

localToggle.addEventListener('click', () => {
  if (localModeActive) exitLocalMode();
  else enterLocalMode({ applyArrival: true });
});

function initSlider(id, valId, onChange) {
  const el = document.getElementById(id);
  const valEl = document.getElementById(valId);
  el.addEventListener('input', () => {
    const v = parseFloat(el.value);
    valEl.textContent = v.toFixed(1);
    onChange(v);
  });
}

initSlider('sld-density', 'val-density', v => { densityMult = v; recomputePositions(); });
initSlider('sld-pts',     'val-pts',     v => { ptsMult = v; if (pointCloud) updateStarUniforms(); });
initSlider('sld-spd',     'val-spd',     v => { spdMult = v; moveSpeed = baseMoveSpd * spdMult; });
initSlider('sld-glide',   'val-glide',   v => { glideMult = v; });
initSlider('sld-fog',     'val-fog',     v => {
  fogStrength = v;
  if (pointCloud) pointCloud.material.uniforms.uFogStrength.value = v;
});
initSlider('sld-avatar',  'val-avatar',  v => {
  avatarScale = v;
  try { for (const r of remotes.values()) r.group.scale.setScalar(v); } catch {}
});

// ─────────────────────────────────────────────────────────────────────────────
// Multiplayer — presence + search replay over WebSocket
// ─────────────────────────────────────────────────────────────────────────────
// Pure relay on the server; each client broadcasts its pose (throttled 20 Hz,
// skip if not moving) and its search events (target + offset, startT). Remote
// avatars = small sphere + forward line + billboarded handle sprite. Receiver
// lerps between the last two pose snapshots for smoothness; remote search is
// replayed locally by rotating then translating the avatar over PHASE.*_MS.

const MP_POSE_HZ       = 20;
const MP_POSE_INTERVAL = 1000 / MP_POSE_HZ;
const MP_PING_MS       = 5000;
const MP_AVATAR_R      = 0.9;   // sphere radius in world units
const MP_FWD_LEN       = 3.0;   // forward line length
const MP_LABEL_H       = 2.2;   // label vertical offset
const MP_HALO_MULT     = 5.0;   // halo sprite radius = sphere radius * this
const MP_BEACON_HALF   = 120;   // vertical beacon reaches ±this from avatar
const MP_LABEL_W       = 4.2;   // label world width

let mpHaloTex = null;
function ensureHaloTex() {
  if (mpHaloTex) return mpHaloTex;
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
  g.addColorStop(0.00, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  g.addColorStop(0.60, 'rgba(255,255,255,0.10)');
  g.addColorStop(1.00, 'rgba(255,255,255,0.00)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  mpHaloTex = new THREE.CanvasTexture(c);
  return mpHaloTex;
}

const remotes = new Map(); // id -> { handle, group, sphere, fwdLine, label, labelMat,
                           //        lastPose, prevPose, lastPoseT,
                           //        miniDot, searchAnim }

let avatarScale = 1.0;

let mpSocket = null;
let mpUserId = null;
let mpHandle = localStorage.getItem('handle') || '';
let mpLastPoseSent = 0;
let mpLastPoseP = new THREE.Vector3(NaN, NaN, NaN);
let mpLastPoseRx = NaN, mpLastPoseRy = NaN;
let mpLastTrafficT = 0;

// ── Handle prompt ──────────────────────────────────────────────────────────
const handleModal   = document.getElementById('handle-modal');
const handleInput   = document.getElementById('handle-input');
const handleSubmit  = document.getElementById('handle-submit');
const nameToggle    = document.getElementById('name-toggle');
const presenceChip  = document.getElementById('presence-indicator');

function updatePresenceChip() {
  const connected = mpSocket && mpSocket.readyState === WebSocket.OPEN;
  const n = remotes.size;
  if (!connected) {
    presenceChip.textContent = '[ offline ]';
    presenceChip.classList.add('offline');
    presenceChip.classList.remove('connected');
    hidePlayersPanel();
    return;
  }
  presenceChip.classList.remove('offline');
  presenceChip.classList.add('connected');
  presenceChip.textContent = n === 0 ? '[ solo ]' : `[ ${n} online ]`;
  if (!playersPanel.classList.contains('hidden')) renderPlayersList();
}

// ── Players panel + teleport ───────────────────────────────────────────────
const playersPanel = document.getElementById('players-panel');
const playersList  = document.getElementById('players-list');

function renderPlayersList() {
  playersList.innerHTML = '';
  if (remotes.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'players-empty';
    empty.textContent = '[ no one else here ]';
    playersList.appendChild(empty);
    return;
  }
  for (const [id, r] of remotes.entries()) {
    const btn = document.createElement('button');
    btn.className = 'player-row';
    btn.textContent = `[ ${r.handle.toUpperCase()} ]`;
    btn.addEventListener('click', () => {
      teleportTo(id);
      hidePlayersPanel();
    });
    playersList.appendChild(btn);
  }
}

function showPlayersPanel() {
  renderPlayersList();
  playersPanel.classList.remove('hidden');
}
function hidePlayersPanel() { playersPanel.classList.add('hidden'); }
function togglePlayersPanel() {
  if (playersPanel.classList.contains('hidden')) showPlayersPanel();
  else hidePlayersPanel();
}

presenceChip.addEventListener('click', () => {
  if (!mpSocket || mpSocket.readyState !== WebSocket.OPEN) return;
  togglePlayersPanel();
});

function teleportTo(id) {
  const r = remotes.get(id);
  if (!r) return;
  // Cancel any running camera animations.
  gimbalAnim = null;
  flyAnim = null;
  autoRotateActive = false;
  velocity.set(0, 0, 0);

  // Land a short distance behind the target's facing direction so we see them
  // from over their shoulder rather than face-planting into the sphere.
  const targetPos = r.group.position.clone();
  // Remote's forward = -Z in its local frame, rotated by its yaw.
  const yaw = r.lastPose?.r?.[1] ?? 0;
  const behind = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const dist = Math.max(MP_AVATAR_R * avatarScale * 6, 3.0);
  const dest = targetPos.clone().addScaledVector(behind, dist);
  camera.position.copy(dest);
  camera.lookAt(targetPos);
  // Camera rotation.order is 'YXZ', lookAt sets rotation correctly.
  searchStatus.textContent = `teleported · ${r.handle}`;
}

function updateNameChip() {
  nameToggle.textContent = `[ ${(mpHandle || 'name').toLowerCase()} ]`;
}

function openHandleModal() {
  handleInput.value = mpHandle || '';
  handleModal.classList.remove('hidden');
  setTimeout(() => handleInput.focus(), 0);
}

function closeHandleModal() {
  handleModal.classList.add('hidden');
}

function commitHandle() {
  const v = handleInput.value.trim().slice(0, 16);
  if (!v) return;
  mpHandle = v;
  localStorage.setItem('handle', mpHandle);
  updateNameChip();
  closeHandleModal();
  mpConnect(); // (re)connect + rejoin with new handle
}

handleSubmit.addEventListener('click', commitHandle);
handleInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.code === 'Enter') { e.preventDefault(); commitHandle(); }
});
nameToggle.addEventListener('click', openHandleModal);

updateNameChip();
if (!mpHandle) openHandleModal();

// ── Avatar geometry ────────────────────────────────────────────────────────
function makeLabelTexture(handle) {
  const text  = `[ ${handle.toUpperCase()} ]`;
  const pad   = 16;
  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');
  ctx.font = 'bold 48px "JetBrains Mono", monospace';
  const tw = Math.ceil(ctx.measureText(text).width);
  canvas.width  = tw + pad * 2;
  canvas.height = 64 + pad * 2;
  const c = canvas.getContext('2d');
  c.font = 'bold 48px "JetBrains Mono", monospace';
  c.textBaseline = 'middle';
  c.fillStyle = darkMode ? '#cdd6f4' : '#000';
  c.fillText(text, pad, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 2;
  return { tex, w: canvas.width, h: canvas.height };
}

function createAvatar(handle) {
  const group = new THREE.Group();
  group.userData.isAvatar = true;

  const sphereGeo = new THREE.SphereGeometry(MP_AVATAR_R, 18, 18);
  const sphereMat = new THREE.MeshBasicMaterial({
    color: darkMode ? 0xffffff : 0x000000, transparent: true,
  });
  const sphere = new THREE.Mesh(sphereGeo, sphereMat);
  group.add(sphere);

  // Halo — soft radial sprite, additive blend so it glows against dark bg.
  const haloMat = new THREE.SpriteMaterial({
    map: ensureHaloTex(),
    color: darkMode ? 0xffffff : 0x000000,
    transparent: true,
    depthWrite: false,
    blending: darkMode ? THREE.AdditiveBlending : THREE.NormalBlending,
    opacity: 0.85,
    fog: false,
  });
  const halo = new THREE.Sprite(haloMat);
  const haloS = MP_AVATAR_R * MP_HALO_MULT;
  halo.scale.set(haloS, haloS, 1);
  group.add(halo);

  // Vertical beacon — long thin line through the avatar so it's easy to spot
  // from far away, even when the sphere is sub-pixel.
  const beaconGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, -MP_BEACON_HALF, 0),
    new THREE.Vector3(0,  MP_BEACON_HALF, 0),
  ]);
  const beaconMat = new THREE.LineBasicMaterial({
    color: darkMode ? 0xffffff : 0x000000,
    transparent: true,
    opacity: 0.25,
    depthWrite: false,
  });
  const beacon = new THREE.Line(beaconGeo, beaconMat);
  group.add(beacon);

  const lineGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -MP_FWD_LEN),
  ]);
  const lineMat = new THREE.LineBasicMaterial({
    color: darkMode ? 0xffffff : 0x000000, transparent: true,
  });
  const fwdLine = new THREE.Line(lineGeo, lineMat);
  group.add(fwdLine);

  const { tex, w, h } = makeLabelTexture(handle);
  const labelMat = new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, depthTest: false,
  });
  const label = new THREE.Sprite(labelMat);
  label.renderOrder = 999;
  label.scale.set(MP_LABEL_W, MP_LABEL_W * (h / w), 1);
  label.position.set(0, MP_LABEL_H, 0);
  group.add(label);

  group.scale.setScalar(avatarScale);
  scene.add(group);

  const miniDot = new THREE.Mesh(
    new THREE.SphereGeometry(0.022, 10, 10),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  globalGroup.add(miniDot);

  return { group, sphere, halo, haloMat, beacon, beaconMat, fwdLine, label, labelMat, miniDot };
}

function disposeAvatar(r) {
  scene.remove(r.group);
  r.sphere.geometry.dispose();
  r.sphere.material.dispose();
  r.halo.geometry?.dispose?.();
  r.haloMat.dispose();
  r.beacon.geometry.dispose();
  r.beaconMat.dispose();
  r.fwdLine.geometry.dispose();
  r.fwdLine.material.dispose();
  if (r.labelMat.map) r.labelMat.map.dispose();
  r.labelMat.dispose();
  globalGroup.remove(r.miniDot);
  r.miniDot.geometry.dispose();
  r.miniDot.material.dispose();
}

function updateAvatarLabel(r, handle) {
  if (r.labelMat.map) r.labelMat.map.dispose();
  const { tex, w, h } = makeLabelTexture(handle);
  r.labelMat.map = tex;
  r.labelMat.needsUpdate = true;
  r.label.scale.set(MP_LABEL_W, MP_LABEL_W * (h / w), 1);
}

// ── Pose application + interpolation ───────────────────────────────────────
function ingestPose(id, pose) {
  const r = remotes.get(id);
  if (!r) return;
  r.prevPose = r.lastPose || pose;
  r.lastPose = pose;
  r.lastPoseT = performance.now();
  if (!r.initialized) {
    // Snap on first pose so avatar doesn't sweep in from origin.
    r.group.position.set(pose.p[0], pose.p[1], pose.p[2]);
    r.group.rotation.order = 'YXZ';
    r.group.rotation.set(pose.r[0], pose.r[1], 0);
    r.initialized = true;
  }
}

function addRemote(id, handle, pose) {
  if (remotes.has(id)) return;
  const av = createAvatar(handle || 'anon');
  remotes.set(id, { handle: handle || 'anon', ...av });
  if (pose && pose.p && pose.r) ingestPose(id, pose);
  updatePresenceChip();
}

function removeRemote(id) {
  const r = remotes.get(id);
  if (!r) return;
  disposeAvatar(r);
  remotes.delete(id);
  updatePresenceChip();
}

function updateRemotes(dt) {
  const now = performance.now();
  for (const r of remotes.values()) {
    if (r.searchAnim) stepSearchAnim(r, now);
    else if (r.lastPose) {
      // One-frame-buffered lerp (alpha = elapsed / interval).
      const alpha = Math.min(1, (now - r.lastPoseT) / MP_POSE_INTERVAL);
      const { p, r: rot } = r.lastPose;
      r.group.position.lerp(new THREE.Vector3(p[0], p[1], p[2]), alpha);
      // Shortest-path angle lerp on yaw; pitch clamped.
      r.group.rotation.order = 'YXZ';
      r.group.rotation.y = lerpAngle(r.group.rotation.y, rot[1], alpha);
      r.group.rotation.x = r.group.rotation.x + (rot[0] - r.group.rotation.x) * alpha;
    }
    // Fog fade — mirror point cloud's smoothstep over the same near/far.
    const dist = camera.position.distanceTo(r.group.position);
    const md = baseMaxDist * worldScale;
    const near = md * 0.4, far = md * 2.5;
    const t = Math.max(0, Math.min(1, (dist - near) / Math.max(1e-6, far - near)));
    // Keep remotes readable even in heavy fog — floor ~0.4.
    const opacity = Math.max(0.4, 1 - fogStrength * t);
    r.sphere.material.opacity = opacity;
    r.fwdLine.material.opacity = opacity;
    r.haloMat.opacity    = 0.85 * opacity;
    r.beaconMat.opacity  = 0.30 * opacity;
    r.labelMat.opacity   = Math.max(opacity, 0.9);
    // Minimap dot follows the avatar's world position.
    r.miniDot.position.copy(localToGlobal(r.group.position));
  }
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d >  Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// ── Search replay on remote avatars ────────────────────────────────────────
function startRemoteSearchAnim(r, target, offset, startT) {
  const fromPos = r.group.position.clone();
  const dir = new THREE.Vector3().subVectors(fromPos, target).normalize();
  if (!isFinite(dir.x) || dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
  const toPos = new THREE.Vector3().copy(target).add(dir.multiplyScalar(Math.max(offset, 0.001)));

  // Compute target yaw/pitch (face the centroid).
  const tmp = new THREE.Object3D();
  tmp.rotation.order = 'YXZ';
  tmp.position.copy(fromPos);
  tmp.lookAt(target);
  const startYaw = r.group.rotation.y, startPitch = r.group.rotation.x;
  let targetYaw = tmp.rotation.y;
  while (targetYaw - startYaw >  Math.PI) targetYaw -= Math.PI * 2;
  while (targetYaw - startYaw < -Math.PI) targetYaw += Math.PI * 2;
  const targetPitch = Math.max(-Math.PI/2, Math.min(Math.PI/2, tmp.rotation.x));

  r.searchAnim = {
    fromPos, toPos,
    startYaw, startPitch, targetYaw, targetPitch,
    startT: startT || Date.now(),
    gimbalMs: PHASE.GIMBAL_MS,
    // illuminate phase: avatar holds position/rotation (no replication of glow)
    illumMs:  PHASE.ILLUMINATE_MS,
    travelMs: PHASE.TRAVEL_MS,
  };
}

function stepSearchAnim(r, now) {
  const a = r.searchAnim;
  // startT is epoch ms from the remote; convert to a local clock delta via
  // Date.now() on this machine. Assumes loose clock alignment (hackathon scale).
  const elapsed = Date.now() - a.startT;
  const gEnd = a.gimbalMs;
  const iEnd = gEnd + a.illumMs;
  const tEnd = iEnd + a.travelMs;

  if (elapsed < gEnd) {
    const t = elapsed / a.gimbalMs;
    const e = easeInOut(t);
    r.group.rotation.order = 'YXZ';
    r.group.rotation.y = a.startYaw   + (a.targetYaw   - a.startYaw)   * e;
    r.group.rotation.x = a.startPitch + (a.targetPitch - a.startPitch) * e;
  } else if (elapsed < iEnd) {
    r.group.rotation.y = a.targetYaw;
    r.group.rotation.x = a.targetPitch;
  } else if (elapsed < tEnd) {
    const t = (elapsed - iEnd) / a.travelMs;
    r.group.position.lerpVectors(a.fromPos, a.toPos, easeInOut(t));
  } else {
    r.group.position.copy(a.toPos);
    r.searchAnim = null;
    // Seed lastPose so the normal interp path doesn't rubber-band backwards.
    r.lastPose = { p: [a.toPos.x, a.toPos.y, a.toPos.z], r: [a.targetPitch, a.targetYaw] };
    r.prevPose = r.lastPose;
    r.lastPoseT = performance.now();
  }
}

// ── WebSocket ──────────────────────────────────────────────────────────────
function mpSend(msg) {
  if (!mpSocket || mpSocket.readyState !== WebSocket.OPEN) return;
  mpSocket.send(JSON.stringify(msg));
  mpLastTrafficT = performance.now();
}

function sendPose() {
  if (!mpSocket || mpSocket.readyState !== WebSocket.OPEN) return;
  const now = performance.now();
  if (now - mpLastPoseSent < MP_POSE_INTERVAL) return;
  const p = camera.position;
  const rx = camera.rotation.x, ry = camera.rotation.y;
  const moved =
    Math.abs(p.x - mpLastPoseP.x) > 1e-4 ||
    Math.abs(p.y - mpLastPoseP.y) > 1e-4 ||
    Math.abs(p.z - mpLastPoseP.z) > 1e-4 ||
    Math.abs(rx - mpLastPoseRx) > 1e-3 ||
    Math.abs(ry - mpLastPoseRy) > 1e-3;
  if (!moved) {
    // Idle ping if we haven't talked in a while.
    if (now - mpLastTrafficT > MP_PING_MS) mpSend({ type: 'ping' });
    return;
  }
  mpLastPoseSent = now;
  mpLastPoseP.copy(p);
  mpLastPoseRx = rx; mpLastPoseRy = ry;
  mpSend({ type: 'pose', p: [p.x, p.y, p.z], r: [rx, ry], t: Date.now() });
}

function sendSearch(target, offset) {
  mpSend({
    type: 'search',
    target: [target.x, target.y, target.z],
    offset,
    startT: Date.now(),
  });
}

function mpConnect() {
  if (!mpHandle) return;
  if (mpSocket && (mpSocket.readyState === WebSocket.OPEN || mpSocket.readyState === WebSocket.CONNECTING)) {
    // Already connected: just resend join to update handle.
    const p = camera.position;
    mpSend({
      type: 'join',
      handle: mpHandle,
      pose: { p: [p.x, p.y, p.z], r: [camera.rotation.x, camera.rotation.y] },
    });
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws`;
  const ws = new WebSocket(url);
  mpSocket = ws;

  ws.addEventListener('open', () => {
    const p = camera.position;
    mpSend({
      type: 'join',
      handle: mpHandle,
      pose: { p: [p.x, p.y, p.z], r: [camera.rotation.x, camera.rotation.y] },
    });
    console.log('[mp] ws open', url);
    updatePresenceChip();
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case 'hello':
        mpUserId = msg.id;
        for (const u of msg.users || []) addRemote(u.id, u.handle, u.pose);
        break;
      case 'join':
        if (remotes.has(msg.id)) {
          const r = remotes.get(msg.id);
          r.handle = msg.handle;
          updateAvatarLabel(r, msg.handle);
          if (msg.pose) ingestPose(msg.id, msg.pose);
        } else {
          addRemote(msg.id, msg.handle, msg.pose);
        }
        break;
      case 'pose':
        if (!remotes.has(msg.id)) addRemote(msg.id, 'anon', { p: msg.p, r: msg.r });
        else ingestPose(msg.id, { p: msg.p, r: msg.r });
        break;
      case 'search':
        if (!remotes.has(msg.id)) break;
        startRemoteSearchAnim(
          remotes.get(msg.id),
          new THREE.Vector3(msg.target[0], msg.target[1], msg.target[2]),
          msg.offset || 0,
          msg.startT,
        );
        break;
      case 'leave':
        removeRemote(msg.id);
        break;
    }
  });

  ws.addEventListener('close', (ev) => {
    console.log('[mp] ws close', ev.code, ev.reason);
    mpSocket = null;
    mpUserId = null;
    for (const id of Array.from(remotes.keys())) removeRemote(id);
    updatePresenceChip();
    setTimeout(mpConnect, 1000);
  });

  ws.addEventListener('error', (ev) => {
    console.warn('[mp] ws error', ev);
    try { ws.close(); } catch {}
  });
}

// Expose for DevTools debugging.
window.__mp = { get socket() { return mpSocket; }, remotes, sendPing: () => mpSend({ type: 'ping' }) };

if (mpHandle) mpConnect();

// ─────────────────────────────────────────────────────────────────────────────
// Animation loop
// ─────────────────────────────────────────────────────────────────────────────

let lastTime = performance.now();

function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  updateMovement(dt);
  sendPose();
  updateAutoRotate(dt);
  updateGimbal(now);
  updateIlluminate(now);
  updateFly(now);
  updateExpand(now);
  updateDestCloud();
  updateCrosshair();
  updateRemotes(dt);
  updateGlobalScene();

  renderer.render(scene, camera);
  globalRenderer.render(globalScene, globalCamera);
}
requestAnimationFrame(animate);

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap — poll until layout is ready, then build scene
// ─────────────────────────────────────────────────────────────────────────────

async function pollAndLoad() {
  // Kick off a fresh UMAP fit so the browser always sees coords that reflect
  // the latest embeddings — including anything the pipeline has just finished
  // processing. Single-flight server-side, so multiple tabs coalesce.
  try {
    await fetch(API_BASE + '/visualization/recompute', { method: 'POST' });
    overlayMsg.textContent = 'recomputing 3D layout…';
  } catch {
    // Backend unreachable — fall through to the polling loop, which will
    // catch the same error and use the demo cloud fallback.
  }

  while (true) {
    try {
      const s = await fetch(API_BASE + '/visualization/status').then(r => r.json());
      if (s.computing) {
        overlayMsg.textContent = 'recomputing 3D layout…';
      } else if (s.index_count === 0) {
        overlayMsg.textContent = 'index is empty — process samples first';
        return;
      } else if (s.ready) {
        overlayMsg.textContent = 'building scene…';
        const data = await fetch(API_BASE + '/visualization/layout').then(r => r.json());
        if (data.points && data.points.length > 0) {
          buildLocalScene(data);
          return;
        }
        overlayMsg.textContent = 'preparing layout…';
      } else {
        overlayMsg.textContent = 'preparing layout…';
      }
    } catch {
      overlayMsg.textContent = 'backend unreachable — loading demo cloud';
      usingDemoData = true;
      buildLocalScene(generateDemoData());
      return;
    }
    await new Promise(r => setTimeout(r, 1500));
  }
}

// Demo "search" — picks a cluster pseudo-deterministically from the query
// string so the same query keeps flying to the same place. Deterministic
// hashing → stable cluster choice; jitter inside the cluster picks the
// k highlighted points.
function pickDemoMatches(query, k) {
  if (!points.length) return [];
  // Hash the query to choose a cluster
  let h = 0;
  for (let i = 0; i < query.length; i++) h = (h * 31 + query.charCodeAt(i)) | 0;
  const clusters = new Map();
  for (let i = 0; i < points.length; i++) {
    const c = points[i].cluster;
    if (!clusters.has(c)) clusters.set(c, []);
    clusters.get(c).push(i);
  }
  const clusterIds = [...clusters.keys()];
  const chosen = clusterIds[Math.abs(h) % clusterIds.length];
  const pool = clusters.get(chosen);
  // Take k random points from that cluster
  const shuffled = pool.slice().sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(k, pool.length)).map(i => points[i].path);
}

// Demo cloud so the UI works standalone before the API is wired up
function generateDemoData() {
  const pts = [];
  const N_CLUSTERS = 6;
  const PER_CLUSTER = 250;
  for (let c = 0; c < N_CLUSTERS; c++) {
    const cx = (Math.random() - 0.5) * 6;
    const cy = (Math.random() - 0.5) * 6;
    const cz = (Math.random() - 0.5) * 6;
    for (let i = 0; i < PER_CLUSTER; i++) {
      pts.push({
        path: `demo/c${c}_${i}.wav`,
        filename: `c${c}_${i}.wav`,
        x: cx + (Math.random() - 0.5) * 1.2,
        y: cy + (Math.random() - 0.5) * 1.2,
        z: cz + (Math.random() - 0.5) * 1.2,
        cluster: c,
      });
    }
  }
  return { points: pts, clusters: N_CLUSTERS };
}

pollAndLoad();
