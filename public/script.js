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

    // Restore session if returning from GATE explorer
    const savedPages = localStorage.getItem(`sb_pages_${currentBoardId}`);
    const savedStrokes = localStorage.getItem(`sb_strokes_${currentBoardId}`);
    if (savedPages && savedStrokes) {
        try {
            pages = JSON.parse(savedPages);
            pageStrokes = JSON.parse(savedStrokes);
            // Clear them so they don't persist forever
            localStorage.removeItem(`sb_pages_${currentBoardId}`);
            localStorage.removeItem(`sb_strokes_${currentBoardId}`);
        } catch(e) { console.error('Failed to restore session', e); }
    }
    currentIndex = 0;
    renderPage(); //page rendering for start
    // Live preview restriction removed as requested by user
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
    }

    // Handle questions sent from GATE Explorer
    const pending = localStorage.getItem('pendingQuestions');
    if (pending) {
        try {
            const questions = JSON.parse(pending);
            
            // If the board is fresh (1 blank page with no drawings), replace it.
            // Otherwise, append the questions to the end.
            const isFresh = (pages.length === 1 && pages[0].type === 'blank' && (!pageStrokes[0] || pageStrokes[0].length === 0));
            if (isFresh) {
                pages = [];
                pageStrokes = {};
                pageRedoStacks = {};
            }

            const startIndex = pages.length;
            questions.forEach(q => {
                pages.push({ 
                    type: 'question', 
                    gridType: 0, 
                    question: `GATE ${q.year} | ${q.subject}\n\n${q.question}` 
                });
                const newIdx = pages.length - 1;
                pageStrokes[newIdx] = [];
                pageRedoStacks[newIdx] = [];
            });
            localStorage.removeItem('pendingQuestions');
            currentIndex = startIndex;
            renderPage();
            loadCurrentPageState();
        } catch(e) { console.error('[Board] Error loading pending questions:', e); }
    }
});

    // Auto-trigger export if requested by Admin Panel
    if (urlParams.get('export') === 'true') {
        setTimeout(() => {
            exportAsPDF();
        }, 3000); // Wait 3 seconds for PDFs/Images to load before exporting
    }


async function loadPDFsForBoard() {
    if (!currentBoardId) return;

    const list = document.getElementById('dynamicPdfList');
    if (!list) return;

    // Always add navigation buttons regardless of network state
    list.innerHTML = '';
    const backBtn = document.createElement('button');
    backBtn.className = 'pdfBtn';
    backBtn.innerHTML = 'Home';
    backBtn.onclick = () => { window.location.href = 'index.html'; };
    list.appendChild(backBtn);

    const blankBtn = document.createElement('button');
    blankBtn.className = 'pdfBtn';
    blankBtn.innerHTML = 'Fresh Session';
    blankBtn.onclick = () => {
        pages = [{ type: 'blank', gridType: 0 }];
        currentIndex = 0;
        pageStrokes = { 0: [] };
        pageRedoStacks = { 0: [] };
        renderPage();
        loadCurrentPageState();
        document.getElementById('pdfLibrary').style.display = 'none';
    };
    list.appendChild(blankBtn);

    const gateBtn = document.createElement('button');
    gateBtn.className = 'pdfBtn';
    gateBtn.innerHTML = '<i class="fas fa-graduation-cap"></i> GATE Explorer';
    gateBtn.onclick = () => { 
        saveCurrentPageState();
        localStorage.setItem(`sb_pages_${currentBoardId}`, JSON.stringify(pages));
        localStorage.setItem(`sb_strokes_${currentBoardId}`, JSON.stringify(pageStrokes));
        window.location.href = 'gate.html'; 
    };
    list.appendChild(gateBtn);

    // Fetch file list with retry + timeout to handle Render cold starts
    let pdfs = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const controller = new AbortController();
            const tid = setTimeout(() => controller.abort(), 20_000); // 20s timeout
            const res = await fetch(
                `/api/board-files?board=${encodeURIComponent(currentBoardId)}&subject=${encodeURIComponent(currentSubject)}`,
                { signal: controller.signal }
            );
            clearTimeout(tid);
            if (!res.ok) throw new Error(`Server error ${res.status}`);
            pdfs = await res.json();
            break; // success
        } catch (err) {
            console.warn(`[Board] File list fetch attempt ${attempt}/3 failed: ${err.message}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 3000 * attempt));
            else {
                // Show a non-blocking error in the list (don't alert/crash)
                const errBtn = document.createElement('button');
                errBtn.className = 'pdfBtn';
                errBtn.style.color = '#f87171';
                errBtn.innerHTML = '⚠ Files unavailable — tap to retry';
                errBtn.onclick = () => loadPDFsForBoard();
                list.appendChild(errBtn);
                return;
            }
        }
    }

    pdfs.forEach(pdf => {
        const btn = document.createElement('button');
        btn.className = 'pdfBtn';
        const ext = pdf.filename.split('.').pop().toLowerCase();
        btn.innerText = pdf.original_name;
        btn.onclick = () => {
            if (['png','jpg','jpeg','gif','webp'].includes(ext)) {
                loadWebsiteImage('/uploads/' + pdf.filename);
            } else if (['mp4','webm','mov'].includes(ext)) {
                loadWebsiteVideo('/uploads/' + pdf.filename);
            } else if (ext === 'pdf') {
                loadWebsitePDF('/uploads/' + pdf.filename);
            } else {
                alert('This file (' + ext.toUpperCase() + ') is for reference.');
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

        // SYNC TO SERVER
        if (socket) {
            socket.emit('draw-stroke', { boardId: currentBoardId, pageIdx: currentIndex, stroke: stroke });
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
     const target = (typeof event !== 'undefined' && event && event.currentTarget) ? event.currentTarget : null;
     if (target) {
         target.classList.add("active-tool");
     }
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
    socket.emit('clear-board', { boardId: currentBoardId, pageIdx: currentIndex });
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
    
    // Sync after loading state to ensure the correct strokes are sent for this page
    syncBoardBackground();
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
   syncBoardBackground();
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

        } else if (page.type === "question") {
            // Set background size to fit screen perfectly
            pdfCanvas.width = window.innerWidth;
            pdfCanvas.height = window.innerHeight;
            
            // Fill background color
            pdfCtx.fillStyle = "#121212";
            pdfCtx.fillRect(0, 0, pdfCanvas.width, pdfCanvas.height);
            
            // Draw the Question Text
            pdfCtx.font = "bold 34px 'Inter', sans-serif";
            pdfCtx.fillStyle = "#ffffff";
            
            const margin = 100;
            const maxWidth = pdfCanvas.width - (margin * 2);
            let currentY = 150;

            const wrapText = (context, text, x, y, maxWidth, lineHeight) => {
                const words = text.split(' ');
                let line = '';
                for (let n = 0; n < words.length; n++) {
                    let testLine = line + words[n] + ' ';
                    let metrics = context.measureText(testLine);
                    if (metrics.width > maxWidth && n > 0) {
                        context.fillText(line, x, y);
                        line = words[n] + ' ';
                        y += lineHeight;
                    } else { line = testLine; }
                }
                context.fillText(line, x, y);
                return y + lineHeight;
            };

            const blocks = page.question.split('\n');
            blocks.forEach(block => {
                if (block.trim() === '') { currentY += 20; }
                else { currentY = wrapText(pdfCtx, block, margin, currentY, maxWidth, 55); }
            });

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
           const vw = window.innerWidth;
           const vh = window.innerHeight;
           pdfCanvas.width = vw;
           pdfCanvas.height = vh;
           drawCanvas.width = vw;
           drawCanvas.height = vh;
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
          let viewport = p.getViewport({ scale: 1.5 }); // Higher scale for better clarity
          pdfCanvas.width = viewport.width;
          pdfCanvas.height = viewport.height;
          drawCanvas.width = viewport.width;
          drawCanvas.height = viewport.height;
          await p.render({ canvasContext: pdfCtx, viewport: viewport }).promise;
        }
        
        document.getElementById("pageInfo").textContent =
          `Page ${currentIndex + 1} / ${pages.length}`;
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
            gridType: currentPage?.gridType !== undefined ? currentPage.gridType : currentGridType,
            question: currentPage?.question || null,
            panX: panX,
            panY: panY,
            zoom: zoom,
            strokes: undoStack
          });
        }
      }

      // ========== SOCKET LISTENERS ==========
      if (socket) {
          socket.on('draw-stroke', (data) => {
              if (!isLivePreview) return; 
              
              const { pageIdx, stroke } = data;
              
              // If the stroke is for a different page, just store it
              if (pageIdx !== currentIndex) {
                  if (!pageStrokes[pageIdx]) pageStrokes[pageIdx] = [];
                  pageStrokes[pageIdx].push(stroke);
                  return;
              }

              if (undoStack.some(s => s.id === stroke.id)) return;
              undoStack.push(stroke);
              redraw(undoStack);
          });

          socket.on('sync-background', async (data) => {
              if (!isLivePreview) return; 

              // Save current page state before switching
              saveCurrentPageState();

              // 1. Sync the view position
              panX = data.panX || 0;
              panY = data.panY || 0;
              zoom = data.zoom || 1;
              applyTransform();

              // 2. Sync the current page index and ensure pages array is large enough
              const newIdx = data.pageIndex;
              while (pages.length <= newIdx) {
                  pages.push({ type: 'blank', gridType: currentGridType });
              }
              currentIndex = newIdx;

              // 3. Sync the drawings for the NEW current page
              if (data.strokes) {
                  undoStack.length = 0; 
                  data.strokes.forEach(s => undoStack.push(s));
                  pageStrokes[currentIndex] = [...undoStack];
              }

              // 4. Sync the background content
              const targetBg = data.bgType || 'blank';
              if (!pages[currentIndex] || pages[currentIndex].type !== targetBg || pages[currentIndex].src !== data.fileUrl) {
                  pages[currentIndex] = { 
                      type: targetBg, 
                      src: data.fileUrl, 
                      question: data.question,
                      gridType: data.gridType !== undefined ? data.gridType : currentGridType
                  };
                  
                  if (data.fileUrl) {
                      if (targetBg === 'pdf') await loadWebsitePDF(data.fileUrl, true);
                      else if (targetBg === 'image') await loadWebsiteImage(data.fileUrl, true);
                  } else {
                      renderPage();
                  }
              } else {
                  renderPage();
              }
              
              // 5. Redraw everything so the pen marks appear on the new background
              redraw(undoStack); 
          });


          socket.on('init-strokes', (pagesObj) => {
              if (!isLivePreview) return; 
              
              // pagesObj is { 0: [strokes], 1: [strokes], ... }
              Object.keys(pagesObj).forEach(idx => {
                  pageStrokes[idx] = pagesObj[idx];
              });
              
              // Load the strokes for current page
              loadCurrentPageState();
          });

          socket.on('clear-board', (data) => {
              if (!isLivePreview) return;
              const { pageIdx } = data;
              
              if (pageIdx === currentIndex) {
                  undoStack.length = 0;
                  redraw(undoStack);
              }
              pageStrokes[pageIdx] = [];
          });
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

    // ═══════════════════════════════════════════
    // PDF EXPORT — FIXED VERSION
    // Fixes: timing, fill colour, circle maths, multi-page slicing
    // ═══════════════════════════════════════════
    function exportAsPDF() {
      saveCurrentPageState();
        const url = new URL(window.location.href);
        url.searchParams.set('export', 'true');
        const boardUrl = url.toString();
        const totalPages = pages.length;
        
        // Show progress to the user
        const exportBtn = document.querySelector('button[onclick="exportAsPDF()"]');
        if (exportBtn) { exportBtn.disabled = true; exportBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
        
        const pdf = new jspdf.jsPDF('landscape');

        (async () => {
          try {
            for (let idx = 0; idx < totalPages; idx++) {
                await addCanvasToPdfPage(pdf, idx, idx > 0);
            }
            await addThankYouPage(pdf);

            // QR + download
            document.getElementById('qrCodeContainer').innerHTML = '';
            new QRCode(document.getElementById('qrCodeContainer'), {
                text: boardUrl, width: 200, height: 200,
                colorDark: '#2b2b40', colorLight: '#ffffff'
            });
            // document.getElementById('dlPdfBtn').onclick = () =>
            //     pdf.save(`smartboard_lesson_${Date.now()}.pdf`);
            // document.getElementById('exportModal').classList.remove('hidden');
                        const fileName = `smartboard_lesson_${Date.now()}.pdf`;
            if (urlParams.get('export') === 'true') {
                pdf.save(fileName);
                setTimeout(() => window.close(), 2000);
            } else {
                document.getElementById('dlPdfBtn').onclick = () => pdf.save(fileName);
                document.getElementById('exportModal').classList.remove('hidden');
            }

          } catch(err) {
            console.error('[PDF Export]', err);
            alert('PDF export failed: ' + err.message);
          } finally {
            if (exportBtn) { exportBtn.disabled = false; exportBtn.innerHTML = '<i class="fas fa-file-export i-grey"></i><span class="lbl">Export</span>'; }
          }
        })();
    }

    /**
     * Renders one board page and adds it (possibly as multiple PDF pages) to `pdf`.
     *
     * KEY FIX: For blank/blackboard pages the canvas is the full viewport
     * (e.g. 1920 × 1080 px).  If content only occupies a 400 × 300 area in
     * the top-left corner, the old code would fit that enormous blank canvas
     * into one PDF page → tiny, unreadable output.
     *
     * Fix: compute the actual stroke bounding box, crop the canvas to that
     * region (+ padding), then scale the crop to fill the entire PDF page.
     */
    async function addCanvasToPdfPage(pdf, pageIdx, addPage) {
        const originalIdx = currentIndex;
        currentIndex = pageIdx;

        await renderPage();
        await new Promise(r => setTimeout(r, 700)); // let paint flush
        loadCurrentPageState();

        // ── Master canvas: background + all strokes ──────────────────────────
        const mCanvas = document.createElement('canvas');
        mCanvas.width  = pdfCanvas.width;
        mCanvas.height = pdfCanvas.height;
        const mctx = mCanvas.getContext('2d');
        mctx.drawImage(pdfCanvas, 0, 0);

        const strokes = pageStrokes[pageIdx] || [];

        // Track full bounding box (X and Y) for crop calculation
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        function expandBounds(x, y) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }

        mctx.save();
        mctx.lineCap = 'round';

        for (const s of strokes) {
            mctx.globalAlpha = 1;
            mctx.globalCompositeOperation = 'source-over';
            mctx.strokeStyle = s.color || '#ffffff';

            if (s.tool === 'erase') {
                mctx.globalCompositeOperation = 'destination-out';
                mctx.lineWidth = s.width * 2;
            } else if (s.tool === 'highlight') {
                mctx.lineWidth = Math.max(s.width, 20);
                mctx.globalAlpha = 0.4;
            } else {
                mctx.lineWidth = s.width;
            }

            if (['draw', 'erase', 'highlight', 'laser'].includes(s.tool)) {
                if (!s.path || s.path.length === 0) continue;
                mctx.beginPath();
                mctx.moveTo(s.path[0].x, s.path[0].y);
                for (let i = 1; i < s.path.length; i++) {
                    mctx.lineTo(s.path[i].x, s.path[i].y);
                    expandBounds(s.path[i].x, s.path[i].y);
                }
                expandBounds(s.path[0].x, s.path[0].y);
                mctx.stroke();
            } else if (s.tool === 'rect') {
                const x = Math.min(s.shape.x1, s.shape.x2);
                const y = Math.min(s.shape.y1, s.shape.y2);
                const w = Math.abs(s.shape.x2 - s.shape.x1);
                const h = Math.abs(s.shape.y2 - s.shape.y1);
                expandBounds(x, y); expandBounds(x + w, y + h);
                mctx.strokeRect(x, y, w, h);
            } else if (s.tool === 'circle') {
                const cx = s.shape.cx !== undefined ? s.shape.cx : (s.shape.x1 + s.shape.x2) / 2;
                const cy = s.shape.cy !== undefined ? s.shape.cy : (s.shape.y1 + s.shape.y2) / 2;
                const r  = s.shape.r  !== undefined ? s.shape.r  : Math.hypot(s.shape.x2 - s.shape.x1, s.shape.y2 - s.shape.y1) / 2;
                expandBounds(cx - r, cy - r); expandBounds(cx + r, cy + r);
                mctx.beginPath();
                mctx.arc(cx, cy, r, 0, Math.PI * 2);
                mctx.stroke();
            } else if (s.tool === 'line') {
                expandBounds(s.shape.x1, s.shape.y1);
                expandBounds(s.shape.x2, s.shape.y2);
                mctx.beginPath();
                mctx.moveTo(s.shape.x1, s.shape.y1);
                mctx.lineTo(s.shape.x2, s.shape.y2);
                mctx.stroke();
            } else if (s.tool === 'arrow') {
                const headLen = 15;
                const dx = s.shape.x2 - s.shape.x1;
                const dy = s.shape.y2 - s.shape.y1;
                const angle = Math.atan2(dy, dx);
                expandBounds(s.shape.x1, s.shape.y1);
                expandBounds(s.shape.x2, s.shape.y2);
                mctx.beginPath();
                mctx.moveTo(s.shape.x1, s.shape.y1);
                mctx.lineTo(s.shape.x2, s.shape.y2);
                mctx.moveTo(s.shape.x2 - headLen * Math.cos(angle - Math.PI/6), s.shape.y2 - headLen * Math.sin(angle - Math.PI/6));
                mctx.lineTo(s.shape.x2, s.shape.y2);
                mctx.lineTo(s.shape.x2 - headLen * Math.cos(angle + Math.PI/6), s.shape.y2 - headLen * Math.sin(angle + Math.PI/6));
                mctx.stroke();
            }
        }
        mctx.restore();

        // ── PDF page dimensions ───────────────────────────────────────────────
        const pdfPageW = pdf.internal.pageSize.getWidth();
        const pdfPageH = pdf.internal.pageSize.getHeight();
        const pdfAspect = pdfPageH / pdfPageW; // ~0.707 for A4 landscape

        const page    = pages[pageIdx];
        const isBlank = page.type === 'blank' || page.type === 'blackboard';
        const bgColor = (page.gridType === 2 || page.gridType === 3) ? '#ffffff' : '#121212';

        if (isBlank) {
            // ── CROP to content region (the KEY readability fix) ─────────────
            const PAD        = 60; // pixels padding around content
            const hasContent = maxX > minX && maxY > minY && strokes.length > 0;

            let cropX, cropY, cropW, cropH;
            if (hasContent) {
                cropX = Math.max(0, minX - PAD);
                cropY = Math.max(0, minY - PAD);
                cropW = Math.min(mCanvas.width,  maxX + PAD) - cropX;
                cropH = Math.min(mCanvas.height, maxY + PAD) - cropY;
            } else {
                // Blank with no strokes → export the visible viewport
                cropX = 0; cropY = 0;
                cropW = mCanvas.width; cropH = mCanvas.height;
            }

            // Expand crop to match PDF aspect ratio (avoids squished content)
            const cropAspect = cropH / cropW;
            if (cropAspect > pdfAspect) {
                // Content is taller → widen the crop
                const newW  = cropH / pdfAspect;
                const delta = newW - cropW;
                cropX = Math.max(0, cropX - delta / 2);
                cropW = Math.min(mCanvas.width - cropX, newW);
            } else {
                // Content is wider → heighten the crop
                const newH  = cropW * pdfAspect;
                const delta = newH - cropH;
                cropY = Math.max(0, cropY - delta / 2);
                cropH = Math.min(mCanvas.height - cropY, newH);
            }

            if (addPage) pdf.addPage('landscape');

            // Draw just the cropped region into a correctly-sized canvas
            const sCanvas = document.createElement('canvas');
            sCanvas.width  = Math.max(1, Math.round(cropW));
            sCanvas.height = Math.max(1, Math.round(cropH));
            const sctx = sCanvas.getContext('2d');
            sctx.fillStyle = bgColor;
            sctx.fillRect(0, 0, sCanvas.width, sCanvas.height);
            sctx.drawImage(
                mCanvas,
                cropX, cropY, cropW, cropH,  // source region
                0,     0,     sCanvas.width, sCanvas.height  // fill dest
            );

            const imgData = sCanvas.toDataURL('image/jpeg', 0.92);
            pdf.addImage(imgData, 'JPEG', 0, 0, pdfPageW, pdfPageH);

        } else {
            // ── PDF / Image pages: slice vertically into multiple PDF pages ──
            const sliceH    = Math.round(mCanvas.width * pdfAspect);
            const numSlices = Math.min(Math.ceil(mCanvas.height / sliceH), 50);

            for (let p = 0; p < numSlices; p++) {
                if (addPage || p > 0) pdf.addPage('landscape');

                const sCanvas = document.createElement('canvas');
                sCanvas.width  = mCanvas.width;
                sCanvas.height = sliceH;
                const sctx = sCanvas.getContext('2d');
                sctx.fillStyle = bgColor;
                sctx.fillRect(0, 0, sCanvas.width, sCanvas.height);
                sctx.drawImage(
                    mCanvas,
                    0, p * sliceH, mCanvas.width, sliceH,
                    0, 0,          sCanvas.width, sliceH
                );

                const imgData = sCanvas.toDataURL('image/jpeg', 0.92);
                pdf.addImage(imgData, 'JPEG', 0, 0, pdfPageW, pdfPageH);
            }
        }

        // Restore the board to where the user was
        currentIndex = originalIdx;
        await renderPage();
        loadCurrentPageState();
    }

    // Ensure globals for inline onclick handlers
    window.setTool = setTool;
    window.undo = undo;
    window.redo = redo;
    window.clearCanvas = clearCanvas;
    window.zoomIn = zoomIn;
    window.zoomOut = zoomOut;
    window.fit = fit;
    window.slideUp = slideUp;
    window.slideDown = slideDown;
    window.toggleFullscreen = toggleFullscreen;
    window.exportAsPDF = exportAsPDF;
    window.toggleStylusMode = toggleStylusMode;
    window.togglePDFLibrary = togglePDFLibrary;
    window.changeBrushSize = changeBrushSize;
    window.selectColor = selectColor;
    window.toggleColorPalette = toggleColorPalette;
    window.timerStart = timerStart;
    window.timerStop = timerStop;
    window.timerReset = timerReset;
    window.setTimerMode = setTimerMode;
    window.adjTimer = adjTimer;

    // ═══════════════════════════════════════════
    // DRAG AND DROP FILE UPLOAD
    // ═══════════════════════════════════════════
    const dropZone = document.createElement('div');
    dropZone.id = 'dropZoneOverlay';
    dropZone.style = `
        position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
        background: rgba(106, 106, 255, 0.2);
        backdrop-filter: blur(4px);
        border: 4px dashed #6a6aff;
        z-index: 10000;
        display: none;
        align-items: center;
        justify-content: center;
        color: white;
        font-size: 24px;
        font-weight: 700;
        pointer-events: none;
        transition: 0.3s;
    `;
    dropZone.innerHTML = '<div style="text-align:center;"><i class="fas fa-cloud-upload-alt" style="font-size:60px;margin-bottom:20px;"></i><br>Drop PDF or Image here</div>';
    document.body.appendChild(dropZone);

    window.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.style.display = 'flex';
    });

    window.addEventListener('dragleave', (e) => {
        if (e.relatedTarget === null || e.clientX <= 0 || e.clientY <= 0) {
            dropZone.style.display = 'none';
        }
    });

    window.addEventListener('drop', async (e) => {
        e.preventDefault();
        dropZone.style.display = 'none';

        const files = e.dataTransfer.files;
        if (files.length > 0) {
            const file = files[0];
            const ext = file.name.split('.').pop().toLowerCase();
            const isImg = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext);
            const isPdf = (ext === 'pdf');

            if (!isImg && !isPdf) {
                alert('Only PDF and Image files are supported for drag-and-drop.');
                return;
            }

            // Upload the file to the server
            const formData = new FormData();
            formData.append('file', file);
            formData.append('board_id', currentBoardId);
            formData.append('subject', currentSubject || 'Dropped File');

            const token = localStorage.getItem('sb_token') || sessionStorage.getItem('sb_admin_token');

            try {
                const res = await fetch('/api/upload', {
                    method: 'POST',
                    headers: {
                        'Authorization': 'Bearer ' + token
                    },
                    body: formData
                });
                const data = await res.json();
                if (res.ok && data.files && data.files.length > 0) {
                    const uploadedFile = data.files[0];
                    const url = '/uploads/' + uploadedFile.filename;
                    if (isPdf) {
                        loadWebsitePDF(url);
                    } else {
                        loadWebsiteImage(url);
                    }
                } else {
                    throw new Error(data.error || 'Upload failed');
                }
            } catch (err) {
                console.error('[Drop Upload]', err);
                alert('Failed to upload dropped file: ' + err.message);
            }
        }
    });

async function addThankYouPage(pdf) {
    pdf.addPage('portrait');
    const w = pdf.internal.pageSize.getWidth();
    const h = pdf.internal.pageSize.getHeight();

    // 1. Title - centered and bold
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(26);
    pdf.setTextColor(44, 62, 80);
    pdf.text("Thank You for Using SmartBoard", w/2, 45, { align: "center" });

    // 2. Elegant Divider Line
    pdf.setDrawColor(200, 200, 200);
    pdf.setLineWidth(0.5);
    pdf.line(w*0.25, 55, w*0.75, 55);

    // 3. Main Content - Grouped by spacing
    pdf.setTextColor(51, 51, 51);
    
    // Group A: Developer Info
    let y = 85;
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(16);
    pdf.text("Developed by", w/2, y, { align: "center" });
    
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(20);
    pdf.text("Gaurav Kumar", w/2, y + 10, { align: "center" });
    
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(14);
    pdf.text("Computer Science & Engineering (CSE)", w/2, y + 20, { align: "center" });
    pdf.text("Lok Nayak Jai Prakash Institute of Technology, Chhapra", w/2, y + 28, { align: "center" });

    // Group B: Mentor Info
    y += 55;
    pdf.setFontSize(16);
    pdf.text("Guided by", w/2, y, { align: "center" });
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(18);
    pdf.text("Prof. Shambhu Shankar Bharti", w/2, y + 10, { align: "center" });

    // 4. Footer Quote - Pushed further down to prevent overlap
    pdf.setFont("helvetica", "italic");
    pdf.setFontSize(15);
    pdf.setTextColor(120, 120, 120);
    pdf.text("“Keep learning, keep building, and keep growing.”", w/2, h - 35, { align: "center" });
}
