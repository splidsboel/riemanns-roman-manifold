let scene, camera, renderer;
let points = [];
let pointsMesh;
let selectedPoint = null;

const canvas = document.getElementById("canvas");
const infoPanelBtn = document.getElementById("info-panel");
const infoVessel = document.getElementById("info-vessel");
const infoText = document.getElementById("info-text");
const pointCount = document.getElementById("point-count");

async function init() {
  // Scene setup
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0e27);

  camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    10000
  );
  camera.position.z = 100;

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);

  // Load chunks
  await loadChunks();

  // Lighting
  const light = new THREE.PointLight(0xffffff, 0.8);
  light.position.set(100, 100, 100);
  scene.add(light);

  scene.add(new THREE.AmbientLight(0xffffff, 0.4));

  // Mouse controls
  setupControls();

  // Render loop
  animate();

  // Handle window resize
  window.addEventListener("resize", onWindowResize);
}

async function loadChunks() {
  try {
    const response = await fetch("/api/chunks");
    const chunks = await response.json();

    const geometry = new THREE.BufferGeometry();
    const positions = [];
    const colors = [];

    points = chunks;
    pointCount.textContent = chunks.length;

    // Normalize coordinates for visualization
    chunks.forEach((chunk) => {
      positions.push(
        chunk.coordinates[0] * 30,
        chunk.coordinates[1] * 30,
        chunk.coordinates[2] * 30
      );

      // Color based on vessel
      const hue = hashCode(chunk.vessel_name) % 360;
      const color = new THREE.Color();
      color.setHSL(hue / 360, 0.6, 0.5);
      colors.push(color.r, color.g, color.b);
    });

    geometry.setAttribute("position", new THREE.BufferAttribute(
      new Float32Array(positions),
      3
    ));
    geometry.setAttribute("color", new THREE.BufferAttribute(
      new Float32Array(colors),
      3
    ));

    const material = new THREE.PointsMaterial({
      size: 2,
      vertexColors: true,
      transparent: true,
      opacity: 0.8,
    });

    pointsMesh = new THREE.Points(geometry, material);
    scene.add(pointsMesh);

    // Center camera on data
    const center = geometry.boundingSphere.center;
    camera.lookAt(center);
  } catch (error) {
    console.error("Failed to load chunks:", error);
  }
}

function setupControls() {
  let isDragging = false;
  let previousMousePosition = { x: 0, y: 0 };

  canvas.addEventListener("mousedown", (e) => {
    isDragging = true;
    previousMousePosition = { x: e.clientX, y: e.clientY };
  });

  canvas.addEventListener("mousemove", (e) => {
    if (isDragging) {
      const deltaX = e.clientX - previousMousePosition.x;
      const deltaY = e.clientY - previousMousePosition.y;

      pointsMesh.rotation.y += deltaX * 0.01;
      pointsMesh.rotation.x += deltaY * 0.01;

      previousMousePosition = { x: e.clientX, y: e.clientY };
    }
  });

  canvas.addEventListener("mouseup", () => {
    isDragging = false;
  });

  canvas.addEventListener("mouseleave", () => {
    isDragging = false;
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    camera.position.z += e.deltaY * 0.1;
  });

  // Click to select
  canvas.addEventListener("click", (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(x, y), camera);

    const intersects = raycaster.intersectObject(pointsMesh);
    if (intersects.length > 0) {
      const index = intersects[0].index;
      if (index !== undefined && points[index]) {
        selectPoint(points[index]);
      }
    }
  });
}

function selectPoint(chunk) {
  selectedPoint = chunk;
  infoVessel.textContent = `Vessel: ${chunk.vessel_name}`;
  infoText.textContent = chunk.text;
  infoPanelBtn.classList.add("visible");
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function animate() {
  requestAnimationFrame(animate);

  // Gentle auto-rotation if not dragging
  if (pointsMesh) {
    pointsMesh.rotation.y += 0.0002;
  }

  renderer.render(scene, camera);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// Start
init();
