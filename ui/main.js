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

let darkMode = false;
function theme() { return darkMode ? COLORS_DARK : COLORS; }

// Cluster palette via golden-ratio HSL (matches samplevec)
function clusterColor(c) {
  if (c < 0) return new THREE.Color(0.55, 0.55, 0.60);
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
void main() {
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPos;
  float dist = -mvPos.z;
  float sizeMul = 1.0 + aIllum * 0.6;
  gl_PointSize = uSize * sizeMul * (uScale / max(dist, 0.001));
  vIllum = aIllum;
  vColor = aColor;
}`;

const STAR_FRAG = `
uniform float uDark;
uniform vec3  uMono;
varying float vIllum;
varying vec3  vColor;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float r = length(uv);
  if (r > 0.5) discard;
  float core = 1.0 - smoothstep(0.40, 0.50, r);
  float ring = 0.0;
  if (vIllum > 0.0) {
    float ringR = mix(0.42, 0.49, vIllum);
    ring = (1.0 - smoothstep(0.005, 0.025, abs(r - ringR))) * vIllum;
  }
  float alpha = max(core, ring);
  if (alpha < 0.01) discard;
  // Light mode: monochrome black discs.
  // Dark mode: per-cluster colors (ring pulse lightens toward white on illuminate).
  vec3 col = mix(uMono, vColor, uDark);
  col = mix(col, vec3(1.0), ring * uDark);
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
let densityMult = 0.3;
let ptsMult     = PT_SIZE_DEFAULT;
let spdMult     = 7.0;
let baseMoveSpd = 1;
let basePtSize  = 0.1;

// Controls
let pointerLocked = false;
const keys = {};
let moveSpeed = 1.0;
let glideMult = 0.0;                        // 0 = instant stop; 1 = very slippery
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
    const c = clusterColor(points[i].cluster);
    colorAttr[i*3] = c.r; colorAttr[i*3+1] = c.g; colorAttr[i*3+2] = c.b;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('aIllum',   new THREE.BufferAttribute(illumAttr, 1));
  geo.setAttribute('aColor',   new THREE.BufferAttribute(colorAttr, 3));

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSize:  { value: basePtSize * ptsMult },
      uScale: { value: 1.0 },
      uDark:  { value: darkMode ? 1.0 : 0.0 },
      uMono:  { value: new THREE.Color(0x000000) },
    },
    vertexShader:   STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent:    true,
    depthWrite:     false,
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

  // Any previous arrival-state is cancelled
  autoRotateActive = false;
  setPointSize(PT_SIZE_DEFAULT);

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
  await runExpand(PT_SIZE_ARRIVED);

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
    pointCloud.material.uniforms.uDark.value = darkMode ? 1.0 : 0.0;
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
}

themeToggle.addEventListener('click', () => {
  darkMode = !darkMode;
  applyTheme();
});
applyTheme();

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

// ─────────────────────────────────────────────────────────────────────────────
// Animation loop
// ─────────────────────────────────────────────────────────────────────────────

let lastTime = performance.now();

function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  updateMovement(dt);
  updateAutoRotate(dt);
  updateGimbal(now);
  updateIlluminate(now);
  updateFly(now);
  updateExpand(now);
  updateDestCloud();
  updateCrosshair();
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
