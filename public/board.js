/* ═══════════════════════════════════════════════════════════════
   SMARTBOARD — BOARD.JS
   Advanced Interactive Canvas Logic
   ═══════════════════════════════════════════════════════════════ */
'use strict';

// ── STATE ──
let pages = [{ type: "blank", gridType: 0 }]; 
let pageStrokes = { 0: [] };
let pageRedoStacks = { 0: [] };
let currentIndex = 0;

let panX = 0, panY = 0, zoom = 1;
let tool = "draw"; // draw, pen, erase, laser, rect, circle, line, arrow, select, pan
let currentColor = "#ff0000";
let penSize = 4;
let markerSize = 8;
let highlightSize = 15;
let eraserSize = 25;

const activeTouches = new Map();
let panning = false;
let startX = 0, startY = 0;

// ── DOM ELEMENTS ──
const drawCanvas = document.getElementById("drawCanvas");
const ctx = drawCanvas.getContext("2d");
const pdfCanvas = document.getElementById("pdfCanvas");
const pdfCtx = pdfCanvas.getContext("2d");
const viewer = document.getElementById("workspace");

// ── INIT ──
document.addEventListener("DOMContentLoaded", () => {
  resize();
  initClock();
  setupListeners();
  renderPage();
  loadCurrentPageState();
  
  // Apply initial color preview
  updateColorPreview();
});

function resize() {
  drawCanvas.width = window.innerWidth;
  drawCanvas.height = window.innerHeight;
  // If we have a blank page, make it larger for panning
  if (pages[currentIndex].type === "blank") {
    pdfCanvas.width = window.innerWidth;
    pdfCanvas.height = window.innerHeight;
  }
  redraw();
}
window.addEventListener("resize", resize);

// ── DRAWING ENGINE ──
function getAdjustedCoords(e) {
  const rect = drawCanvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left - panX) / zoom,
    y: (e.clientY - rect.top - panY) / zoom
  };
}

function redraw() {
  ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  ctx.save();
  ctx.translate(panX, panY);
  ctx.scale(zoom, zoom);

  const strokes = [...(pageStrokes[currentIndex] || []), ...Array.from(activeTouches.values())];

  for (let s of strokes) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    let w = s.width / zoom;

    if (s.tool === "erase") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.lineWidth = w;
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.lineWidth = w;
      ctx.strokeStyle = s.color;
      
      if (s.tool === "laser") {
        ctx.shadowBlur = 10;
        ctx.shadowColor = s.color;
        if (s.finalized) {
          let age = Date.now() - s.finalized;
          ctx.globalAlpha = Math.max(0, 1 - age / 2000);
        }
      } else if (s.tool === "highlight") {
        ctx.globalAlpha = 0.3;
      } else {
        ctx.globalAlpha = 1;
      }
    }

    if (["draw", "pen", "erase", "highlight", "laser"].includes(s.tool)) {
      if (!s.path || s.path.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(s.path[0].x, s.path[0].y);
      for (let i = 1; i < s.path.length; i++) {
        ctx.lineTo(s.path[i].x, s.path[i].y);
      }
      ctx.stroke();
    } else if (s.tool === "rect") {
      ctx.strokeRect(s.shape.x1, s.shape.y1, s.shape.x2 - s.shape.x1, s.shape.y2 - s.shape.y1);
    } else if (s.tool === "circle") {
      const r = Math.hypot(s.shape.x2 - s.shape.x1, s.shape.y2 - s.shape.y1) / 2;
      const cx = (s.shape.x1 + s.shape.x2) / 2;
      const cy = (s.shape.y1 + s.shape.y2) / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    } else if (s.tool === "line") {
      ctx.beginPath();
      ctx.moveTo(s.shape.x1, s.shape.y1);
      ctx.lineTo(s.shape.x2, s.shape.y2);
      ctx.stroke();
    } else if (s.tool === "arrow") {
        drawArrow(ctx, s.shape.x1, s.shape.y1, s.shape.x2, s.shape.y2, 15/zoom);
    }

    // Reset
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = "source-over";
  }
  ctx.restore();
}

function drawArrow(ctx, x1, y1, x2, y2, head) {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
}

// ── EVENT LISTENERS ──
function setupListeners() {
  drawCanvas.addEventListener("pointerdown", e => {
    e.preventDefault();
    const pos = getAdjustedCoords(e);
    
    if (tool === "pan") {
      panning = true;
      startX = e.clientX;
      startY = e.clientY;
      return;
    }

    const stroke = {
      tool: tool,
      color: currentColor,
      width: tool === 'erase' ? eraserSize : (tool === 'draw' ? markerSize : (tool === 'pen' ? penSize : penSize)),
      path: ["draw", "pen", "erase", "laser"].includes(tool) ? [pos] : [],
      shape: !["draw", "pen", "erase", "laser"].includes(tool) ? { x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y } : null,
      timestamp: Date.now()
    };
    activeTouches.set(e.pointerId, stroke);
    redraw();
  });

  drawCanvas.addEventListener("pointermove", e => {
    e.preventDefault();
    if (panning) {
      panX += e.clientX - startX;
      panY += e.clientY - startY;
      startX = e.clientX;
      startY = e.clientY;
      redraw();
      return;
    }

    const pos = getAdjustedCoords(e);
    const stroke = activeTouches.get(e.pointerId);
    if (!stroke) return;

    if (stroke.path) {
      stroke.path.push(pos);
    } else {
      stroke.shape.x2 = pos.x;
      stroke.shape.y2 = pos.y;
    }
    redraw();
  });

  drawCanvas.addEventListener("pointerup", e => {
    panning = false;
    const stroke = activeTouches.get(e.pointerId);
    if (stroke) {
      if (stroke.tool === 'laser') {
        stroke.finalized = Date.now();
        setTimeout(() => {
          const idx = pageStrokes[currentIndex].indexOf(stroke);
          if (idx > -1) {
            pageStrokes[currentIndex].splice(idx, 1);
            redraw();
          }
        }, 2000);
      }
      pageStrokes[currentIndex].push(stroke);
      pageRedoStacks[currentIndex] = [];
      activeTouches.delete(e.pointerId);
    }
    redraw();
  });

  // Toolbar clicks
  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.onclick = () => {
      tool = btn.dataset.tool;
      document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    };
  });

  // Color clicks
  document.querySelectorAll('.dot-btn').forEach(btn => {
    btn.onclick = () => {
      currentColor = btn.dataset.color;
      updateColorPreview();
    };
  });

  // Brush size
  document.getElementById("brushSize").oninput = e => {
    const val = parseInt(e.target.value);
    if (tool === 'draw') markerSize = val;
    else if (tool === 'pen') penSize = val;
    else penSize = val;
  };

  // Actions
  document.getElementById("btn-undo").onclick = undo;
  document.getElementById("btn-redo").onclick = redo;
  document.getElementById("btn-clear").onclick = clearCanvas;
  
  // Page Nav
  document.getElementById("next-page").onclick = nextPage;
  document.getElementById("prev-page").onclick = prevPage;
  document.getElementById("add-page").onclick = addPage;
  document.getElementById("del-page").onclick = removePage;

  // View
  document.getElementById("btn-zoom-in").onclick  = () => { zoom += 0.1; redraw(); };
  document.getElementById("btn-zoom-out").onclick = () => { zoom = Math.max(0.2, zoom - 0.1); redraw(); };
  document.getElementById("btn-zoom-fit").onclick = () => { zoom = 1; panX = 0; panY = 0; redraw(); };
  document.getElementById("btn-fullscreen").onclick = toggleFullScreen;

  // Grid
  document.getElementById("btn-grid").onclick = toggleGrid;

  // Floating Panels
  document.getElementById("btn-calc").onclick = () => togglePanel('calc-panel');
  document.getElementById("btn-ai").onclick   = () => togglePanel('ai-panel');
  document.getElementById("btn-qr").onclick   = () => {
    togglePanel('qr-panel');
    generateQR();
  };

  // AI Generate
  document.getElementById("btn-ai-generate").onclick = handleAIGenerate;
}

// ── FUNCTIONS ──
function updateColorPreview() {
  document.getElementById("active-color-preview").style.background = currentColor;
}

function undo() {
  if (pageStrokes[currentIndex].length === 0) return;
  pageRedoStacks[currentIndex].push(pageStrokes[currentIndex].pop());
  redraw();
}

function redo() {
  if (pageRedoStacks[currentIndex].length === 0) return;
  pageStrokes[currentIndex].push(pageRedoStacks[currentIndex].pop());
  redraw();
}

function clearCanvas() {
  if (confirm("Clear current page?")) {
    pageStrokes[currentIndex] = [];
    pageRedoStacks[currentIndex] = [];
    redraw();
  }
}

function updatePageInfo() {
  document.getElementById("page-info").textContent = `Page ${currentIndex + 1} / ${pages.length}`;
}

function nextPage() {
  if (currentIndex < pages.length - 1) {
    currentIndex++;
    renderPage();
    loadCurrentPageState();
  }
}

function prevPage() {
  if (currentIndex > 0) {
    currentIndex--;
    renderPage();
    loadCurrentPageState();
  }
}

function addPage() {
  pages.push({ type: "blank", gridType: 0 });
  pageStrokes[pages.length - 1] = [];
  pageRedoStacks[pages.length - 1] = [];
  currentIndex = pages.length - 1;
  renderPage();
  loadCurrentPageState();
}

function removePage() {
  if (pages.length <= 1) return;
  pages.splice(currentIndex, 1);
  // Simpler to just re-map keys
  const newStrokes = {};
  const newRedo = {};
  let count = 0;
  for (let i = 0; i <= pages.length; i++) {
    if (i === currentIndex) continue;
    newStrokes[count] = pageStrokes[i] || [];
    newRedo[count] = pageRedoStacks[i] || [];
    count++;
  }
  pageStrokes = newStrokes;
  pageRedoStacks = newRedo;
  currentIndex = Math.max(0, currentIndex - 1);
  renderPage();
  loadCurrentPageState();
}

function renderPage() {
  pdfCtx.clearRect(0, 0, pdfCanvas.width, pdfCanvas.height);
  const page = pages[currentIndex];
  if (page.type === "blank") {
    pdfCanvas.width = window.innerWidth;
    pdfCanvas.height = window.innerHeight;
    pdfCtx.fillStyle = "#121212";
    pdfCtx.fillRect(0, 0, pdfCanvas.width, pdfCanvas.height);
    
    if (page.gridType === 1) {
        drawGrid(pdfCtx, pdfCanvas.width, pdfCanvas.height);
    }
  }
  updatePageInfo();
}

function drawGrid(c, w, h) {
    c.strokeStyle = "#333";
    c.lineWidth = 1;
    for(let i=40; i<w; i+=40) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i, h); c.stroke(); }
    for(let i=40; i<h; i+=40) { c.beginPath(); c.moveTo(0, i); c.lineTo(w, i); c.stroke(); }
}

function toggleGrid() {
    pages[currentIndex].gridType = pages[currentIndex].gridType === 0 ? 1 : 0;
    renderPage();
}

function loadCurrentPageState() {
  redraw();
}

function toggleFullScreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else {
    if (document.exitFullscreen) document.exitFullscreen();
  }
}

// ── FLOATING PANELS ──
function togglePanel(id) {
  const p = document.getElementById(id);
  p.classList.toggle('hidden');
}

// Calculator Logic
function calcInput(key) {
  const display = document.getElementById("calc-display");
  if (key === 'C') display.value = "0";
  else if (key === 'DEL') display.value = display.value.slice(0, -1) || "0";
  else if (key === '=') {
    try { display.value = eval(display.value); } catch { display.value = "Error"; }
  } else {
    if (display.value === "0" && key !== '.') display.value = key;
    else display.value += key;
  }
}

// ── AI ASSIST ──
async function handleAIGenerate() {
  const prompt = document.getElementById("ai-prompt").value.trim();
  const status = document.getElementById("ai-status");
  if (!prompt) return;

  status.textContent = "Processing description...";
  
  // Mock AI Logic: Detect keywords and draw templates
  setTimeout(() => {
    const low = prompt.toLowerCase();
    const cx = (window.innerWidth/2 - panX)/zoom;
    const cy = (window.innerHeight/2 - panY)/zoom;

    if (low.includes("rect") || low.includes("box")) {
      addShapeToPage("rect", cx-100, cy-50, cx+100, cy+50);
    } else if (low.includes("circle") || low.includes("round")) {
      addShapeToPage("circle", cx-80, cy-80, cx+80, cy+80);
    } else if (low.includes("mind") || low.includes("flow")) {
        // Draw a basic structure
        addShapeToPage("rect", cx-50, cy-150, cx+50, cy-100);
        addShapeToPage("arrow", cx, cy-100, cx, cy-50);
        addShapeToPage("circle", cx-40, cy-50, cx+40, cy);
    } else {
        // Generic AI sketch
        addShapeToPage("line", cx-100, cy, cx+100, cy);
        addShapeToPage("line", cx, cy-100, cx, cy+100);
    }
    
    status.textContent = "Generation complete!";
    document.getElementById("ai-prompt").value = "";
    setTimeout(() => status.textContent = "", 2000);
  }, 1000);
}

function addShapeToPage(type, x1, y1, x2, y2) {
    pageStrokes[currentIndex].push({
        tool: type,
        color: currentColor,
        width: penSize,
        shape: { x1, y1, x2, y2 },
        timestamp: Date.now()
    });
    redraw();
}

// ── QR EXPORT ──
function generateQR() {
  const qrEl = document.getElementById("qrCode");
  qrEl.innerHTML = "";
  const url = window.location.href; // In real use case, this would be a link to the Exported PDF
  new QRCode(qrEl, {
    text: url,
    width: 150,
    height: 150
  });
}

// ── UTILITIES ──
function initClock() {
  const el = document.getElementById("time-tag");
  setInterval(() => {
    const now = new Date();
    el.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, 1000);
}

function formatTime(d) {
  return d.getHours().toString().padStart(2, '0') + ":" + d.getMinutes().toString().padStart(2, '0');
}