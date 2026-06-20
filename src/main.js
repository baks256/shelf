import "./style.css";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import YAML from "yaml";

const MM_TO_M = 0.001;
const DEFAULT_BOARD_THICKNESS = 18 * MM_TO_M;
const DOOR_GAP = 0.012;

const canvas = document.querySelector("#wardrobeCanvas");
const editor = document.querySelector("#configEditor");
const statusEl = document.querySelector("#configStatus");
const fileInput = document.querySelector("#configFile");
const downloadButton = document.querySelector("#downloadConfig");
const toggleEditorButton = document.querySelector("#toggleEditor");
const productTabsEl = document.querySelector("#productTabs");
const detailTitleEl = document.querySelector("#detailTitle");
const detailDrawingEl = document.querySelector("#detailDrawing");
const detailSpecsEl = document.querySelector("#detailSpecs");
const detailDescriptionEl = document.querySelector("#detailDescription");
const appShell = document.querySelector(".app-shell");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf7f7f2);
scene.fog = new THREE.Fog(0xf7f7f2, 6.8, 12);

const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.screenSpacePanning = true;
controls.minDistance = 2.0;
controls.maxDistance = 8.5;
controls.mouseButtons = {
  LEFT: THREE.MOUSE.PAN,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.ROTATE,
};
controls.touches = {
  ONE: THREE.TOUCH.PAN,
  TWO: THREE.TOUCH.DOLLY_ROTATE,
};

const root = new THREE.Group();
scene.add(root);

const clock = new THREE.Clock();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let currentConfigText = "";
let currentConfig = null;
let activeProductId = "";
let debounceTimer = 0;
let rendererWidth = 0;
let rendererHeight = 0;
let clickableDoors = [];
let doorSections = [];
let hoverableDetails = [];
let hoverableShelves = [];
let hoverableSections = [];
let shelfHeightMarks = new Map();
let rightHeightMarks = new Map();
let rightRangeMarks = [];
let topDimensionMarks = new Map();
let highlightedMarks = [];
let guideLines = null;
let guideBounds = null;
let activeDetailKey = "";
let selectedObjectKey = "";
let highlightedDetailEdges = null;
const openDoorIds = new Set();
let pointerDown = null;
let renderFrameId = 0;

const materialLibrary = {
  darkWalnut: makeSketchMaterial(0xf2f2ed, 0x151515, 0.08),
  smokedOak: makeSketchMaterial(0xe9e9e3, 0x151515, 0.05),
  warmLed: new THREE.MeshBasicMaterial({ color: 0xffc27a }),
  metalMeshBlack: new THREE.MeshStandardMaterial({
    color: 0x050505,
    roughness: 0.62,
    metalness: 0.18,
  }),
  brushedSteel: new THREE.MeshStandardMaterial({
    color: 0x202020,
    roughness: 0.38,
    metalness: 0.42,
  }),
  blackMetal: new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.7, metalness: 0.22 }),
  paper: makeSketchMaterial(0xffffff, 0x111111, 0.035),
  charcoal: new THREE.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.82 }),
  ceramic: makeSketchMaterial(0xf0f0ea, 0x111111, 0.04),
};

setupScene();
loadDefaultConfig();
scheduleRender();

window.addEventListener("resize", scheduleRender);
canvas.addEventListener("pointerdown", onCanvasPointerDown);
canvas.addEventListener("pointerup", onCanvasPointerUp);
canvas.addEventListener("pointermove", onCanvasPointerMove);
canvas.addEventListener("pointerleave", () => {
  highlightShelfMark(null);
  highlightDetail(null);
});
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
controls.addEventListener("change", scheduleRender);
toggleEditorButton.addEventListener("click", () => {
  appShell.classList.toggle("editor-open");
  scheduleRender();
});
downloadButton.addEventListener("click", downloadConfig);
fileInput.addEventListener("change", loadConfigFile);
editor.addEventListener("input", () => {
  currentConfigText = editor.value;
  statusEl.textContent = "Проверяю...";
  statusEl.classList.remove("error");
  clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => applyConfigText(editor.value), 350);
});

async function loadDefaultConfig() {
  const response = await fetch("/wardrobe.yaml");
  const text = await response.text();
  currentConfigText = text;
  editor.value = text;
  applyConfigText(text);
}

function applyConfigText(text) {
  try {
    const config = YAML.parse(text);
    validateConfig(config);
    currentConfig = config;
    activeProductId = getInitialActiveProductId(config);
    renderActiveProduct();
    renderProductTabs(config);
    statusEl.textContent = "Конфиг применен";
    statusEl.classList.remove("error");
  } catch (error) {
    statusEl.textContent = error.message;
    statusEl.classList.add("error");
  }
}

function getInitialActiveProductId(config) {
  const products = getProducts(config);
  const urlTab = new URLSearchParams(window.location.search).get("tab");
  if (urlTab && products.some((product) => product.id === urlTab)) return urlTab;
  if (activeProductId && products.some((product) => product.id === activeProductId)) return activeProductId;
  return config.activeProduct ?? products[0]?.id ?? "";
}

function validateConfig(config) {
  if (!config || typeof config !== "object") throw new Error("YAML должен описывать объект.");
  if (!config.dimensions) throw new Error("Не найден блок dimensions.");
  if (!Array.isArray(config.columns) || config.columns.length === 0) throw new Error("Нужен список columns.");
  if (!Array.isArray(config.rows) || config.rows.length === 0) throw new Error("Нужен список rows.");

  const width = sum(config.columns, "width");
  const height = sum(config.rows, "height");
  if (Math.abs(width - config.dimensions.width) > 1) {
    throw new Error(`Сумма columns (${width}) должна совпадать с dimensions.width.`);
  }
  if (Math.abs(height - config.dimensions.height) > 1) {
    throw new Error(`Сумма rows (${height}) должна совпадать с dimensions.height.`);
  }

  for (const [key, value] of Object.entries(config.boardThickness ?? {})) {
    if (typeof value !== "number" || value <= 0) {
      throw new Error(`boardThickness.${key} должен быть положительным числом.`);
    }
  }

  for (const item of [
    ...(config.verticalDividers ?? []),
    ...(config.internal ?? []),
    ...(config.doors ?? []),
  ]) {
    if (item.thickness !== undefined && (typeof item.thickness !== "number" || item.thickness <= 0)) {
      throw new Error(`${item.id ?? "element"}.thickness должен быть положительным числом.`);
    }
  }
}

function renderWardrobe(config) {
  root.clear();
  clickableDoors = [];
  doorSections = [];
  hoverableDetails = [];
  hoverableShelves = [];
  hoverableSections = [];
  shelfHeightMarks = new Map();
  rightHeightMarks = new Map();
  rightRangeMarks = [];
  topDimensionMarks = new Map();
  highlightedMarks = [];
  selectedObjectKey = "";
  if (guideLines) root.remove(guideLines);
  guideLines = null;
  guideBounds = null;

  const width = config.dimensions.width * MM_TO_M;
  const height = config.dimensions.height * MM_TO_M;
  const depth = config.dimensions.depth * MM_TO_M;
  const floorOffset = (config.position?.floorOffset ?? 0) * MM_TO_M;
  const columnEdges = edges(config.columns.map((column) => column.width * MM_TO_M));
  const rowEdges = edges(config.rows.map((row) => row.height * MM_TO_M)).map((value) => value + floorOffset);
  const left = -width / 2;
  const bottom = floorOffset;
  const backZ = -depth / 2;
  const sideT = boardThickness(config, "sides");
  const topT = boardThickness(config, "top");
  const bottomT = boardThickness(config, "bottom");
  const backT = boardThickness(config, "back");
  const carcass = material(config.materials?.carcass, "darkWalnut");
  const back = material(config.materials?.back, "smokedOak");
  const doorMaterial = material(config.materials?.door, "darkWalnut");

  addDecorativeElements(config, width, depth);

  addTopPanel(config, columnEdges, left, width, topT, depth, bottom + height - topT / 2, carcass);
  registerHoverDetail(addPanel(width, bottomT, depth, [0, bottom + bottomT / 2, 0], carcass, "bottom"), "Дно", width, bottomT, depth, "Нижняя горизонтальная деталь корпуса.");
  registerHoverDetail(addPanel(sideT, height, depth, [left + sideT / 2, bottom + height / 2, 0], carcass, "left-side"), "Левая боковина", sideT, height, depth, "Левая вертикальная боковая деталь корпуса.");
  registerHoverDetail(addPanel(sideT, height, depth, [-left - sideT / 2, bottom + height / 2, 0], carcass, "right-side"), "Правая боковина", sideT, height, depth, "Правая вертикальная боковая деталь корпуса.");
  registerHoverDetail(addPanel(width, height, backT, [0, bottom + height / 2, backZ + backT / 2], back, "back"), "Задник", width, height, backT, "Задняя панель корпуса.");

  addVerticalDividers(config, columnEdges, rowEdges, left, bottom + height, depth, carcass);

  addConfiguredRowShelves(config, columnEdges, rowEdges, left, depth, carcass);

  addOpenCellDetails(config, columnEdges, rowEdges, left, depth);
  addInternalElements(config, columnEdges, rowEdges, left, depth, carcass);
  addBaskets(config, columnEdges, left, depth, bottom);

  for (const door of config.doors ?? []) {
    addDoor(config, door, columnEdges, rowEdges, left, depth, doorMaterial);
  }

  addSectionHoverZones(config, columnEdges, rowEdges, left, depth);
  addRoomContext(config, width, bottom + height, depth, columnEdges, rowEdges, left);
  frameCamera(config);
  updateDetailPanel(makeDetail(config.name ?? "Изделие", { x0: left, x1: left + width, y0: bottom, y1: bottom + height }, depth, "Общий габарит активного изделия."));
}

function renderActiveProduct() {
  if (!currentConfig) return;
  renderWardrobe(getActiveProductConfig(currentConfig));
}

function getActiveProductConfig(config) {
  const product = getProducts(config).find((item) => item.id === activeProductId);
  if (!product?.config) return config;
  return {
    ...config,
    ...product.config,
    materials: {
      ...(config.materials ?? {}),
      ...(product.config.materials ?? {}),
    },
    boardThickness: {
      ...(typeof config.boardThickness === "object" ? config.boardThickness : { default: config.boardThickness }),
      ...(typeof product.config.boardThickness === "object" ? product.config.boardThickness : {}),
    },
  };
}

function addDoor(config, door, columnEdges, rowEdges, left, depth, doorMaterial) {
  const colSpan = door.colSpan ?? 1;
  const rowSpan = door.rowSpan ?? 1;
  const doorT = boardThickness(config, "doors", door);
  const x0 = left + columnEdges[door.col];
  const x1 = left + columnEdges[door.col + colSpan];
  const y0 = rowEdges[door.row];
  const y1 = rowEdges[door.row + rowSpan];
  const section = { x0, x1, y0, y1 };
  const w = x1 - x0 - DOOR_GAP;
  const h = y1 - y0 - DOOR_GAP;
  const hingeSide = getHingeSide(door, x0, x1);
  const hingeX = hingeSide === "left" ? x0 + DOOR_GAP / 2 : x1 - DOOR_GAP / 2;
  const frontZ = depth / 2 - doorT / 2;
  const doorGroup = new THREE.Group();
  doorGroup.name = `${door.id}-pivot`;
  doorGroup.position.set(hingeX, y0 + DOOR_GAP / 2, frontZ);
  doorGroup.userData.door = {
    id: door.id,
    closed: 0,
    open: hingeSide === "left" ? -Math.PI * 0.58 : Math.PI * 0.58,
    target: openDoorIds.has(door.id) ? 1 : 0,
    progress: openDoorIds.has(door.id) ? 1 : 0,
  };
  doorGroup.userData.section = section;
  doorGroup.rotation.y = THREE.MathUtils.lerp(doorGroup.userData.door.closed, doorGroup.userData.door.open, doorGroup.userData.door.progress);
  root.add(doorGroup);
  doorSections.push({ id: door.id, section, group: doorGroup });

  const localX = hingeSide === "left" ? w / 2 : -w / 2;
  const doorMesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, doorT), doorMaterial);
  doorMesh.position.set(localX, h / 2, 0);
  doorMesh.name = door.id;
  doorMesh.castShadow = true;
  doorMesh.receiveShadow = true;
  doorMesh.userData.clickDoor = doorGroup;
  doorMesh.userData.section = section;
  doorMesh.userData.objectKey = `door:${door.id}`;
  doorMesh.userData.detail = makeDetail("Дверца", section, depth, `Фасад ${door.id}: ${Math.round((x1 - x0) / MM_TO_M)} x ${Math.round((y1 - y0) / MM_TO_M)}.`);
  addSketchEdges(doorMesh, 0x0b0b0b, 0.78);
  doorGroup.add(doorMesh);
  clickableDoors.push(doorMesh);

  addHandle(doorGroup, door, hingeSide, w, h, doorT);
}

function addTopPanel(config, columnEdges, left, width, thickness, depth, y, carcass) {
  const cutouts = Array.isArray(config.topCutouts) ? config.topCutouts : [];
  if (cutouts.length === 0) {
    registerHoverDetail(addPanel(width, thickness, depth, [0, y, 0], carcass, "top"), "Крышка", width, thickness, depth, "Верхняя горизонтальная деталь корпуса.");
    return;
  }

  const cutout = cutouts[0];
  const decorDepth = getBackDecorationThickness(config);
  const cutDepth = Math.min(depth - 0.02, Math.max(0, resolveTopCutoutDepth(config, cutout)));
  if (cutDepth <= 0) {
    registerHoverDetail(addPanel(width, thickness, depth, [0, y, 0], carcass, "top"), "Крышка", width, thickness, depth, "Верхняя горизонтальная деталь корпуса.");
    return;
  }

  const x0 = left + columnEdges[cutout.col ?? 0];
  const x1 = left + columnEdges[(cutout.col ?? 0) + (cutout.colSpan ?? 1)];
  const right = left + width;
  const backZ = -depth / 2;
  const frontZ = depth / 2;
  const cutFrontZ = backZ + cutDepth;

  const shape = new THREE.Shape();
  shape.moveTo(left, backZ);
  shape.lineTo(x0, backZ);
  shape.lineTo(x0, cutFrontZ);
  shape.lineTo(x1, cutFrontZ);
  shape.lineTo(x1, backZ);
  shape.lineTo(right, backZ);
  shape.lineTo(right, frontZ);
  shape.lineTo(left, frontZ);
  shape.lineTo(left, backZ);

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
  });
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, y + thickness / 2, 0);

  const mesh = new THREE.Mesh(geometry, carcass);
  mesh.name = "top-with-cutout";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  addSketchEdges(mesh, 0x0b0b0b, 0.72);
  root.add(mesh);
  const notchWidth = x1 - x0;
  const visibleCutDepth = Math.max(0, cutDepth - decorDepth);
  registerHoverDetail(
    mesh,
    "Крышка с вырезом",
    width,
    thickness,
    depth,
    `Верхняя литая деталь корпуса. Вырез у стены в секциях ${cutout.col + 1}-${cutout.col + (cutout.colSpan ?? 1)}: чистый зазор ${Math.round(visibleCutDepth / MM_TO_M)}, фактический вырез ${Math.round(cutDepth / MM_TO_M)}.`,
    { notchWidth: Math.round(notchWidth / MM_TO_M), notchDepth: Math.round(cutDepth / MM_TO_M), clearanceDepth: Math.round(visibleCutDepth / MM_TO_M) },
  );
  addTopCutoutOutline(x0, x1, backZ + decorDepth, cutFrontZ, y + thickness / 2);
}

function resolveTopCutoutDepth(config, cutout) {
  if (typeof cutout.depth === "number") return cutout.depth * MM_TO_M;

  const clearance = (cutout.clearanceDepth ?? 0) * MM_TO_M;
  const decorThickness = getBackDecorationThickness(config);
  return decorThickness + clearance;
}

function getBackDecorationThickness(config) {
  const elements = Array.isArray(config.decorativeElements) ? config.decorativeElements : [];
  return elements.reduce((total, item) => {
    if (item.type !== "wallPanel") return total;
    return total + (item.thickness ?? 0) * MM_TO_M;
  }, 0);
}

function addTopCutoutOutline(x0, x1, z0, z1, y) {
  if (z1 <= z0 + 0.001) return;
  const points = [
    new THREE.Vector3(x0, y + 0.003, z0),
    new THREE.Vector3(x1, y + 0.003, z0),
    new THREE.Vector3(x1, y + 0.003, z0),
    new THREE.Vector3(x1, y + 0.003, z1),
    new THREE.Vector3(x1, y + 0.003, z1),
    new THREE.Vector3(x0, y + 0.003, z1),
    new THREE.Vector3(x0, y + 0.003, z1),
    new THREE.Vector3(x0, y + 0.003, z0),
  ];
  const line = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    }),
  );
  line.name = "top-cutout-visible-edge";
  root.add(line);
}

function getHingeSide(door) {
  if (door.swing === "left") return "left";
  if (door.swing === "right") return "right";
  if (door.handle === "left") return "right";
  return "left";
}

function addHandle(doorGroup, door, hingeSide, width, height, doorT) {
  const handle = door.handle ?? "right";
  if (handle === "none" || handle === false) return;

  const length = Math.min(0.36, Math.max(0.16, height * 0.28));
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.025, length, 0.018), materialLibrary.blackMetal);
  const inset = 0.09;
  const doorX = hingeSide === "left" ? width / 2 : -width / 2;
  const localLeft = doorX - width / 2;
  const localRight = doorX + width / 2;
  const z = doorT * 0.9;
  let x = localRight - inset;
  let y = height / 2;

  if (handle === "left") x = localLeft + inset;
  if (handle === "center") x = hingeSide === "left" ? localRight - inset : localLeft + inset;
  if (handle === "top") {
    y = height - 0.08;
    bar.rotation.z = Math.PI / 2;
  }
  if (handle === "bottom") {
    y = 0.08;
    bar.rotation.z = Math.PI / 2;
  }
  bar.position.set(x, y, z);
  bar.castShadow = true;
  bar.userData.clickDoor = doorGroup;
  bar.userData.section = doorGroup.userData.section;
  addSketchEdges(bar, 0x000000, 0.55);
  doorGroup.add(bar);
  clickableDoors.push(bar);
}

function addOpenCellDetails(config, columnEdges, rowEdges, left, depth) {
  const shelfT = boardThickness(config, "shelves");
  const backT = boardThickness(config, "back");
  const openCells = config.openCells ?? [];
  for (const cell of openCells) {
    const y0 = rowEdges[cell.row];
    const y1 = rowEdges[cell.row + 1];
    const span = getClearSpanX(config, columnEdges, left, cell.col, 1, (y0 + y1) / 2);
    const x0 = span.x0;
    const x1 = span.x1;
    const w = span.width;
    const h = y1 - y0;
    const cx = span.center;

    if (cell.light) {
      const undersideY = y1 - shelfT * 0.5 - 0.006;
      const strip = new THREE.Mesh(
        new THREE.BoxGeometry(Math.max(0.05, w - 0.08), 0.012, 0.014),
        material(config.materials?.openLight, "warmLed"),
      );
      strip.position.set(cx, undersideY, depth / 2 - 0.015);
      addSketchEdges(strip, 0x111111, 0.28);
      root.add(strip);

      const light = new THREE.PointLight(0xffc27a, 0.16, 0.85);
      light.position.set(cx, undersideY - 0.04, depth / 2 - 0.08);
      root.add(light);
    }

    addShelfItems(cell.items, x0, x1, y0, y1, depth);
    addInnerShadow(x0, x1, y0, y1, depth, backT);
  }
}

function addDecorativeElements(config, width, depth) {
  const elements = config.decorativeElements ?? [];
  if (!Array.isArray(elements) || elements.length === 0) return;

  let wallFaceZ = -depth / 2 + 0.003;
  for (const item of elements) {
    const itemWidth = (item.width ?? width / MM_TO_M) * MM_TO_M;
    const itemHeight = (item.height ?? 1000) * MM_TO_M;
    const itemThickness = (item.thickness ?? 20) * MM_TO_M;
    const y = (item.bottomFromFloor ?? 0) * MM_TO_M + itemHeight / 2;
    const mat = material(item.material, item.type === "tv" ? "blackMetal" : "smokedOak");
    const z = wallFaceZ + itemThickness / 2;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(itemWidth, itemHeight, itemThickness), mat);
    mesh.name = item.id ?? item.type;
    mesh.position.set(0, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    addSketchEdges(mesh, 0x0b0b0b, item.type === "tv" ? 0.5 : 0.68);
    root.add(mesh);

    if (item.type === "wallPanel") {
      wallFaceZ = z + itemThickness / 2 + 0.003;
    }
  }
}

function addVerticalDividers(config, columnEdges, rowEdges, left, height, depth, carcass) {
  const configuredDividers = config.verticalDividers;
  const defaultDividerT = boardThickness(config, "dividers");
  const shelfT = boardThickness(config, "shelves");
  const floorOffset = (config.position?.floorOffset ?? 0) * MM_TO_M;
  const topT = boardThickness(config, "top");
  const bottomT = boardThickness(config, "bottom");

  if (!Array.isArray(configuredDividers) || configuredDividers.length === 0) {
    for (let i = 1; i < columnEdges.length - 1; i += 1) {
      const x = left + columnEdges[i];
      const shelfCuts = getHorizontalShelfCutsForBoundary(config, rowEdges, i);
      addSegmentedVerticalPanel(config, x, floorOffset + bottomT, height - topT, depth, carcass, `vertical-${i}`, shelfCuts, defaultDividerT, shelfT);
    }
    return;
  }

  for (const divider of configuredDividers) {
    const boundary = Number(divider.colBoundary);
    if (!Number.isFinite(boundary) || boundary <= 0 || boundary >= columnEdges.length) continue;

    const y0 = floorOffset + Number(divider.fromFloor ?? 0) * MM_TO_M + bottomT;
    const y1 = floorOffset + Number(divider.toTop ?? config.dimensions.height) * MM_TO_M - topT;
    const x = left + columnEdges[boundary];
    const shelfCuts = getHorizontalShelfCutsForBoundary(config, rowEdges, boundary);
    const dividerT = boardThickness(config, "dividers", divider);
    addSegmentedVerticalPanel(config, x, y0, y1, depth, carcass, divider.id ?? `vertical-${boundary}`, shelfCuts, dividerT, shelfT);
  }
}

function addSegmentedVerticalPanel(config, x, y0, y1, depth, carcass, name, shelfCuts, dividerT, shelfT) {
  const eps = 0.0001;
  const cuts = shelfCuts.filter((cutY) => cutY > y0 - eps && cutY < y1 + eps).sort((a, b) => a - b);
  let segmentStart = y0;
  let segmentIndex = 0;

  for (const cutY of cuts) {
    const segmentEnd = cutY - shelfT * 0.5;
    addVerticalPanelSegment(config, x, segmentStart, segmentEnd, depth, carcass, `${name}-${segmentIndex}`, dividerT);
    segmentStart = cutY + shelfT * 0.5;
    segmentIndex += 1;
  }
  addVerticalPanelSegment(config, x, segmentStart, y1, depth, carcass, `${name}-${segmentIndex}`, dividerT);
}

function addVerticalPanelSegment(config, x, y0, y1, depth, carcass, name, dividerT) {
  const segmentHeight = y1 - y0;
  if (segmentHeight <= dividerT * 0.2) return;
  addPanel(dividerT, segmentHeight, getInteriorPanelDepth(config, depth), [x, y0 + segmentHeight / 2, 0], carcass, name);
}

function getHorizontalShelfCutsForBoundary(config, rowEdges, boundary) {
  const cuts = new Set();

  for (const item of config.internal ?? []) {
    if (item.type !== "shelf") continue;
    const colSpan = item.colSpan ?? 1;
    const crossesBoundary = item.col < boundary && item.col + colSpan > boundary;
    if (!crossesBoundary) continue;
    cuts.add(roundCut(resolveInternalElementY(item, rowEdges)));
  }

  return [...cuts].map(Number);
}

function roundCut(value) {
  return value.toFixed(5);
}

function resolveInternalElementY(item, rowEdges) {
  const rowSpan = item.rowSpan ?? 1;
  const y0 = rowEdges[item.row];
  const y1 = rowEdges[item.row + rowSpan];

  if (typeof item.heightRatio === "number") {
    return y0 + (y1 - y0) * THREE.MathUtils.clamp(item.heightRatio, 0, 1);
  }
  if (typeof item.offsetFromTop === "number") {
    return y1 - item.offsetFromTop * MM_TO_M;
  }
  if (typeof item.heightFromFloor === "number") {
    return item.heightFromFloor * MM_TO_M;
  }
  if (item.position === "middle") {
    return (y0 + y1) / 2;
  }
  if (item.position === "top") {
    return y1;
  }
  return y0;
}

function addConfiguredRowShelves(config, columnEdges, rowEdges, left, depth, carcass) {
  const shelfKeys = new Set();
  const shelfT = boardThickness(config, "shelves");

  for (const cell of config.openCells ?? []) {
    if (cell.row > 0) shelfKeys.add(`${cell.col}:${cell.row}`);
    if (cell.row + 1 < config.rows.length) shelfKeys.add(`${cell.col}:${cell.row + 1}`);
  }

  for (const key of shelfKeys) {
    const [col, row] = key.split(":").map(Number);
    const y = rowEdges[row];
    const span = getClearSpanX(config, columnEdges, left, col, 1, y);
    const shelf = addPanel(span.width, shelfT, getInteriorPanelDepth(config, depth), [span.center, y, 0], carcass, `row-shelf-${col}-${row}`);
    registerHoverShelf(shelf, y, { x0: span.x0, x1: span.x1, y0: y, y1: y }, `Полка ${col + 1}`);
  }
}

function addInternalElements(config, columnEdges, rowEdges, left, depth, carcass) {
  for (const item of config.internal ?? []) {
    const colSpan = item.colSpan ?? 1;
    const rowSpan = item.rowSpan ?? 1;
    const y0 = rowEdges[item.row];
    const y1 = rowEdges[item.row + rowSpan];
    const itemT = boardThickness(config, item.type === "rail" ? "default" : "shelves", item);
    const y = resolveInternalElementY(item, rowEdges);
    const span = getClearSpanX(config, columnEdges, left, item.col, colSpan, y);
    const width = span.width;

    if (item.type === "rail") {
      addHangingRail(config, item, span.center, y, width, depth);
      continue;
    }

    if (item.type !== "shelf") continue;

    const shelf = new THREE.Mesh(new THREE.BoxGeometry(width, itemT, getInteriorPanelDepth(config, depth)), carcass);
    shelf.position.set(span.center, y, 0);
    shelf.name = item.id;
    shelf.castShadow = true;
    shelf.receiveShadow = true;
    registerHoverShelf(shelf, y, { x0: span.x0, x1: span.x1, y0: y, y1: y }, item.id ?? "Полка");
    addSketchEdges(shelf, 0x0b0b0b, 0.7);
    root.add(shelf);
  }
}

function registerHoverShelf(mesh, y, section = null, title = "Полка") {
  mesh.userData.shelfY = y;
  if (section) mesh.userData.section = section;
  mesh.userData.detail = makeDetail(title, section ?? { x0: -mesh.geometry.parameters.width / 2, x1: mesh.geometry.parameters.width / 2, y0: y, y1: y }, mesh.geometry.parameters.depth ?? 0, "Горизонтальная деталь внутри выбранного отсека.");
  hoverableShelves.push(mesh);
}

function addSectionHoverZones(config, columnEdges, rowEdges, left, depth) {
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });

  for (let col = 0; col < config.columns.length; col += 1) {
    for (let row = 0; row < config.rows.length; row += 1) {
      const x0 = left + columnEdges[col];
      const x1 = left + columnEdges[col + 1];
      const y0 = rowEdges[row];
      const y1 = rowEdges[row + 1];
      const zone = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(0.01, x1 - x0), Math.max(0.01, y1 - y0)), material);
      zone.position.set((x0 + x1) / 2, (y0 + y1) / 2, depth / 2 + 0.006);
      zone.userData.section = { x0, x1, y0, y1 };
      zone.userData.detail = makeDetail(`Секция ${col + 1}`, zone.userData.section, depth, "Свободный отсек изделия.");
      hoverableSections.push(zone);
      root.add(zone);
    }
  }
}

function makeDetail(title, section, depth, description) {
  const width = Math.max(0, (section.x1 - section.x0) / MM_TO_M);
  const height = Math.max(0, (section.y1 - section.y0) / MM_TO_M);
  return {
    key: `${title}:${roundCut(section.x0)}:${roundCut(section.x1)}:${roundCut(section.y0)}:${roundCut(section.y1)}`,
    title,
    width: Math.round(width),
    height: Math.round(height),
    depth: Math.round(depth / MM_TO_M),
    description,
  };
}

function getClearSpanX(config, columnEdges, left, col, colSpan, y) {
  const startBoundary = col;
  const endBoundary = col + colSpan;
  const rawX0 = left + columnEdges[startBoundary];
  const rawX1 = left + columnEdges[endBoundary];
  const x0 = rawX0 + boundaryInset(config, startBoundary, y);
  const x1 = rawX1 - boundaryInset(config, endBoundary, y);
  const width = Math.max(0.05, x1 - x0);
  return {
    x0,
    x1,
    width,
    center: x0 + width / 2,
  };
}

function boundaryInset(config, boundary, y) {
  if (boundary <= 0 || boundary >= config.columns.length) {
    return boardThickness(config, "sides");
  }

  const divider = findDividerAtBoundary(config, boundary, y);
  return boardThickness(config, "dividers", divider) * 0.5;
}

function findDividerAtBoundary(config, boundary, y) {
  const dividers = config.verticalDividers;
  if (!Array.isArray(dividers)) return null;
  const floorOffset = (config.position?.floorOffset ?? 0) * MM_TO_M;

  return (
    dividers.find((divider) => {
      if (Number(divider.colBoundary) !== boundary) return false;
      const y0 = floorOffset + Number(divider.fromFloor ?? 0) * MM_TO_M;
      const y1 = floorOffset + Number(divider.toTop ?? config.dimensions.height) * MM_TO_M;
      return y >= y0 - 0.0001 && y <= y1 + 0.0001;
    }) ?? null
  );
}

function getInteriorPanelDepth(config, depth) {
  const backT = boardThickness(config, "back");
  return Math.max(0.05, depth - backT - 0.024);
}

function addHangingRail(config, item, x, y, width, depth) {
  const radius = (item.diameter ?? 28) * MM_TO_M * 0.5;
  const socketT = boardThickness(config, "default", item);
  const railLength = Math.max(0.2, width - socketT * 0.8);
  const z = typeof item.depthFromBack === "number" ? -depth / 2 + item.depthFromBack * MM_TO_M : 0.07;
  const mat = material(item.material, "blackMetal");
  const rail = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, railLength, 32), mat);
  rail.name = item.id;
  rail.rotation.z = Math.PI / 2;
  rail.position.set(x, y, z);
  rail.castShadow = true;
  rail.receiveShadow = true;
  addSketchEdges(rail, 0x000000, 0.5);
  root.add(rail);

  const socketGeometry = new THREE.CylinderGeometry(radius * 1.65, radius * 1.65, socketT * 0.7, 24);
  for (const side of [-1, 1]) {
    const socket = new THREE.Mesh(socketGeometry, mat);
    socket.rotation.z = Math.PI / 2;
    socket.position.set(x + side * railLength * 0.5, y, z);
    socket.castShadow = true;
    addSketchEdges(socket, 0x000000, 0.45);
    root.add(socket);
  }
}

function addBaskets(config, columnEdges, left, depth, floorOffset = 0) {
  const baskets = config.baskets;
  if (!baskets) return;

  const rows = baskets.rows ?? 1;
  const columns = baskets.columns ?? 1;
  const top = floorOffset + (baskets.heightFromFloorToTop ?? 600) * MM_TO_M;
  const bottom = floorOffset;
  const span = getClearSpanX(config, columnEdges, left, baskets.colStart ?? 0, baskets.colSpan ?? columns, top / 2);
  const totalWidth = span.width;
  const cellWidth = totalWidth / columns;
  const cellHeight = (top - bottom) / rows;
  const mat = material(baskets.material, "metalMeshBlack");

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const cx = span.x0 + cellWidth * (col + 0.5);
      const cy = bottom + cellHeight * (row + 0.5);
      addLaundryBasket(cx, cy, cellWidth - 0.08, cellHeight - 0.08, depth * 0.78, mat, `${row}-${col}`);
    }
  }
}

function addLaundryBasket(cx, cy, width, height, depth, mat, suffix) {
  const group = new THREE.Group();
  group.name = `laundry-basket-${suffix}`;
  group.position.set(cx, cy, 0.02);

  const railSize = 0.018;
  const frontZ = depth / 2;
  const backZ = -depth / 2;
  const leftX = -width / 2;
  const rightX = width / 2;
  const topY = height / 2;
  const bottomY = -height / 2;

  addBasketRail(group, width, railSize, railSize, [0, topY, frontZ], mat);
  addBasketRail(group, width, railSize, railSize, [0, bottomY, frontZ], mat);
  addBasketRail(group, railSize, height, railSize, [leftX, 0, frontZ], mat);
  addBasketRail(group, railSize, height, railSize, [rightX, 0, frontZ], mat);
  addBasketRail(group, width, railSize, railSize, [0, topY, backZ], mat);
  addBasketRail(group, railSize, railSize, depth, [leftX, topY, 0], mat);
  addBasketRail(group, railSize, railSize, depth, [rightX, topY, 0], mat);

  const verticals = 8;
  for (let i = 1; i < verticals; i += 1) {
    const x = leftX + (width / verticals) * i;
    addBasketRail(group, 0.006, height * 0.86, 0.006, [x, 0, frontZ + 0.004], mat);
  }

  const horizontals = 4;
  for (let i = 1; i < horizontals; i += 1) {
    const y = bottomY + (height / horizontals) * i;
    addBasketRail(group, width * 0.92, 0.006, 0.006, [0, y, frontZ + 0.006], mat);
  }

  const cloth = new THREE.Mesh(
    new THREE.BoxGeometry(width * 0.78, height * 0.38, depth * 0.58),
    new THREE.MeshStandardMaterial({ color: 0x7b746d, roughness: 0.95 }),
  );
  cloth.position.set(0, bottomY + height * 0.22, -depth * 0.05);
  cloth.castShadow = true;
  addSketchEdges(cloth, 0x111111, 0.35);
  group.add(cloth);

  group.castShadow = true;
  root.add(group);
}

function addBasketRail(group, width, height, depth, position, mat) {
  const rail = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), mat);
  rail.position.set(...position);
  rail.castShadow = true;
  rail.receiveShadow = true;
  addSketchEdges(rail, 0x000000, 0.4);
  group.add(rail);
}

function addShelfItems(kind, x0, x1, y0, y1) {
  const baseY = y0 + 0.055;
  const centerX = (x0 + x1) / 2;
  const padding = 0.055;
  const leftLimit = x0 + padding;
  const rightLimit = x1 - padding;
  const usableWidth = Math.max(0.05, rightLimit - leftLimit);
  if (!kind) return;

  if (kind.includes("books")) {
    const bookWidths = Array.from({ length: 8 }, (_, i) => 0.045 + (i % 3) * 0.01);
    const gap = Math.min(0.014, Math.max(0.004, (usableWidth - bookWidths.reduce((total, width) => total + width, 0)) / (bookWidths.length - 1)));
    let x = leftLimit;
    for (let i = 0; i < 8; i += 1) {
      const book = new THREE.Mesh(
        new THREE.BoxGeometry(bookWidths[i], 0.18 + (i % 4) * 0.025, 0.15),
        i % 2 ? materialLibrary.paper : materialLibrary.charcoal,
      );
      const halfWidth = bookWidths[i] / 2;
      book.position.set(Math.min(rightLimit - halfWidth, x + halfWidth), baseY + book.geometry.parameters.height / 2, 0.08);
      book.rotation.z = (i % 3) * 0.025;
      book.castShadow = true;
      addSketchEdges(book, 0x111111, 0.5);
      root.add(book);
      x += bookWidths[i] + gap;
    }
  }

  if (kind.includes("vase") || kind.includes("bowl") || kind.includes("candles")) {
    const vase = new THREE.Mesh(
      new THREE.CylinderGeometry(kind.includes("bowl") ? 0.09 : 0.055, 0.07, kind.includes("bowl") ? 0.055 : 0.22, 24),
      materialLibrary.ceramic,
    );
    const radius = kind.includes("bowl") ? 0.09 : 0.07;
    const x = clamp(centerX + usableWidth * 0.27, leftLimit + radius, rightLimit - radius);
    vase.position.set(x, baseY + vase.geometry.parameters.height / 2, 0.08);
    vase.castShadow = true;
    addSketchEdges(vase, 0x111111, 0.42);
    root.add(vase);
  }

  if (kind.includes("audio") || kind.includes("box") || kind.includes("art")) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.13, 0.18), materialLibrary.charcoal);
    box.position.set(clamp(centerX - usableWidth * 0.05, leftLimit + 0.16, rightLimit - 0.16), baseY + 0.065, 0.08);
    box.castShadow = true;
    addSketchEdges(box, 0x111111, 0.42);
    root.add(box);
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function addInnerShadow(x0, x1, y0, y1, depth, backT) {
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(x1 - x0 - 0.08, y1 - y0 - 0.08),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.035, side: THREE.DoubleSide }),
  );
  plane.position.set((x0 + x1) / 2, (y0 + y1) / 2, -depth / 2 + backT + 0.002);
  root.add(plane);
}

function addPanel(width, height, depth, position, mat, name) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), mat);
  mesh.position.set(...position);
  mesh.name = name;
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  addSketchEdges(mesh, 0x0b0b0b, 0.72);
  root.add(mesh);
  return mesh;
}

function registerHoverDetail(mesh, title, width, height, depth, description, extra = {}) {
  mesh.userData.detail = {
    key: `${title}:${mesh.name}:${roundCut(width)}:${roundCut(height)}:${roundCut(depth)}`,
    title,
    width: Math.round(width / MM_TO_M),
    height: Math.round(height / MM_TO_M),
    depth: Math.round(depth / MM_TO_M),
    description,
    ...extra,
  };
  mesh.userData.objectKey = `detail:${mesh.name || title}`;
  hoverableDetails.push(mesh);
  return mesh;
}

function addWoodGrooves(doorMesh, width, height) {
  const grooves = Math.max(6, Math.round(width / 0.08));
  const group = new THREE.Group();
  for (let i = 1; i < grooves; i += 1) {
    const line = new THREE.Mesh(
      new THREE.BoxGeometry(0.004, height * (0.9 + Math.sin(i) * 0.04), 0.004),
      new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.18 }),
    );
    line.position.set(-width / 2 + (width / grooves) * i, 0, 0.023);
    group.add(line);
  }
  doorMesh.add(group);
}

function addRoomContext(config, width, height, depth, columnEdges, rowEdges, left) {
  const wallSize = 24;
  const outerLeft = left;
  const outerRight = width / 2;
  const outerBottom = 0;
  guideBounds = {
    left: outerLeft,
    right: outerRight,
    top: height,
    wallZ: -depth / 2 + 0.004,
    leftRulerX: outerLeft - 0.2,
    rightRulerX: outerRight + 0.2,
    topRulerY: height + 0.3,
  };
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(wallSize, wallSize),
    makeSketchMaterial(0xffffff, 0x111111, 0.025),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -0.004, wallSize / 2 - depth / 2);
  floor.receiveShadow = true;
  root.add(floor);

  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(wallSize, wallSize),
    makeSketchMaterial(0xf4f4ef, 0x111111, 0.02),
  );
  wall.position.set(0, wallSize / 2, -depth / 2 - 0.001);
  wall.receiveShadow = true;
  root.add(wall);

  addWallGrid(wallSize, depth, outerLeft, outerBottom);
  addShelfHeightMarks(config, rowEdges, outerLeft, depth);
  addDoorHeightMarks(config, rowEdges, outerRight, depth);
  addTopDimensionMarks(config, columnEdges, outerLeft, width, height, depth);
  addFloorDepthMark(outerLeft, depth);
}

function addWallGrid(size, depth, originX, originY) {
  const step = 0.1;
  const half = size / 2;
  const minX = -half;
  const maxX = half;
  const minY = 0;
  const maxY = size;
  const z = -depth / 2 - 0.0005;
  const points = [];
  const axisPoints = [];

  for (let x = originX + Math.ceil((minX - originX) / step) * step; x <= maxX + 0.0001; x += step) {
    points.push(new THREE.Vector3(x, minY, z));
    points.push(new THREE.Vector3(x, maxY, z));
  }

  for (let y = originY + Math.ceil((minY - originY) / step) * step; y <= maxY + 0.0001; y += step) {
    points.push(new THREE.Vector3(minX, y, z));
    points.push(new THREE.Vector3(maxX, y, z));
  }

  axisPoints.push(new THREE.Vector3(originX, minY, z + 0.001));
  axisPoints.push(new THREE.Vector3(originX, maxY, z + 0.001));
  axisPoints.push(new THREE.Vector3(minX, originY, z + 0.001));
  axisPoints.push(new THREE.Vector3(maxX, originY, z + 0.001));

  const grid = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({
      color: 0x111111,
      transparent: true,
      opacity: 0.13,
      depthWrite: false,
    }),
  );
  grid.name = "wall-100mm-grid";
  root.add(grid);

  const axes = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(axisPoints),
    new THREE.LineBasicMaterial({
      color: 0x111111,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    }),
  );
  axes.name = "wall-grid-origin-axes";
  root.add(axes);
}

function addShelfHeightMarks(config, rowEdges, left, depth) {
  const marks = collectShelfHeights(config, rowEdges);
  const z = -depth / 2 + 0.002;
  const x = left - 0.2;
  const tick = 0.065;
  const labelX = x;
  const totalX = left - 0.4;
  const totalTick = 0.075;
  const totalHeight = marks.at(-1) - marks[0];

  addMeasurementLine(
    [
      new THREE.Vector3(totalX, marks[0], z),
      new THREE.Vector3(totalX, marks.at(-1), z),
      new THREE.Vector3(totalX - totalTick, marks[0], z),
      new THREE.Vector3(totalX + totalTick, marks[0], z),
      new THREE.Vector3(totalX - totalTick, marks.at(-1), z),
      new THREE.Vector3(totalX + totalTick, marks.at(-1), z),
    ],
    0.88,
  );
  addMeasurementText(`${Math.round(totalHeight / MM_TO_M)}`, totalX, (marks[0] + marks.at(-1)) / 2, z, "center");

  for (const y of marks) {
    const line = addMeasurementLine([new THREE.Vector3(x - tick, y, z), new THREE.Vector3(x + tick, y, z)], 0.7);
    shelfHeightMarks.set(roundCut(y), line);
  }

  for (let i = 0; i < marks.length - 1; i += 1) {
    const y0 = marks[i];
    const y1 = marks[i + 1];
    if (y1 - y0 < 0.02) continue;
    addMeasurementLine([new THREE.Vector3(x, y0, z), new THREE.Vector3(x, y1, z)], 0.7);
    addMeasurementText(`${Math.round((y1 - y0) / MM_TO_M)}`, labelX, (y0 + y1) / 2, z, "center");
  }
}

function addDoorHeightMarks(config, rowEdges, right, depth) {
  const sections = new Map();
  for (const door of config.doors ?? []) {
    const colSpan = door.colSpan ?? 1;
    const rowSpan = door.rowSpan ?? 1;
    const y0 = rowEdges[door.row];
    const y1 = rowEdges[door.row + rowSpan];
    const key = `${door.col}:${door.col + colSpan}`;
    const section = sections.get(key) ?? { y0, y1, cuts: new Set() };
    section.y0 = Math.min(section.y0, y0);
    section.y1 = Math.max(section.y1, y1);
    section.cuts.add(roundCut(y0));
    section.cuts.add(roundCut(y1));
    sections.set(key, section);
  }

  const z = -depth / 2 + 0.002;
  let offset = 0;
  const uniqueSections = new Map();
  for (const section of sections.values()) {
    const cuts = [...section.cuts].map(Number).sort((a, b) => a - b);
    const signature = cuts.map(roundCut).join(":");
    if (!uniqueSections.has(signature)) uniqueSections.set(signature, { ...section, cuts });
  }

  for (const section of uniqueSections.values()) {
    const x = right + 0.2 + offset * 0.2;
    const cuts = section.cuts;

    for (const y of cuts) {
      const line = addMeasurementLine([new THREE.Vector3(x - 0.065, y, z), new THREE.Vector3(x + 0.065, y, z)], 0.82);
      addMarkToMap(rightHeightMarks, roundCut(y), line);
    }

    for (let i = 0; i < cuts.length - 1; i += 1) {
      const y0 = cuts[i];
      const y1 = cuts[i + 1];
      if (y1 - y0 < 0.02) continue;
      const rangeLine = addMeasurementLine([new THREE.Vector3(x, y0, z), new THREE.Vector3(x, y1, z)], 0.82);
      rightRangeMarks.push({ y0, y1, line: rangeLine });
      addMeasurementText(`${Math.round((y1 - y0) / MM_TO_M)}`, x, (y0 + y1) / 2, z, "center");
    }

    offset += 1;
  }
}

function addMarkToMap(map, key, line) {
  const lines = map.get(key) ?? [];
  lines.push(line);
  map.set(key, lines);
}

function addTopDimensionMarks(config, columnEdges, left, width, height, depth) {
  const z = -depth / 2 + 0.002;
  const y = height + 0.3;
  const tick = 0.06;
  const totalY = height + 0.5;
  const totalTick = 0.075;
  const right = left + width;

  addMeasurementLine(
    [
      new THREE.Vector3(left, totalY, z),
      new THREE.Vector3(right, totalY, z),
      new THREE.Vector3(left, totalY - totalTick, z),
      new THREE.Vector3(left, totalY + totalTick, z),
      new THREE.Vector3(right, totalY - totalTick, z),
      new THREE.Vector3(right, totalY + totalTick, z),
    ],
    0.88,
  );
  addMeasurementText(`${Math.round(width / MM_TO_M)}`, (left + right) / 2, totalY, z, "center");

  for (let col = 0; col < config.columns.length; col += 1) {
    const x0 = left + columnEdges[col];
    const x1 = left + columnEdges[col + 1];
    const line = addMeasurementLine(
      [
        new THREE.Vector3(x0, y, z),
        new THREE.Vector3(x1, y, z),
        new THREE.Vector3(x0, y - tick, z),
        new THREE.Vector3(x0, y + tick, z),
        new THREE.Vector3(x1, y - tick, z),
        new THREE.Vector3(x1, y + tick, z),
      ],
      0.82,
    );
    line.userData.dimensionX = { x0, x1 };
    topDimensionMarks.set(sectionXKey(x0, x1), line);
    addMeasurementText(`${Math.round((x1 - x0) / MM_TO_M)}`, (x0 + x1) / 2, y, z, "center");
  }
}

function addFloorDepthMark(left, depth) {
  const x = left - 0.2;
  const y = 0.008;
  const z0 = -depth / 2;
  const z1 = depth / 2;
  const tick = 0.055;

  addMeasurementLine(
    [
      new THREE.Vector3(x, y, z0),
      new THREE.Vector3(x, y, z1),
      new THREE.Vector3(x - tick, y, z0),
      new THREE.Vector3(x + tick, y, z0),
      new THREE.Vector3(x - tick, y, z1),
      new THREE.Vector3(x + tick, y, z1),
    ],
    0.82,
  );
  addFloorMeasurementText(`${Math.round(depth / MM_TO_M)}`, x - 0.08, y + 0.002, (z0 + z1) / 2, "right");
}

function addFloorMeasurementText(text, x, y, z, align) {
  const label = makeMeasurementLabel(text, align);
  const labelWidth = label.userData.width;
  const offsetX = align === "right" ? -labelWidth / 2 : align === "left" ? labelWidth / 2 : 0;
  label.position.set(x + offsetX, y, z);
  label.rotation.x = -Math.PI / 2;
  root.add(label);
}

function sectionXKey(x0, x1) {
  return `${roundCut(x0)}:${roundCut(x1)}`;
}

function collectShelfHeights(config, rowEdges) {
  const marks = new Set();
  for (const y of rowEdges) marks.add(roundCut(y));
  for (const cell of config.openCells ?? []) {
    if (cell.row > 0) marks.add(roundCut(rowEdges[cell.row]));
    if (cell.row + 1 < config.rows.length) marks.add(roundCut(rowEdges[cell.row + 1]));
  }

  for (const item of config.internal ?? []) {
    if (item.type === "shelf") marks.add(roundCut(resolveInternalElementY(item, rowEdges)));
  }

  return [...marks].map(Number).sort((a, b) => a - b);
}

function addMeasurementLine(points, opacity) {
  const line = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({
      color: 0x111111,
      transparent: true,
      opacity,
      depthWrite: false,
    }),
  );
  line.userData.defaultColor = 0x111111;
  line.userData.defaultOpacity = opacity;
  root.add(line);
  return line;
}

function addMeasurementText(text, x, y, z, align) {
  const label = makeMeasurementLabel(text, align);
  const labelWidth = label.userData.width;
  const offsetX = align === "right" ? -labelWidth / 2 : align === "left" ? labelWidth / 2 : 0;
  label.position.set(x + offsetX, y, z + 0.002);
  root.add(label);
}

function makeMeasurementLabel(text, align) {
  const font = "700 32px Arial, sans-serif";
  const paddingX = 14;
  const paddingY = 8;
  const canvasLabel = document.createElement("canvas");
  const ctx = canvasLabel.getContext("2d");
  ctx.font = font;
  const metrics = ctx.measureText(text);
  const textWidth = Math.ceil(metrics.width);
  canvasLabel.width = textWidth + paddingX * 2;
  canvasLabel.height = 48;
  ctx.font = font;
  ctx.clearRect(0, 0, canvasLabel.width, canvasLabel.height);
  ctx.fillStyle = "rgba(247, 247, 242, 0.82)";
  ctx.fillRect(0, paddingY / 2, canvasLabel.width, canvasLabel.height - paddingY);
  ctx.fillStyle = "#111111";
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  const textX = align === "right" ? canvasLabel.width - paddingX : align === "center" ? canvasLabel.width / 2 : paddingX;
  ctx.fillText(text, textX, canvasLabel.height / 2);

  const texture = new THREE.CanvasTexture(canvasLabel);
  texture.colorSpace = THREE.SRGBColorSpace;
  const labelHeight = 0.105;
  const labelWidth = (canvasLabel.width / canvasLabel.height) * labelHeight;
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(labelWidth, labelHeight),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  label.userData.width = labelWidth;
  label.userData.height = labelHeight;
  return label;
}

function setupScene() {
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d8d0, 2.2));

  const key = new THREE.DirectionalLight(0xffffff, 1.8);
  key.position.set(-2.2, 4.4, 3.2);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  scene.add(key);

  const accent = new THREE.PointLight(0xffffff, 0.35, 6);
  accent.position.set(2.5, 2.7, 2.0);
  scene.add(accent);
}

function makeWoodMaterial(base, dark) {
  return makeSketchMaterial(base, dark, 0.08);
}

function makeSketchMaterial(base, ink, opacity = 0.06) {
  const texture = makeSketchTexture(base, ink, opacity);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2.4, 3.2);
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: texture,
    roughness: 0.92,
    metalness: 0,
  });
}

function makeSketchTexture(baseHex, inkHex, opacity) {
  const canvasTexture = document.createElement("canvas");
  canvasTexture.width = 256;
  canvasTexture.height = 512;
  const ctx = canvasTexture.getContext("2d");
  const base = new THREE.Color(baseHex);
  const ink = new THREE.Color(inkHex);

  ctx.fillStyle = `#${base.getHexString()}`;
  ctx.fillRect(0, 0, canvasTexture.width, canvasTexture.height);

  for (let y = -canvasTexture.height; y < canvasTexture.height * 2; y += 14) {
    ctx.strokeStyle = `rgba(${Math.round(ink.r * 255)}, ${Math.round(ink.g * 255)}, ${Math.round(ink.b * 255)}, ${opacity})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-24, y);
    for (let x = -24; x <= canvasTexture.width + 24; x += 32) {
      ctx.lineTo(x, y + x * 0.55 + Math.sin(x * 0.08 + y * 0.03) * 3);
    }
    ctx.stroke();
  }

  for (let i = 0; i < 240; i += 1) {
    const x = Math.random() * canvasTexture.width;
    const y = Math.random() * canvasTexture.height;
    ctx.fillStyle = `rgba(${Math.round(ink.r * 255)}, ${Math.round(ink.g * 255)}, ${Math.round(ink.b * 255)}, ${opacity * 0.45})`;
    ctx.fillRect(x, y, 1, 1);
  }
  return new THREE.CanvasTexture(canvasTexture);
}

function addSketchEdges(mesh, color = 0x0b0b0b, opacity = 0.65) {
  const edges = new THREE.EdgesGeometry(mesh.geometry, 22);
  const lines = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
    }),
  );
  lines.name = `${mesh.name || "mesh"}-sketch-edges`;
  mesh.add(lines);
}

function material(name, fallback) {
  return materialLibrary[name] ?? materialLibrary[fallback];
}

function boardThickness(config, key = "default", item = null) {
  if (typeof item?.thickness === "number") return item.thickness * MM_TO_M;

  const thicknessConfig = config.boardThickness;
  if (typeof thicknessConfig === "number") return thicknessConfig * MM_TO_M;
  if (thicknessConfig && typeof thicknessConfig[key] === "number") return thicknessConfig[key] * MM_TO_M;
  if (thicknessConfig && typeof thicknessConfig.default === "number") return thicknessConfig.default * MM_TO_M;
  return DEFAULT_BOARD_THICKNESS;
}

function edges(values) {
  const result = [0];
  for (const value of values) result.push(result.at(-1) + value);
  return result;
}

function sum(items, key) {
  return items.reduce((total, item) => total + Number(item[key] ?? 0), 0);
}

function getProducts(config) {
  if (Array.isArray(config.products) && config.products.length > 0) {
    return config.products.map((product, index) => ({
      id: product.id ?? `product-${index}`,
      name: product.name ?? product.label ?? product.id ?? `Изделие ${index + 1}`,
      type: product.type ?? "wardrobe",
      config: product.config,
    }));
  }

  return [
    { id: "wardrobe", name: "Шкаф", type: "wardrobe" },
    { id: "console", name: "Консоль", type: "console" },
  ];
}

function renderProductTabs(config) {
  productTabsEl.textContent = "";
  const products = getProducts(config);
  if (!activeProductId && products.length > 0) activeProductId = products[0].id;

  for (const product of products) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = `product-tab${product.id === activeProductId ? " active" : ""}`;
    tab.textContent = product.name;
    tab.addEventListener("click", () => {
      activeProductId = product.id;
      currentConfig = { ...currentConfig, activeProduct: product.id };
      const url = new URL(window.location.href);
      url.searchParams.set("tab", product.id);
      window.history.replaceState(null, "", url);
      renderActiveProduct();
      renderProductTabs(currentConfig);
    });
    productTabsEl.append(tab);
  }
}

function frameCamera(config) {
  if (!config) return;
  resizeRenderer();
  const width = config.dimensions.width * MM_TO_M;
  const height = config.dimensions.height * MM_TO_M;
  const depth = config.dimensions.depth * MM_TO_M;
  const floorOffset = (config.position?.floorOffset ?? 0) * MM_TO_M;
  const decor = Array.isArray(config.decorativeElements) ? config.decorativeElements : [];
  const decorWidth = Math.max(0, ...decor.map((item) => (item.width ?? 0) * MM_TO_M));
  const decorTop = Math.max(0, ...decor.map((item) => ((item.bottomFromFloor ?? 0) + (item.height ?? 0)) * MM_TO_M));
  const contentWidth = Math.max(width, decorWidth);
  const contentTop = Math.max(floorOffset + height, decorTop);
  const frameLeft = -contentWidth / 2 - 0.46;
  const frameRight = contentWidth / 2 + 0.46;
  const frameBottom = -0.04;
  const frameTop = contentTop + 0.54;
  const frameWidth = frameRight - frameLeft;
  const frameHeight = frameTop - frameBottom;
  const target = new THREE.Vector3((frameLeft + frameRight) / 2, (frameBottom + frameTop) / 2, 0);
  const verticalFov = THREE.MathUtils.degToRad(camera.fov);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
  const distanceForHeight = frameHeight / 2 / Math.tan(verticalFov / 2);
  const distanceForWidth = frameWidth / 2 / Math.tan(horizontalFov / 2);
  const distance = Math.max(distanceForHeight, distanceForWidth, depth * 4) * 1.08;
  const direction = new THREE.Vector3(0, 0, 1);

  controls.target.copy(target);
  camera.position.copy(target).addScaledVector(direction, distance);
  camera.near = 0.01;
  camera.far = 120;
  camera.updateProjectionMatrix();
  controls.update();
  scheduleRender();
}

function resizeRenderer() {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (width === rendererWidth && height === rendererHeight) return false;
  rendererWidth = width;
  rendererHeight = height;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  return true;
}

function onCanvasPointerDown(event) {
  pointerDown = {
    x: event.clientX,
    y: event.clientY,
    time: performance.now(),
  };
}

function onCanvasPointerUp(event) {
  if (!pointerDown) return;
  const distance = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
  const duration = performance.now() - pointerDown.time;
  pointerDown = null;
  if (distance > 6 || duration > 450) return;

  const picked = pickInteractive(event);
  if (picked?.object?.userData?.clickDoor) {
    const objectKey = picked.object.userData.objectKey ?? `door:${picked.object.userData.clickDoor.userData.door.id}`;
    if (selectedObjectKey !== objectKey) {
      selectedObjectKey = objectKey;
      updateDetailPanel(picked.object.userData.detail);
      return;
    }

    const doorGroup = picked.object.userData.clickDoor;
    const id = doorGroup.userData.door.id;
    if (openDoorIds.has(id)) {
      openDoorIds.delete(id);
      doorGroup.userData.door.target = 0;
    } else {
      openDoorIds.add(id);
      doorGroup.userData.door.target = 1;
    }
    scheduleRender();
    return;
  }

  if (picked?.object?.userData?.detail) {
    selectedObjectKey = picked.object.userData.objectKey ?? picked.object.userData.detail.key;
    updateDetailPanel(picked.object.userData.detail);
  }
}

function onCanvasPointerMove(event) {
  const picked = pickInteractive(event);
  const object = picked?.object ?? null;

  if (object?.userData?.detail && picked.kind !== "section") {
    highlightDetail(object);
    highlightSection(null);
    canvas.style.cursor = object.userData.clickDoor ? "pointer" : "grab";
    return;
  }
  highlightDetail(null);

  const door = object?.userData?.clickDoor ?? null;
  const closedDoorSection = getClosedDoorSection(door);
  let shelf = null;
  let section = null;

  if (closedDoorSection) {
    section = closedDoorSection;
  } else {
    shelf = picked?.kind === "shelf" ? object : null;
    section = shelf?.userData?.section ?? object?.userData?.section ?? null;
    const coveringDoor = section ? findClosedDoorCoveringSection(section) : null;
    if (coveringDoor) {
      shelf = null;
      section = coveringDoor.section;
    }
  }

  highlightSection(section, shelf?.userData?.shelfY);
  canvas.style.cursor = door ? "pointer" : "grab";
}

function pickInteractive(event) {
  const realObjects = [...clickableDoors, ...hoverableDetails, ...hoverableShelves];
  const fallbackObjects = hoverableSections;
  if (realObjects.length === 0 && fallbackObjects.length === 0) return null;
  updatePointerFromEvent(event);
  raycaster.setFromCamera(pointer, camera);
  let hits = raycaster.intersectObjects(realObjects, false);
  let fallback = false;
  if (hits.length === 0) {
    hits = raycaster.intersectObjects(fallbackObjects, false);
    fallback = true;
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => {
    const distance = a.distance - b.distance;
    if (Math.abs(distance) > 0.0001) return distance;
    return pickPriority(a.object) - pickPriority(b.object);
  });
  const hit = hits[0];
  return { object: hit.object, kind: fallback ? "section" : pickKind(hit.object), hit };
}

function pickKind(object) {
  if (object.userData.clickDoor) return "door";
  if (hoverableDetails.includes(object)) return "detail";
  if (hoverableShelves.includes(object)) return "shelf";
  return "section";
}

function pickPriority(object) {
  if (object.userData.clickDoor) return 0;
  if (hoverableDetails.includes(object)) return 1;
  if (hoverableShelves.includes(object)) return 2;
  return 3;
}

function highlightDetail(mesh) {
  if (highlightedDetailEdges?.userData?.source === mesh) return;
  if (highlightedDetailEdges) {
    root.remove(highlightedDetailEdges);
    disposeObject(highlightedDetailEdges);
    highlightedDetailEdges = null;
  }
  if (!mesh) {
    scheduleRender();
    return;
  }

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry, 12),
    new THREE.LineBasicMaterial({
      color: 0x1268ff,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    }),
  );
  mesh.updateWorldMatrix(true, false);
  edges.applyMatrix4(mesh.matrixWorld);
  edges.userData.source = mesh;
  highlightedDetailEdges = edges;
  root.add(edges);
  scheduleRender();
}

function getClosedDoorSection(doorGroup) {
  if (!doorGroup?.userData?.door) return null;
  return doorGroup.userData.door.target < 0.5 ? doorGroup.userData.section : null;
}

function findClosedDoorCoveringSection(section) {
  return (
    doorSections.find((door) => {
      if (door.group.userData.door.target >= 0.5) return false;
      return containsSection(door.section, section);
    }) ?? null
  );
}

function containsSection(outer, inner) {
  return (
    inner.x0 >= outer.x0 - 0.0001 &&
    inner.x1 <= outer.x1 + 0.0001 &&
    inner.y0 >= outer.y0 - 0.0001 &&
    inner.y1 <= outer.y1 + 0.0001
  );
}

function pickDoor(event) {
  if (clickableDoors.length === 0) return null;
  updatePointerFromEvent(event);
  raycaster.setFromCamera(pointer, camera);
  const [hit] = raycaster.intersectObjects(clickableDoors, false);
  return hit?.object?.userData?.clickDoor ?? null;
}

function pickShelf(event) {
  if (hoverableShelves.length === 0) return null;
  updatePointerFromEvent(event);
  raycaster.setFromCamera(pointer, camera);
  const [hit] = raycaster.intersectObjects(hoverableShelves, false);
  return hit?.object ?? null;
}

function pickSection(event) {
  if (hoverableSections.length === 0) return null;
  updatePointerFromEvent(event);
  raycaster.setFromCamera(pointer, camera);
  const [hit] = raycaster.intersectObjects(hoverableSections, false);
  return hit?.object ?? null;
}

function updatePointerFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function highlightShelfMark(y) {
  highlightSection(null, y);
}

function updateDetailPanel(detail) {
  if (!detail || detail.key === activeDetailKey) return;
  activeDetailKey = detail.key;
  detailTitleEl.textContent = detail.title;
  detailDrawingEl.innerHTML = detailSvg(detail);
  detailSpecsEl.innerHTML = `
    <dt>Ширина</dt><dd>${detail.width}</dd>
    <dt>Высота</dt><dd>${detail.height}</dd>
    <dt>Глубина</dt><dd>${detail.depth}</dd>
  `;
  detailDescriptionEl.textContent = detail.description;
}

function detailSvg(detail) {
  if (detail.notchWidth && detail.notchDepth) return detailCutoutSvg(detail);

  const w = Math.max(1, detail.width);
  const h = Math.max(1, detail.height || Math.round(detail.depth * 0.18) || 1);
  const viewW = 280;
  const viewH = 190;
  const scale = Math.min(180 / w, 88 / h);
  const rectW = Math.max(36, w * scale);
  const rectH = Math.max(18, h * scale);
  const x = (viewW - rectW) / 2;
  const y = 36;
  return `
    <svg viewBox="0 0 ${viewW} ${viewH}" role="img" aria-label="Чертеж детали">
      <rect x="${x}" y="${y}" width="${rectW}" height="${rectH}" fill="#f7f7f2" stroke="#111" stroke-width="2"/>
      <line x1="${x}" y1="${y + rectH + 18}" x2="${x + rectW}" y2="${y + rectH + 18}" stroke="#111" stroke-width="1.5"/>
      <line x1="${x}" y1="${y + rectH + 12}" x2="${x}" y2="${y + rectH + 24}" stroke="#111" stroke-width="1.5"/>
      <line x1="${x + rectW}" y1="${y + rectH + 12}" x2="${x + rectW}" y2="${y + rectH + 24}" stroke="#111" stroke-width="1.5"/>
      <text x="${viewW / 2}" y="${y + rectH + 38}" text-anchor="middle" font-size="15" font-weight="700">${detail.width}</text>
      <line x1="${x - 18}" y1="${y}" x2="${x - 18}" y2="${y + rectH}" stroke="#111" stroke-width="1.5"/>
      <line x1="${x - 24}" y1="${y}" x2="${x - 12}" y2="${y}" stroke="#111" stroke-width="1.5"/>
      <line x1="${x - 24}" y1="${y + rectH}" x2="${x - 12}" y2="${y + rectH}" stroke="#111" stroke-width="1.5"/>
      <text x="${x - 30}" y="${y + rectH / 2}" text-anchor="middle" font-size="15" font-weight="700" transform="rotate(-90 ${x - 30} ${y + rectH / 2})">${detail.height}</text>
    </svg>
  `;
}

function detailCutoutSvg(detail) {
  const viewW = 280;
  const viewH = 170;
  const scale = Math.min(190 / detail.width, 94 / detail.depth);
  const rectW = detail.width * scale;
  const rectD = detail.depth * scale;
  const notchW = detail.notchWidth * scale;
  const notchD = detail.notchDepth * scale;
  const x = (viewW - rectW) / 2;
  const y = 28;
  const nx0 = x + (rectW - notchW) / 2;
  const nx1 = nx0 + notchW;
  const cutY = y + notchD;
  const path = [
    `M ${x} ${y}`,
    `L ${nx0} ${y}`,
    `L ${nx0} ${cutY}`,
    `L ${nx1} ${cutY}`,
    `L ${nx1} ${y}`,
    `L ${x + rectW} ${y}`,
    `L ${x + rectW} ${y + rectD}`,
    `L ${x} ${y + rectD}`,
    "Z",
  ].join(" ");

  return `
    <svg viewBox="0 0 ${viewW} ${viewH}" role="img" aria-label="Чертеж детали с вырезом">
      <path d="${path}" fill="#f7f7f2" stroke="#111" stroke-width="2"/>
      <line x1="${x}" y1="${y + rectD + 18}" x2="${x + rectW}" y2="${y + rectD + 18}" stroke="#111" stroke-width="1.5"/>
      <line x1="${x}" y1="${y + rectD + 12}" x2="${x}" y2="${y + rectD + 24}" stroke="#111" stroke-width="1.5"/>
      <line x1="${x + rectW}" y1="${y + rectD + 12}" x2="${x + rectW}" y2="${y + rectD + 24}" stroke="#111" stroke-width="1.5"/>
      <text x="${viewW / 2}" y="${y + rectD + 39}" text-anchor="middle" font-size="15" font-weight="700">${detail.width}</text>
      <line x1="${x - 18}" y1="${y}" x2="${x - 18}" y2="${y + rectD}" stroke="#111" stroke-width="1.5"/>
      <line x1="${x - 24}" y1="${y}" x2="${x - 12}" y2="${y}" stroke="#111" stroke-width="1.5"/>
      <line x1="${x - 24}" y1="${y + rectD}" x2="${x - 12}" y2="${y + rectD}" stroke="#111" stroke-width="1.5"/>
      <text x="${x - 32}" y="${y + rectD / 2}" text-anchor="middle" font-size="15" font-weight="700" transform="rotate(-90 ${x - 32} ${y + rectD / 2})">${detail.depth}</text>
      <text x="${viewW / 2}" y="${cutY + 18}" text-anchor="middle" font-size="13" font-weight="700">вырез ${detail.clearanceDepth}</text>
    </svg>
  `;
}

function highlightSection(section, fallbackY = undefined) {
  const next = [];
  const guideSection = section ? { ...section } : null;
  if (guideSection && typeof fallbackY === "number") {
    guideSection.y0 = fallbackY;
    guideSection.y1 = fallbackY;
  }

  if (section) {
    addHeightMarksToHighlight(next, section.y0);
    addHeightMarksToHighlight(next, section.y1);
    if (typeof fallbackY === "number") addHeightMarksToHighlight(next, fallbackY);
    addRightRangesToHighlight(next, section, fallbackY);

    for (const line of topDimensionMarks.values()) {
      const x = line.userData.dimensionX;
      if (!x) continue;
      const overlaps = x.x1 > section.x0 + 0.0001 && x.x0 < section.x1 - 0.0001;
      if (overlaps) next.push(line);
    }
  } else if (typeof fallbackY === "number") {
    addHeightMarksToHighlight(next, fallbackY);
  }

  const same =
    next.length === highlightedMarks.length &&
    next.every((line, index) => line === highlightedMarks[index]);
  if (same && guideSectionKey(guideSection) === guideLines?.userData?.sectionKey) return;

  for (const line of highlightedMarks) {
    restoreMeasurementLine(line);
  }

  highlightedMarks = next;
  for (const line of highlightedMarks) {
    line.material.color.set(0x1268ff);
    line.material.opacity = 1;
  }
  drawGuideLines(guideSection);
  scheduleRender();
}

function addHeightMarksToHighlight(target, y) {
  const key = roundCut(y);
  const leftLine = shelfHeightMarks.get(key);
  if (leftLine && !target.includes(leftLine)) target.push(leftLine);
  for (const line of rightHeightMarks.get(key) ?? []) {
    if (!target.includes(line)) target.push(line);
  }
}

function addRightRangesToHighlight(target, section, fallbackY) {
  for (const range of rightRangeMarks) {
    const sameSpan =
      Math.abs(range.y0 - section.y0) < 0.0001 &&
      Math.abs(range.y1 - section.y1) < 0.0001;
    if (sameSpan && !target.includes(range.line)) target.push(range.line);
  }
}

function restoreMeasurementLine(line) {
  line.material.color.set(line.userData.defaultColor ?? 0x111111);
  line.material.opacity = line.userData.defaultOpacity ?? 0.7;
}

function drawGuideLines(section) {
  if (guideLines) {
    root.remove(guideLines);
    disposeObject(guideLines);
    guideLines = null;
  }
  if (!section || !guideBounds) return;

  const points = [];
  const zWall = guideBounds.wallZ;
  const topRulerY = guideBounds.topRulerY;

  for (const y of uniqueNumbers([section.y0, section.y1])) {
    points.push(new THREE.Vector3(guideBounds.leftRulerX, y, zWall), new THREE.Vector3(guideBounds.left, y, zWall));
    points.push(new THREE.Vector3(guideBounds.rightRulerX, y, zWall), new THREE.Vector3(guideBounds.right, y, zWall));
  }

  for (const x of uniqueNumbers([section.x0, section.x1])) {
    points.push(new THREE.Vector3(x, topRulerY, zWall), new THREE.Vector3(x, guideBounds.top, zWall));
  }

  guideLines = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({
      color: 0x1268ff,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    }),
  );
  guideLines.userData.sectionKey = guideSectionKey(section);
  root.add(guideLines);
}

function guideSectionKey(section) {
  if (!section) return "";
  return [section.x0, section.x1, section.y0, section.y1].map(roundCut).join(":");
}

function uniqueNumbers(values) {
  return [...new Set(values.map((value) => roundCut(value)))].map(Number);
}

function disposeObject(object) {
  object.traverse((child) => {
    child.geometry?.dispose?.();
    if (Array.isArray(child.material)) {
      for (const materialItem of child.material) materialItem.dispose?.();
    } else {
      child.material?.dispose?.();
    }
  });
}

function animateDoors(delta) {
  let active = false;
  const doorGroups = new Set(clickableDoors.map((doorMesh) => doorMesh.userData.clickDoor).filter(Boolean));
  for (const doorGroup of doorGroups) {
    if (!doorGroup?.userData?.door) continue;
    const state = doorGroup.userData.door;
    state.progress = THREE.MathUtils.damp(state.progress, state.target, 10, delta);
    if (Math.abs(state.progress - state.target) < 0.001) {
      state.progress = state.target;
    } else {
      active = true;
    }
    doorGroup.rotation.y = THREE.MathUtils.lerp(state.closed, state.open, state.progress);
  }
  return active;
}

function scheduleRender() {
  if (renderFrameId) return;
  renderFrameId = requestAnimationFrame(renderFrame);
}

function renderFrame() {
  renderFrameId = 0;
  resizeRenderer();
  const delta = Math.min(clock.getDelta(), 0.05);
  const doorsActive = animateDoors(delta);
  const controlsActive = controls.update();
  renderer.render(scene, camera);

  if (doorsActive || controlsActive) {
    scheduleRender();
  }
}

function downloadConfig() {
  const blob = new Blob([currentConfigText], { type: "text/yaml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "wardrobe.yaml";
  link.click();
  URL.revokeObjectURL(url);
}

async function loadConfigFile(event) {
  const [file] = event.target.files;
  if (!file) return;
  const text = await file.text();
  currentConfigText = text;
  editor.value = text;
  applyConfigText(text);
  event.target.value = "";
}
