// ========== URL PARAMS ==========
const urlParams = new URLSearchParams(window.location.search);
let currentBoardId = urlParams.get('board') || '1';
let currentSubject = urlParams.get('subject') || '';
const autoOpenFileUrl = urlParams.get('fileUrl');

if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.14.305/pdf.worker.min.js';
}

// ========== SOCKET.IO CONNECTION ==========
const socket = (typeof io !== 'undefined') ? io() : null;
const isLivePreview = urlParams.get('live') === 'true';

if (socket) {
    if (isLivePreview) {
        socket.emit('join-admin', currentBoardId);
    } else {
        socket.emit('join-board', currentBoardId);
    }
}

// ========== OPEN BOARD (transition to canvas) ==========
function quitToHome() {
    window.location.href = 'index.html';
}

document.addEventListener("DOMContentLoaded", () => {
    // Start with a blank page first, regardless.
    pages = [{ type: "blank", gridType: 0 }];
    pageStrokes = { 0: [] };
    pageRedoStacks = { 0: [] };
    currentIndex = 0;

    loadPDFsForBoard();

    if (autoOpenFileUrl) {
        let attempts = 0;
        const runLoad = () => {
            attempts++;
            const fileExt = autoOpenFileUrl.split('.').pop().toLowerCase();
            const isImg = ['png','jpg','jpeg','gif','webp'].includes(fileExt);
            
            if (isImg) {
                loadWebsiteImage(autoOpenFileUrl);
            } else if (window.pdfjsLib) {
                loadWebsitePDF(autoOpenFileUrl);
            } else if (attempts < 20) {
                setTimeout(runLoad, 200);
            }
        };
        runLoad();
    } else {
        renderPage();
        loadCurrentPageState();
    }
});

async function loadPDFsForBoard() {
    if (!currentBoardId) return;
    const res = await fetch(`/api/board-files?board=${currentBoardId}&subject=${encodeURIComponent(currentSubject)}`);
    const pdfs = await res.json();
    const list = document.getElementById('dynamicPdfList');
    if (!list) return;
    list.innerHTML = "";

    const backBtn = document.createElement('button');
    backBtn.className = 'pdfBtn';
    backBtn.innerHTML = 'Home';
    backBtn.onclick = () => {
        window.location.href = 'index.html';
    };
    list.appendChild(backBtn);

    const blankBtn = document.createElement('button');
    blankBtn.className = 'pdfBtn';
    blankBtn.innerHTML = 'Fresh Session';
    blankBtn.onclick = () => {
        pages = [{ type: "blank", gridType: 0 }];
        currentIndex = 0;
        pageStrokes = { 0: [] };
        pageRedoStacks = { 0: [] };
        renderPage();
        loadCurrentPageState();
        document.getElementById("pdfLibrary").style.display = "none";
    };
    list.appendChild(blankBtn);

    pdfs.forEach(pdf => {
        const btn = document.createElement('button');
        btn.className = 'pdfBtn';
        const ext = pdf.filename.split('.').pop().toLowerCase();
        
        // Simplified UI: Plain text titles only
        btn.innerText = pdf.original_name;
        
        btn.onclick = () => {
            if (['png','jpg','jpeg','gif','webp'].includes(ext)) {
                loadWebsiteImage('/uploads/' + pdf.filename);
            } else if (['mp4','webm','mov'].includes(ext)) {
                loadWebsiteVideo('/uploads/' + pdf.filename);
            } else if (['pdf'].includes(ext)) {
                loadWebsitePDF('/uploads/' + pdf.filename);
            } else {
                alert("This file (" + ext.toUpperCase() + ") is for reference.");
            }
        };
        list.appendChild(btn);
    });
}

function loadWebsiteImage(url) {
    let img = new Image();
    img.onload = () => {
        pages = [{ type: "image", src: url, width: img.width, height: img.height }];
        pageStrokes = { 0: [] };
        pageRedoStacks = { 0: [] };
        currentIndex = 0;
        clearDrawCanvas();
        undoStack.length = 0;
        redoStack.length = 0;
        renderPage();
        loadCurrentPageState();
        toggleHub();
    };
    img.src = url;
}

// ========== DRAWING ENGINE ==========
let containerOffsetY = 0;

let pdfDoc = null,
    pages = [],
    currentIndex = 0;

const pdfCanvas = document.getElementById("pdfCanvas");
const pdfCtx = pdfCanvas.getContext("2d");

const activeTouches = new Map();

// Pan/zoom state
let panX = 0,
  panY = 0,
  zoom = 1,
  panning = false,
  startX = 0,
  startY = 0;

// Tool state
let tool = "draw"; // draw, rect, circle, line, arrow, erase, pan, highlight, laser
let penSize = 4;
let highlightSize = 15;
let eraserSize = 25;
function loadWebsiteVideo(url) {
    pages = [{ type: "video", src: url }];
    pageStrokes = { 0: [] };
    pageRedoStacks = { 0: [] };
    currentIndex = 0;
    renderPage();
    loadCurrentPageState();
    toggleHub();
}

let color = "#ff0000";

// Canvas
const drawCanvas = document.getElementById("drawCanvas");
const ctx = drawCanvas.getContext("2d");
const viewer = document.getElementById("viewer");
const colorPicker = document.getElementById("colorPicker");
colorPicker.onchange = (e) => selectColor(e.target.value);
const brushSize = document.getElementById("brushSize");

// Undo/redo stacks
const undoStack = [];
const redoStack = [];

// Per-page history
let pageStrokes = {};
let pageRedoStacks = {};

// Resize canvas
function resize() {
  drawCanvas.width = window.innerWidth;
  drawCanvas.height = window.innerHeight;
}
resize();
window.addEventListener("resize", resize);

// --- Helper: redraw all strokes ---
function redraw(strokes) {
  ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  ctx.save();
  ctx.translate(panX, panY);
  ctx.scale(zoom, zoom);

  let hasActiveLaser = false;

  for (let s of strokes) {
    ctx.lineCap = "round";

    let strokeWidth = s.width / zoom;

    if (s.tool === "erase") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.lineWidth = strokeWidth;
    } else if (s.tool === "highlight") {
      ctx.globalCompositeOperation = "source-over";
      ctx.lineWidth = Math.max(strokeWidth, 10 / zoom);
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = s.color;
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.lineWidth = strokeWidth;
      ctx.globalAlpha = 1;
      ctx.strokeStyle = s.tool === 'laser' ? '#ff0000' : s.color;
      if (s.tool === 'laser') {
          hasActiveLaser = true;
          ctx.shadowBlur = 10;
          ctx.shadowColor = '#ff0000';
          
          if (s.finalized) {
              let age = Date.now() - s.finalized;
              let pulse = Math.abs(Math.cos(age * 0.006));
              ctx.globalAlpha = pulse; 
              if (age > 3000) ctx.globalAlpha = 0;
          } else {
              ctx.globalAlpha = 1; 
          }
      } else {
          ctx.shadowBlur = 0;
      }
    }

    if (["draw", "erase", "highlight", "laser"].includes(s.tool)) {
      if (!s.path || s.path.length === 0) continue;
      ctx.beginPath();
      ctx.moveTo(s.path[0].x, s.path[0].y);
      for (let i = 1; i < s.path.length; i++) {
        ctx.lineTo(s.path[i].x, s.path[i].y);
      }
      ctx.stroke();
    } else if (s.tool === "rect") {
      const x = Math.min(s.shape.x1, s.shape.x2);
      const y = Math.min(s.shape.y1, s.shape.y2);
      const w = Math.abs(s.shape.x2 - s.shape.x1);
      const h = Math.abs(s.shape.y2 - s.shape.y1);
      ctx.beginPath();
      ctx.strokeRect(x, y, w, h);
      ctx.stroke();
    } else if (s.tool === "circle") {
      ctx.beginPath();
      ctx.arc(s.shape.cx, s.shape.cy, s.shape.r, 0, Math.PI * 2);
      ctx.stroke();
    } else if (s.tool === "line") {
      ctx.beginPath();
      ctx.moveTo(s.shape.x1, s.shape.y1);
      ctx.lineTo(s.shape.x2, s.shape.y2);
      ctx.stroke();
    } else if (s.tool === "arrow") {
      const headLen = 15 / zoom;
      const dx = s.shape.x2 - s.shape.x1;
      const dy = s.shape.y2 - s.shape.y1;
      const angle = Math.atan2(dy, dx);
      ctx.beginPath();
      ctx.moveTo(s.shape.x1, s.shape.y1);
      ctx.lineTo(s.shape.x2, s.shape.y2);
      ctx.moveTo(
        s.shape.x2 - headLen * Math.cos(angle - Math.PI / 6),
        s.shape.y2 - headLen * Math.sin(angle - Math.PI / 6)
      );
      ctx.lineTo(s.shape.x2, s.shape.y2);
      ctx.lineTo(
        s.shape.x2 - headLen * Math.cos(angle + Math.PI / 6),
        s.shape.y2 - headLen * Math.sin(angle + Math.PI / 6)
      );
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = "source-over";
  }
  ctx.restore();

  if (hasActiveLaser && !redrawScheduled) {
      redrawScheduled = true;
      requestAnimationFrame(() => {
          redrawScheduled = false;
          redraw([...undoStack, ...Array.from(activeTouches.values())]);
      });
  }
}

function cloneStroke(stroke) {
  return {
    tool: stroke.tool,
    color: stroke.color,
    width: stroke.width,
    path: stroke.path ? stroke.path.map((p) => ({ x: p.x, y: p.y })) : null,
    shape: stroke.shape ? { ...stroke.shape } : null,
  };
}

// --- POINTER START ---
let stylusMode = false;

function toggleStylusMode() {
    stylusMode = !stylusMode;
    const btn = document.getElementById("stylusBtn");
    if(stylusMode) {
        btn.style.background = "rgba(106,106,255,0.6)";
    } else {
        btn.style.background = "rgba(255,255,255,0.3)";
    }
}

drawCanvas.addEventListener(
  "pointerdown",
  (e) => {
    e.preventDefault();
    let currentTool = tool;
    
    if (e.pointerType === 'touch' && stylusMode) {
        currentTool = "erase";
    } 

    const ex = (e.clientX - panX) / zoom;
    const ey = (e.clientY - panY) / zoom; 

    if (currentTool !== "pan") {
      let w = penSize;
      if(currentTool === 'erase') w = eraserSize;
      if(currentTool === 'highlight') w = highlightSize;
      
      const stroke = {
        id: Math.random().toString(36).substr(2, 9),
        tool: currentTool,
        color: color,
        width: w,
        timestamp: Date.now(),
        path: ["draw", "erase", "highlight", "laser"].includes(currentTool) ? [{ x: ex, y: ey }] : [],
        shape: !["draw", "erase", "highlight", "laser"].includes(currentTool) ? { x1: ex, y1: ey, x2: ex, y2: ey } : null,
      };
      activeTouches.set(e.pointerId, stroke);

      // Show Next Page hint if near bottom
      if (e.clientY > window.innerHeight - 150) {
          document.getElementById('nextPageHint').style.display = 'block';
      } else {
          document.getElementById('nextPageHint').style.display = 'none';
      }
    }

    if (currentTool === "pan") {
      panning = true;
      startX = e.clientX;
      startY = e.clientY;
      return;
    }
  },
  { passive: false }
);

// --- POINTER MOVE ---
let redrawScheduled = false;
drawCanvas.addEventListener(
  "pointermove",
  (e) => {
    e.preventDefault();

    if (tool === "pan" && panning) {
      panX += e.clientX - startX;
      panY += e.clientY - startY;
      startX = e.clientX;
      startY = e.clientY;
      applyTransform();
      redraw([...undoStack, ...Array.from(activeTouches.values())]);
      return;
    }

    const ex = (e.clientX - panX) / zoom;
    const ey = (e.clientY - panY) / zoom;

    const stroke = activeTouches.get(e.pointerId);
    if (!stroke) return;
    
    let needsRedraw = false;
    if (["draw", "erase", "highlight", "laser"].includes(stroke.tool)) {
        stroke.path.push({ x: ex, y: ey });
        needsRedraw = true;
    } else {
        stroke.shape.x2 = ex;
        stroke.shape.y2 = ey;
        if (stroke.tool === "circle") {
          const dx = stroke.shape.x2 - stroke.shape.x1;
          const dy = stroke.shape.y2 - stroke.shape.y1;
          stroke.shape.cx = (stroke.shape.x1 + stroke.shape.x2) / 2;
          stroke.shape.cy = (stroke.shape.y1 + stroke.shape.y2) / 2;
          stroke.shape.r = Math.hypot(dx, dy) / 2;
        }
        needsRedraw = true;
    }

    if (needsRedraw && !redrawScheduled) {
       redrawScheduled = true;
       requestAnimationFrame(() => {
          redraw([...undoStack, ...Array.from(activeTouches.values())]);
          redrawScheduled = false;
       });
    }
  },
  { passive: false }
);

// --- POINTER END / CANCEL ---
const onPointerEnd = (e) => {
    e.preventDefault();
    if (tool === "pan") {
      panning = false;
      return;
    }

    const stroke = activeTouches.get(e.pointerId);
    if (!stroke) return;

    let shouldAdd = true;
    if (["draw", "erase", "highlight", "laser"].includes(stroke.tool)) {
        if (stroke.path.length <= 1) shouldAdd = false;
    } else {
        if (stroke.shape.x1 === stroke.shape.x2 && stroke.shape.y1 === stroke.shape.y2) shouldAdd = false;
    }

    if (shouldAdd) {
        if (stroke.tool === 'laser') {
            stroke.finalized = Date.now();
            
            setTimeout(() => {
                const idx = undoStack.indexOf(stroke);
                if (idx > -1) {
                    undoStack.splice(idx, 1);
                    redraw(undoStack);
                }
            }, 3000); 
        }
        undoStack.push(stroke);
        redoStack.push([]); // Reset redo on new action
        redoStack.length = 0;

        // SYNC TO SERVER (ONLY IF NOT IN PREVIEW MODE)
        if (socket && !isLivePreview) {
            socket.emit('draw-stroke', { boardId: currentBoardId, stroke: stroke });
        }
    }
    activeTouches.delete(e.pointerId);

    if (!redrawScheduled) {
      redrawScheduled = true;
      requestAnimationFrame(() => {
        redraw(undoStack);
        redrawScheduled = false;
      });
    }
};

drawCanvas.addEventListener("pointerup", onPointerEnd, { passive: false });
drawCanvas.addEventListener("pointercancel", onPointerEnd, { passive: false });

// --- UNDO ---
function undo() {
  if (!undoStack.length) return;
  const lastStroke = undoStack.pop();
  redoStack.push(lastStroke);
  redraw(undoStack);
}

// --- REDO ---
function redo() {
  if (!redoStack.length) return;
  const stroke = redoStack.pop();
  undoStack.push(stroke);
  redraw(undoStack);
}

// --- TOOL SELECTION ---
function changeBrushSize(val) {
   if (tool === 'draw') penSize = parseInt(val);
   else if (tool === 'highlight') highlightSize = parseInt(val);
   else if (tool === 'erase') eraserSize = parseInt(val);
   else penSize = parseInt(val);
}

function setTool(t) {
  tool = t;
  const brushSizeSlider = document.getElementById("brushSize");
  if(t === 'draw') brushSizeSlider.value = penSize;
  if(t === 'highlight') brushSizeSlider.value = highlightSize;
  if(t === 'erase') brushSizeSlider.value = eraserSize;

  document.querySelectorAll(".smartboard-tool, .toolbar-vertical button, .toolbar-horizontal button").forEach(b => b.classList.remove("active-tool"));
  try {
     event.currentTarget.classList.add("active-tool");
  } catch(e) {}
}

function applyTransform() {
  const transform = `translate(${panX}px,${panY}px) scale(${zoom})`;
  viewer.style.transform = transform;
}

// --- PDF & UI LOGIC ---
function clearDrawCanvas() {
  ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
}

function clearCanvas() {
  clearDrawCanvas();
  undoStack.length = 0;
  redoStack.length = 0;
  pageStrokes[currentIndex] = [];
  
  if (socket) {
    socket.emit('clear-board', currentBoardId);
  }
}

// --- STATE MANAGEMENT ---
function saveCurrentPageState() {
    pageStrokes[currentIndex] = [...undoStack];
    pageRedoStacks[currentIndex] = [...redoStack];
}
function loadCurrentPageState() {
    if (!pageStrokes[currentIndex]) pageStrokes[currentIndex] = [];
    if (!pageRedoStacks[currentIndex]) pageRedoStacks[currentIndex] = [];
    undoStack.length = 0;
    redoStack.length = 0;
    pageStrokes[currentIndex].forEach(s => undoStack.push(cloneStroke(s)));
    pageRedoStacks[currentIndex].forEach(s => redoStack.push(cloneStroke(s)));
    redraw(undoStack);
}

function zoomIn() {
  zoom += 0.1;
  applyTransform();
  syncBoardBackground();
  redraw([...undoStack, ...Array.from(activeTouches.values())]);
}
function zoomOut() {
  zoom = Math.max(0.4, zoom - 0.1);
  applyTransform();
  syncBoardBackground();
  redraw([...undoStack, ...Array.from(activeTouches.values())]);
}
function fit() {
  zoom = 1;
  panX = 0;
  panY = 0;
  applyTransform();
  syncBoardBackground();
  redraw([...undoStack, ...Array.from(activeTouches.values())]);
}

let currentGridType = 0; // 0=Black Plane, 1=Black Roll, 2=White Plane, 3=White Roll

function toggleGrid() {
   let page = pages[currentIndex];
   if (page.type === "pdf") return;
   
   if (page.gridType === undefined) {
       page.gridType = 0;
   }
   page.gridType = (page.gridType + 1) % 4;
   currentGridType = page.gridType;
   renderPage();
}

      async function renderPage() {
        clearDrawCanvas();
        // Clear any existing video overlays from previous slides
        const existingVid = document.getElementById("boardVideo");
        if (existingVid) existingVid.remove();

        let page = pages[currentIndex];
        if (page.type === "blank" || page.type === "blackboard") {
          pdfCanvas.width = Math.max(5000, window.innerWidth * 3);
          pdfCanvas.height = Math.max(8000, window.innerHeight * 4);
          
          let bgGrid = page.gridType !== undefined ? page.gridType : currentGridType;

          // Background fill
          if (bgGrid === 0 || bgGrid === 1) {
              pdfCtx.fillStyle = "#121212"; 
              pdfCtx.strokeStyle = "#333";
          } else {
              pdfCtx.fillStyle = "white";
              pdfCtx.strokeStyle = "#e0e0e0";
          }
          pdfCtx.fillRect(0, 0, pdfCanvas.width, pdfCanvas.height);
          
          // Lined paper rows
          if (bgGrid === 1 || bgGrid === 3) { 
              for(let y = 40; y < pdfCanvas.height; y+=40) {
                 pdfCtx.beginPath(); pdfCtx.moveTo(0, y); pdfCtx.lineTo(pdfCanvas.width, y); pdfCtx.stroke();
              }
          }
        } else if (page.type === "image") {
          pdfCanvas.width = page.width;
          pdfCanvas.height = page.height;
          let img = new Image();
          img.onload = () => {
            pdfCtx.drawImage(img, 0, 0, page.width, page.height);
          };
          img.src = page.src;
        } else if (page.type === "video") {
           // Clear background
           pdfCanvas.width = window.innerWidth;
           pdfCanvas.height = window.innerHeight;
           pdfCtx.fillStyle = "#000";
           pdfCtx.fillRect(0,0,pdfCanvas.width, pdfCanvas.height);
           // Show video overlay? Or just draw one frame?
           // We will create a floating video element
           let existing = document.getElementById("boardVideo");
           if(existing) existing.remove();
           let vid = document.createElement('video');
           vid.id = "boardVideo";
           vid.src = page.src;
           vid.controls = true;
           vid.style.position = "absolute";
           vid.style.top = "50%";
           vid.style.left = "50%";
           vid.style.transform = "translate(-50%, -50%)";
           vid.style.maxWidth = "80%";
           vid.style.maxHeight = "80%";
           vid.style.zIndex = "5";
           viewer.appendChild(vid);
           vid.play();
        } else {
          const p = await pdfDoc.getPage(page.num);
          let viewport = p.getViewport({ scale: 1 });
          pdfCanvas.width = viewport.width;
          pdfCanvas.height = viewport.height;
          await p.render({ canvasContext: pdfCtx, viewport: viewport }).promise;
        }
        
        document.getElementById("pageInfo").textContent =
          `Page ${currentIndex + 1} / ${pages.length}`;
          
        syncBoardBackground();
      }

      function toggleHub() {
        const lib = document.getElementById("pdfLibrary");
        lib.style.display = lib.style.display === "flex" ? "none" : "flex";
      }

      function togglePDFLibrary() { toggleHub(); }

      function toggleColorPalette() {
        const palette = document.getElementById("colorPalette");
        if (!palette) return;
        const isHidden = window.getComputedStyle(palette).display === 'none';
        palette.style.display = isHidden ? 'grid' : 'none';
      }

      function selectColor(c) {
        color = c;
        const mainBtn = document.getElementById("mainColorBtn");
        if (mainBtn) mainBtn.style.background = c;
        const picker = document.getElementById("colorPicker");
        if (picker) picker.value = c;
        document.getElementById("colorPalette").style.display = "none";
      }

      function syncBoardBackground() {
        if (socket && !isLivePreview) {
          const currentPage = pages[currentIndex];
          socket.emit('sync-background', {
            board: currentBoardId,
            fileUrl: currentPage?.src || null,
            bgType: currentPage?.type || 'blank',
            pageIndex: currentIndex,
            panX: panX,
            panY: panY,
            zoom: zoom
          });
        }
      }

      // ========== SOCKET LISTENERS ==========
      if (socket) {
          socket.on('draw-stroke', (stroke) => {
              if (undoStack.some(s => s.id === stroke.id)) return;
              undoStack.push(stroke);
              redraw(undoStack);
          });

          socket.on('sync-background', async (data) => {
              if (!isLivePreview) return;
              // Sync transform and view
              panX = data.panX || 0;
              panY = data.panY || 0;
              zoom = data.zoom || 1;
              applyTransform();

              // Check if we need to load a new background
              const currentBg = pages[currentIndex];
              if (data.fileUrl && (!currentBg || currentBg.src !== data.fileUrl)) {
                  if (data.bgType === 'pdf') await loadWebsitePDF(data.fileUrl, true);
                  else if (data.bgType === 'image') await loadWebsiteImage(data.fileUrl, true);
                  else if (data.bgType === 'video') await loadWebsiteVideo(data.fileUrl);
              }
              
              if (currentIndex !== data.pageIndex) {
                  currentIndex = data.pageIndex;
                  renderPage();
              }
              redraw(undoStack);
          });

          socket.on('init-strokes', (strokes) => {
              undoStack.length = 0;
              strokes.forEach(s => undoStack.push(s));
              redraw(undoStack);
          });

          socket.on('clear-board', () => {
              undoStack.length = 0;
              redraw(undoStack);
          });
      }

      function togglePDFLibrary() {
        const menu = document.getElementById("pdfLibrary");
        if (menu.style.display === "flex") {
          menu.style.display = "none";
        } else {
          menu.style.display = "flex";
        }
      }

      function loadWebsitePDF(url) {
        if (!pdfjsLib) { alert("PDF Library not loaded yet. Retrying..."); return; }
        pdfjsLib.getDocument(url).promise.then((pdf) => {
          pdfDoc = pdf;
          pages = [];
          pageStrokes = {};
          pageRedoStacks = {};

          for (let i = 1; i <= pdf.numPages; i++) {
            pages.push({ type: "pdf", num: i });
            pageStrokes[i-1] = [];
            pageRedoStacks[i-1] = [];
          }

          currentIndex = 0;
          clearDrawCanvas();
          undoStack.length = 0;
          redoStack.length = 0;

          renderPage();
          loadCurrentPageState();

          const pdfLibEl = document.getElementById("pdfLibrary");
          if(pdfLibEl) pdfLibEl.style.display = "none";
        }).catch(err => {
            console.error(err);
            alert("Error loading Document: " + err.message);
        });
      }


function nextPage() {
  saveCurrentPageState();
  if (currentIndex >= pages.length - 1) {
    let g = currentGridType;
    if (pages[currentIndex] && pages[currentIndex].type !== "pdf") {
        g = pages[currentIndex].gridType !== undefined ? pages[currentIndex].gridType : currentGridType;
    }
    pages.push({ type: "blank", gridType: g });
    pageStrokes[pages.length-1] = [];
    pageRedoStacks[pages.length-1] = [];
  }
  currentIndex++;
  renderPage();
  loadCurrentPageState();
}

function prevPage() {
  if (currentIndex <= 0) return;
  saveCurrentPageState();
  currentIndex--;
  renderPage();
  loadCurrentPageState();
}

function removePage() {
  if (pages.length <= 1) return;

  saveCurrentPageState();
  pages.splice(currentIndex, 1);
  delete pageStrokes[currentIndex];
  delete pageRedoStacks[currentIndex];
  
  // Re-index keys
  let newStrokes = {};
  let newRedo = {};
  Object.keys(pageStrokes).forEach((k, i) => {
      if (i >= currentIndex) newStrokes[i] = pageStrokes[parseInt(k)+1] || [];
      else newStrokes[i] = pageStrokes[k];
  });
  pageStrokes = newStrokes;
  Object.keys(pageRedoStacks).forEach((k, i) => {
      if (i >= currentIndex) newRedo[i] = pageRedoStacks[parseInt(k)+1] || [];
      else newRedo[i] = pageRedoStacks[k];
  });
  pageRedoStacks = newRedo;

  if (currentIndex >= pages.length) {
    currentIndex = pages.length - 1;
  }

  renderPage();
  loadCurrentPageState();
}

function addBlankPage() {
  saveCurrentPageState();
  let g = currentGridType;
  if (pages[currentIndex] && pages[currentIndex].type !== "pdf") {
      g = pages[currentIndex].gridType !== undefined ? pages[currentIndex].gridType : currentGridType;
  }
  pages.splice(currentIndex + 1, 0, { type: "blank", gridType: g });
  
  // Shift keys
  for (let i = pages.length - 1; i > currentIndex + 1; i--) {
      pageStrokes[i] = pageStrokes[i-1];
      pageRedoStacks[i] = pageRedoStacks[i-1];
  }
  pageStrokes[currentIndex + 1] = [];
  pageRedoStacks[currentIndex + 1] = [];
  
  currentIndex++;
  renderPage();
  loadCurrentPageState();
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
    document.getElementById("fsBtn").innerText = "💢";
  } else {
    document.exitFullscreen();
    document.getElementById("fsBtn").innerText = "⛶";
  }
}

    // Date and time
    function updateDateTime() {
      const now = new Date();

      let hours = String(now.getHours()).padStart(2, '0');
      let minutes = String(now.getMinutes()).padStart(2, '0');
      document.getElementById('timeDisplay').innerText = `${hours}:${minutes}`;

      const options = { weekday: 'short', day: 'numeric', month: 'short' };
      document.getElementById('dateDisplay').innerText = now.toLocaleDateString('en-IN', options);
    }

    updateDateTime();
    setInterval(updateDateTime, 1000);

// --- SMOOTH PANNING ENGINE ---
let isAnimatingPan = false;
            syncBoardBackground();

function smoothMove(targetPanY) {
   if (isAnimatingPan) return;
   isAnimatingPan = true;
   
   let currentPanY = panY;
   let distance = targetPanY - currentPanY;
   let duration = 300;
   let startTime = performance.now();
   
   function anim(currentTime) {
       let elapsed = currentTime - startTime;
       let progress = Math.min(elapsed / duration, 1);
       
       let ease = 1 - Math.pow(1 - progress, 3);
       
       panY = currentPanY + (distance * ease);
       applyTransform();
       redraw([...undoStack, ...Array.from(activeTouches.values())]);
       
       if (progress < 1) {
           requestAnimationFrame(anim);
       } else {
           isAnimatingPan = false;
            syncBoardBackground();
       }
   }
   requestAnimationFrame(anim);
}

function slideUp() {
  let target = Math.min(panY + 250, 0);
  smoothMove(target);
}

function slideDown() {
  smoothMove(panY - 250);
}

// ==========================================
// CALCULATOR & TIMER & EXPORT LOGIC
// ==========================================

// Draggable Floating Panels
function makeDraggable(elmnt, header) {
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  const handle = document.getElementById(header) || elmnt;
  
  elmnt.style.touchAction = 'none'; // Prevent browser gestures on the panel

  handle.addEventListener('mousedown', startDragging);
  handle.addEventListener('touchstart', startDragging, { passive: false });

  function startDragging(e) {
    if (e.target.tagName.toLowerCase() === 'i') return;
    
    const clientX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX;
    const clientY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;

    pos3 = clientX;
    pos4 = clientY;
    
    if (e.type === 'mousedown') {
        document.addEventListener('mousemove', dragElement);
        document.addEventListener('mouseup', stopDragging);
    } else {
        document.addEventListener('touchmove', dragElement, { passive: false });
        document.addEventListener('touchend', stopDragging);
    }
  }

  function dragElement(e) {
    // Only prevent default if we're actually dragging to avoid blocking taps
    if (e.cancelable) e.preventDefault();

    const clientX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
    const clientY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;

    pos1 = pos3 - clientX;
    pos2 = pos4 - clientY;
    pos3 = clientX;
    pos4 = clientY;

    // Boundary check (optional but recommended for production)
    elmnt.style.top = (elmnt.offsetTop - pos2) + "px";
    elmnt.style.left = (elmnt.offsetLeft - pos1) + "px";
  }

  function stopDragging(e) {
    document.removeEventListener('mousemove', dragElement);
    document.removeEventListener('mouseup', stopDragging);
    document.removeEventListener('touchmove', dragElement);
    document.removeEventListener('touchend', stopDragging);
  }
}

makeDraggable(document.getElementById("floating-calc"), "calc-header");
makeDraggable(document.getElementById("floating-timer"), "timer-header");

// Calculator
function toggleCalc() {
    let el = document.getElementById("floating-calc");
    el.style.display = el.style.display === "none" ? "block" : "none";
}
function calcType(v) {
    let display = document.getElementById('calc-display');
    if (v === 'C') display.value = '';
    else display.value += v;
}
function calcEval() {
    let display = document.getElementById('calc-display');
    try {
        // Replace 'x' with '*' for internal eval
        let expr = display.value.replace(/x/g, '*');
        display.value = eval(expr);
    } catch(e) {
        display.value = 'Err';
    }
}

// Timer & Stopwatch
let timerInterval;
let timerTime = 0; // in seconds
let isStopwatch = true;

function toggleTimer() {
    let el = document.getElementById("floating-timer");
    el.style.display = el.style.display === "none" ? "block" : "none";
}
function setTimerMode(mode) {
    timerStop();
    isStopwatch = (mode === 'stopwatch');
    document.getElementById('timer-controls').style.display = isStopwatch ? 'none' : 'flex';
    if(isStopwatch) timerTime = 0;
    else timerTime = 300; // default 5 mins for timer mode
    formatTimer();
}
function adjTimer(secs) {
    if(!isStopwatch) {
        timerTime = Math.max(0, timerTime + secs);
        formatTimer();
    }
}
function formatTimer() {
    let h = Math.floor(timerTime / 3600);
    let m = Math.floor((timerTime % 3600) / 60);
    let s = timerTime % 60;
    document.getElementById('timer-display').innerText = 
        String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
}
function timerStart() {
    if (timerInterval) return;
    timerInterval = setInterval(() => { 
        if(isStopwatch) {
            timerTime++; 
        } else {
            if(timerTime > 0) timerTime--;
            else timerStop();
        }
        formatTimer(); 
    }, 1000);
}
function timerStop() {
    clearInterval(timerInterval);
    timerInterval = null;
}
function timerReset() {
    timerStop();
    if(isStopwatch) timerTime = 0;
    else timerTime = 300;
    formatTimer();
}

    function exportAsPDF() {
        const boardUrl = window.location.href;
        alert("Generating Combined PDF... This merge ensures shapes, pens, and backgrounds are saved as one.");
        let pdf = new jspdf.jsPDF('landscape');
        
        // Convert all pages
        addCanvasToPdfPage(pdf, 0, () => {
            let currentIdx = 1;
            function processNext() {
                if (currentIdx >= pages.length) {
                    document.getElementById('qrCodeContainer').innerHTML = "";
                    // For QR, we use the Board Session URL so students can scan to join
                    new QRCode(document.getElementById('qrCodeContainer'), {
                        text: boardUrl,
                        width: 200, height: 200,
                        colorDark : "#2b2b40", colorLight : "#ffffff"
                    });
                    document.getElementById('dlPdfBtn').onclick = () => pdf.save(`smartboard_lesson_${Date.now()}.pdf`);
                    document.getElementById('exportModal').classList.remove('hidden');
                    return;
                }
                processNextSub(pdf, currentIdx, () => {
                   currentIdx++;
                   processNext();
                });
            }
            if (pages.length > 1) processNext();
            else {
                // Single page case
                document.getElementById('qrCodeContainer').innerHTML = "";
                new QRCode(document.getElementById('qrCodeContainer'), { text: boardUrl, width: 200, height: 200 });
                document.getElementById('dlPdfBtn').onclick = () => pdf.save(`smartboard_lesson_${Date.now()}.pdf`);
                document.getElementById('exportModal').classList.remove('hidden');
            }
        });
    }

    // Helper for sequential processing
    function processNextSub(pdf, idx, done) {
        addCanvasToPdfPage(pdf, idx, done);
    }

  async function addCanvasToPdfPage(pdf, pageIdx, cb) {
  let originalIdx = currentIndex;
  currentIndex = pageIdx;
  
  await renderPage();
  loadCurrentPageState();
  
  setTimeout(() => {
    // Create base snapshot canvas
    let mCanvas = document.createElement('canvas');
    mCanvas.width = pdfCanvas.width;
    mCanvas.height = pdfCanvas.height;
    let mctx = mCanvas.getContext('2d');
    
    // Draw background
    mctx.drawImage(pdfCanvas, 0, 0);
    
    // Draw all annotations
    const strokes = pageStrokes[pageIdx] || [];
    mctx.save();
    mctx.lineCap = "round";
    let maxY = 0; // Track content depth to know where to stop paginating
    
    for (let s of strokes) {
        let strokeWidth = s.width;
        mctx.strokeStyle = s.color || "#000000";
        mctx.globalAlpha = 1;
        mctx.globalCompositeOperation = "source-over";

        if (s.tool === "erase") {
            mctx.globalCompositeOperation = "destination-out";
            mctx.lineWidth = strokeWidth * 2;
        } else if (s.tool === "highlight") {
            mctx.lineWidth = Math.max(strokeWidth, 20);
            mctx.globalAlpha = 0.4;
        } else {
            mctx.lineWidth = strokeWidth;
        }

        if (["draw", "erase", "highlight", "laser"].includes(s.tool)) {
            if (!s.path || s.path.length === 0) continue;
            mctx.beginPath();
            mctx.moveTo(s.path[0].x, s.path[0].y);
            for (let i = 1; i < s.path.length; i++) {
                mctx.lineTo(s.path[i].x, s.path[i].y);
                if (s.path[i].y > maxY) maxY = s.path[i].y;
            }
            mctx.stroke();
        } else if (s.tool === "rect" || s.tool === "circle" || s.tool === "line") {
            const x = Math.min(s.shape.x1, s.shape.x2);
            const y = Math.min(s.shape.y1, s.shape.y2);
            const w = Math.abs(s.shape.x2 - s.shape.x1);
            const h = Math.abs(s.shape.y2 - s.shape.y1);
            if (y + h > maxY) maxY = y + h;

            mctx.beginPath();
            if (s.tool === "rect") mctx.strokeRect(x, y, w, h);
            else if (s.tool === "circle") {
                const r = Math.sqrt(Math.pow(s.shape.x2 - s.shape.x1, 2) + Math.pow(s.shape.y2 - s.shape.y1, 2));
                mctx.arc(s.shape.x1, s.shape.y1, r, 0, Math.PI * 2);
            } else if (s.tool === "line") {
                mctx.moveTo(s.shape.x1, s.shape.y1);
                mctx.lineTo(s.shape.x2, s.shape.y2);
            }
            mctx.stroke();
        }
    }
    mctx.restore();

    // PAGINATION LOGIC
    // Standard landscape ratio 297:210. 
    // We slice by the relative height of the viewer at current page width.
    const sliceHeight = mCanvas.width * (210 / 297); 
    const isBlank = pages[pageIdx].type === 'blank' || pages[pageIdx].type === 'blackboard';
    
    // For PDFs/Images, we usually just want one page per slide.
    // For Blank/Blackboard, we use content height (maxY) to decide how many pages to slice.
    let totalHeight = isBlank ? Math.max(sliceHeight, maxY + 100) : mCanvas.height;
    let numPagesNeeded = Math.ceil(totalHeight / sliceHeight);
    
    // Safety limit
    if (numPagesNeeded > 50) numPagesNeeded = 50;

    for (let p = 0; p < numPagesNeeded; p++) {
        // Create a slice canvas for this specific PDF page
        let sCanvas = document.createElement('canvas');
        sCanvas.width = mCanvas.width;
        sCanvas.height = sliceHeight;
        let sctx = sCanvas.getContext('2d');
        
        // Background fill for blank slices (inherit blackboard color)
        sctx.fillStyle = mctx.fillStyle || "#121212";
        sctx.fillRect(0, 0, sCanvas.width, sCanvas.height);
        
        // Copy segment from master
        sctx.drawImage(mCanvas, 0, p * sliceHeight, mCanvas.width, sliceHeight, 0, 0, sCanvas.width, sliceHeight);
        
        // Add to PDF
        let imgData = sCanvas.toDataURL('image/jpeg', 0.85);
        if (pdf.internal.pages.length > 1) pdf.addPage('landscape'); 
        pdf.addImage(imgData, 'JPEG', 0, 0, 297, 210);
    }
    
    currentIndex = originalIdx;
    cb();
  }, 600);
}