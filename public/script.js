// ========== AUTH & DASHBOARD STATE ==========
let jwtToken = localStorage.getItem('teacherToken');
let currentBoardId = null;
let uploadBoardId = null;

document.addEventListener("DOMContentLoaded", () => {
    pages = [{ type: "blank", gridType: 0 }];
    pageStrokes = { 0: [] };
    pageRedoStacks = { 0: [] };
    currentIndex = 0;

    if (jwtToken) {
        showDashboard();
    } else {
        document.getElementById('authModal').classList.remove('hidden');
        document.getElementById('dashboardModal').classList.add('hidden');
    }
});

// ========== AUTH FUNCTIONS ==========
async function login() {
    const email = document.getElementById('emailInput').value;
    const password = document.getElementById('passwordInput').value;
    const res = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
    });
    if (res.ok) {
        const data = await res.json();
        jwtToken = data.token;
        localStorage.setItem('teacherToken', jwtToken);
        showDashboard();
    } else {
        const err = await res.json();
        document.getElementById('authError').innerText = err.error || "Login failed";
    }
}

async function register() {
    const email = document.getElementById('emailInput').value;
    const password = document.getElementById('passwordInput').value;
    const res = await fetch('/api/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
    });
    if (res.ok) { login(); }
    else {
        const err = await res.json();
        document.getElementById('authError').innerText = err.error || "Registration failed";
    }
}

async function mockGoogleLogin() {
    const mockEmail = "teacher_google@university.edu";
    await fetch('/api/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: mockEmail, password: 'google_mock_password' })
    });
    const loginRes = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: mockEmail, password: 'google_mock_password' })
    });
    const data = await loginRes.json();
    if (data.token) {
        jwtToken = data.token;
        localStorage.setItem('teacherToken', jwtToken);
        showDashboard();
    }
}

function logout() {
    jwtToken = null;
    localStorage.removeItem('teacherToken');
    document.getElementById('authModal').classList.remove('hidden');
    document.getElementById('dashboardModal').classList.add('hidden');
}

function showDashboard() {
    document.getElementById('authModal').classList.add('hidden');
    document.getElementById('dashboardModal').classList.remove('hidden');
    loadBoards();
}

// ========== BOARD MANAGEMENT ==========
async function loadBoards() {
    const res = await fetch('/api/boards', { headers: { 'Authorization': `Bearer ${jwtToken}` }});
    if (res.status === 401 || res.status === 403) return logout();

    const boards = await res.json();
    const list = document.getElementById('boardList');
    list.innerHTML = "";

    if (boards.length === 0) {
        list.innerHTML = `<p style="color:#aaa; text-align:center; padding: 20px;">No boards created yet.</p>`;
        return;
    }

    boards.forEach(b => {
        const div = document.createElement('div');
        div.className = 'board-item';

        const header = document.createElement('div');
        header.className = 'board-header';

        const titleSpan = document.createElement('span');
        titleSpan.className = 'board-title';
        titleSpan.innerText = b.name;

        const badge = document.createElement('span');
        badge.className = 'board-badge';
        badge.innerText = b.subject || 'General';

        header.appendChild(titleSpan);
        header.appendChild(badge);

        const actions = document.createElement('div');
        actions.className = 'board-actions';

        const viewBtn = document.createElement('button');
        viewBtn.innerText = 'Go to Board';
        viewBtn.style.background = 'rgba(255,255,255,0.1)';
        viewBtn.onclick = () => openBoard(b.id);

        const uploadBtn = document.createElement('button');
        uploadBtn.innerText = 'Upload PDF';
        uploadBtn.onclick = () => {
            uploadBoardId = b.id;
            document.getElementById('fileInput').click();
        };

        const delBtn = document.createElement('button');
        delBtn.innerText = 'Delete';
        delBtn.className = 'btn-outline btn-danger';
        delBtn.onclick = () => deleteBoard(b.id);

        actions.appendChild(viewBtn);
        actions.appendChild(uploadBtn);
        actions.appendChild(delBtn);

        div.appendChild(header);
        div.appendChild(actions);
        list.appendChild(div);
    });
}

async function createBoard() {
    const name = document.getElementById('boardNameInput').value;
    const subject = document.getElementById('boardSubjectInput').value;
    if (!name) return alert("Please enter a board name");

    await fetch('/api/boards', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwtToken}` },
        body: JSON.stringify({ name, subject })
    });
    document.getElementById('boardNameInput').value = '';
    loadBoards();
}

async function deleteBoard(id) {
    if (!confirm("Are you sure you want to delete this board and its PDFs? This cannot be undone.")) return;
    await fetch(`/api/boards/${id}`, {
        method: 'DELETE', headers: { 'Authorization': `Bearer ${jwtToken}` }
    });
    loadBoards();
}

// File input handler for PDF upload
document.getElementById("fileInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file || !uploadBoardId || !jwtToken) return;

    const formData = new FormData();
    formData.append('pdf', file);
    formData.append('board_id', uploadBoardId);

    try {
        await fetch('/api/upload', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${jwtToken}` },
            body: formData
        });
        alert("PDF successfully uploaded to board!");
        // Refresh PDFs if we're currently on that board
        if (currentBoardId === uploadBoardId) {
            loadPDFsForBoard();
        }
    } catch (err) {
        console.error("Upload failed", err);
        alert("Upload failed.");
    }
    e.target.value = '';
});

// ========== OPEN BOARD (transition to canvas) ==========
function openBoard(boardId) {
    currentBoardId = boardId;
    document.getElementById('dashboardModal').classList.add('hidden');

    // Reset canvas state
    pages = [{ type: "blank", gridType: 0 }];
    pageStrokes = { 0: [] };
    pageRedoStacks = { 0: [] };
    currentIndex = 0;

    loadPDFsForBoard();
    renderPage();
    loadCurrentPageState();
}

async function loadPDFsForBoard() {
    if (!currentBoardId) return;
    const res = await fetch(`/api/boards/${currentBoardId}/pdfs`);
    const pdfs = await res.json();
    const list = document.getElementById('dynamicPdfList');
    if (!list) return;
    list.innerHTML = "";

    const backBtn = document.createElement('button');
    backBtn.className = 'pdfBtn';
    backBtn.innerText = '← Back to Dashboard';
    backBtn.onclick = () => {
        showDashboard();
    };
    list.appendChild(backBtn);

    const blankBtn = document.createElement('button');
    blankBtn.className = 'pdfBtn';
    blankBtn.innerText = 'Go to Blank Canvas';
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
        btn.innerText = pdf.original_name;
        btn.onclick = () => loadWebsitePDF('/uploads/' + pdf.filename);
        list.appendChild(btn);
    });
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
let color = "#ff0000";

// Canvas
const drawCanvas = document.getElementById("drawCanvas");
const ctx = drawCanvas.getContext("2d");
const viewer = document.getElementById("viewer");
const colorPicker = document.getElementById("colorPicker");
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
        tool: currentTool,
        color: colorPicker.value,
        width: w,
        timestamp: Date.now(),
        path: ["draw", "erase", "highlight", "laser"].includes(currentTool) ? [{ x: ex, y: ey }] : [],
        shape: !["draw", "erase", "highlight", "laser"].includes(currentTool) ? { x1: ex, y1: ey, x2: ex, y2: ey } : null,
      };
      activeTouches.set(e.pointerId, stroke);
    }

    if (currentTool === "pan") {
      panning = true;
      startX = e.clientX;
      startY = e.clientY;
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
        redoStack.length = 0;
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
  redraw([...undoStack, ...Array.from(activeTouches.values())]);
}
function zoomOut() {
  zoom = Math.max(0.4, zoom - 0.1);
  applyTransform();
  redraw([...undoStack, ...Array.from(activeTouches.values())]);
}
function fit() {
  zoom = 1;
  panX = 0;
  panY = 0;
  applyTransform();
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

      function renderPage() {
        clearDrawCanvas();
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
        } else {
          pdfDoc.getPage(page.num).then((p) => {
            let viewport = p.getViewport({ scale: 1 });
            pdfCanvas.width = viewport.width;
            pdfCanvas.height = viewport.height;
            p.render({ canvasContext: pdfCtx, viewport: viewport });
          });
        }
        document.getElementById("pageInfo").textContent =
          `Page ${currentIndex + 1} / ${pages.length}`;
      }

      let colorPaletteVisible = false;
      function toggleColorPalette() {
        const palette = document.getElementById("colorPalette");
        colorPaletteVisible = !colorPaletteVisible;
        palette.style.display = colorPaletteVisible ? "flex" : "none";
      }
      function selectColor(c) {
        document.getElementById("mainColorBtn").style.background = c;
        document.getElementById("colorPicker").value = c;
        toggleColorPalette();
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

          document.getElementById("pdfLibrary").style.display = "none";
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