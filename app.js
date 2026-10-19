import { generateAll100Questions } from './questions.js';

// Application State (김민희, 양소희, 정호준, 차승우 4인 고정)
const FIXED_MEMBERS = ["김민희", "양소희", "정호준", "차승우"];
const DEFAULT_CODE = `import sys 

a = int(sys.stdin.readline()) 
b = int(sys.stdin.readline())

print(a + b)
`;

const STATE = {
  questions: [],
  currentQuestionId: 1,
  currentMember: "김민희",
  members: FIXED_MEMBERS,
  solutions: {}, // { [qId]: { [member]: code } }
  roomId: "codingmasters-team4",
  cloudBlobId: null, // 온라인 원격 저장소 Blob ID
  isDiffMode: false,
  pyodide: null,
  isPyodideReady: false,
  editor: null,
  diffMergeView: null,
  saveTimer: null,
  lastSavedAt: null
};

// LocalStorage Keys
const STORAGE_KEY_SOLUTIONS = "codingmasters_solutions_v2";
const STORAGE_KEY_ROOM = "codingmasters_room_id";
const STORAGE_KEY_BLOB_ID = "codingmasters_cloud_blob_id";

/* ==========================================================================
   Initialization
   ========================================================================== */
document.addEventListener("DOMContentLoaded", async () => {
  STATE.questions = generateAll100Questions();
  
  // 저장된 룸 ID 로드
  const savedRoom = localStorage.getItem(STORAGE_KEY_ROOM);
  if (savedRoom) STATE.roomId = savedRoom;

  const savedBlobId = localStorage.getItem(STORAGE_KEY_BLOB_ID);
  if (savedBlobId) STATE.cloudBlobId = savedBlobId;

  loadInitialData();
  initCodeMirror();
  initPyodide();
  renderCategoryFilter();
  renderSidebarQuestions();
  updateProgress();
  loadQuestion(1);

  setupEventListeners();

  // 클라우드 및 서버 동기화 시작
  initCloudSync();
});

/* ==========================================================================
   Data Loading & Normalization
   ========================================================================== */
function loadInitialData() {
  const localData = localStorage.getItem(STORAGE_KEY_SOLUTIONS);
  if (localData) {
    try {
      STATE.solutions = JSON.parse(localData);
    } catch (e) {
      console.error("로컬 풀이 파싱 에러", e);
    }
  }

  // 100문제 및 4인 팀원에 대해 기본 코드 보장
  STATE.questions.forEach(q => {
    if (!STATE.solutions[q.id]) {
      STATE.solutions[q.id] = {};
    }
    FIXED_MEMBERS.forEach(m => {
      if (!STATE.solutions[q.id][m]) {
        STATE.solutions[q.id][m] = DEFAULT_CODE;
      }
    });
  });
}

function saveLocal() {
  localStorage.setItem(STORAGE_KEY_SOLUTIONS, JSON.stringify(STATE.solutions));
  updateProgress();
}

/* ==========================================================================
   Cloud Sync & Auto-Save Anywhere (어디서나 자동 동기화)
   ========================================================================== */
// 1. 디바운스 자동 저장 (코드를 치면 1.2초 후 자동 저장 & 동기화)
function triggerAutoSave() {
  const tag = document.getElementById("autosave-status");
  tag.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 저장 중...`;
  tag.style.color = "var(--warning-color)";

  if (STATE.saveTimer) clearTimeout(STATE.saveTimer);

  STATE.saveTimer = setTimeout(async () => {
    saveLocal();
    await pushSync();
    tag.innerHTML = `<i class="fa-solid fa-cloud-check"></i> 저장됨`;
    tag.style.color = "var(--success-color)";
  }, 1200);
}

// 2. 클라우드/로컬 서버로 데이터 업로드 (PUSH)
async function pushSync() {
  const syncDot = document.getElementById("sync-dot");
  const syncText = document.getElementById("sync-text");

  const payload = {
    roomId: STATE.roomId,
    updatedAt: new Date().toISOString(),
    solutions: STATE.solutions
  };

  // A. 로컬 Python server.py 연결 시도
  try {
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      setSyncStatus("connected", "로컬/네트워크 저장 완료");
      return;
    }
  } catch (err) {
    // 로컬 서버가 아니거나 정적 호스팅인 경우 클라우드 스토리지로 진행
  }

  // B. 온라인 클라우드 스토리지 동기화 (JSONBlob 무료 오픈 API)
  try {
    if (STATE.cloudBlobId) {
      // 기존 클라우드 룸 업데이트
      const blobRes = await fetch(`https://jsonblob.com/api/jsonBlob/${STATE.cloudBlobId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (blobRes.ok) {
        setSyncStatus("connected", `클라우드 동기화 됨 (${new Date().toLocaleTimeString()})`);
        return;
      }
    }

    // 새 클라우드 룸 생성
    const createRes = await fetch("https://jsonblob.com/api/jsonBlob", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (createRes.ok) {
      const location = createRes.headers.get("Location") || "";
      const blobId = location.split("/").pop();
      if (blobId) {
        STATE.cloudBlobId = blobId;
        localStorage.setItem(STORAGE_KEY_BLOB_ID, blobId);
        setSyncStatus("connected", `클라우드 룸 생성 완료 (${blobId.slice(0, 6)}...)`);
      }
    }
  } catch (cloudErr) {
    console.warn("클라우드 업로드 일시 지연:", cloudErr);
    setSyncStatus("loading", "로컬 저장됨 (오프라인 모드)");
  }
}

// 3. 클라우드/서버에서 다른 팀원의 최신 코드 가져오기 (PULL)
async function fetchSync(silent = true) {
  let remoteData = null;

  // A. 로컬 server.py에서 시도
  try {
    const res = await fetch("/api/sync");
    if (res.ok) {
      const json = await res.json();
      if (json && json.solutions) {
        remoteData = json.solutions;
      }
    }
  } catch (e) {}

  // B. 클라우드 Blob에서 시도
  if (!remoteData && STATE.cloudBlobId) {
    try {
      const res = await fetch(`https://jsonblob.com/api/jsonBlob/${STATE.cloudBlobId}`);
      if (res.ok) {
        const json = await res.json();
        if (json && json.solutions) {
          remoteData = json.solutions;
        }
      }
    } catch (e) {}
  }

  if (remoteData) {
    let hasChanges = false;
    // 변경된 코드만 스마트 병합
    Object.keys(remoteData).forEach(qId => {
      if (!STATE.solutions[qId]) STATE.solutions[qId] = {};
      FIXED_MEMBERS.forEach(m => {
        // 내가 현재 수정 중인 탭의 코드가 아닌 경우에 안전하게 최신화
        if (m !== STATE.currentMember && remoteData[qId][m] && remoteData[qId][m] !== STATE.solutions[qId][m]) {
          STATE.solutions[qId][m] = remoteData[qId][m];
          hasChanges = true;
        }
      });
    });

    if (hasChanges) {
      saveLocal();
      if (STATE.isDiffMode) refreshDiffView();
      if (!silent) showToast("다른 팀원의 최신 풀이가 실시간 동기화되었습니다!");
    }
    setSyncStatus("connected", `동기화 됨 (${new Date().toLocaleTimeString()})`);
  }
}

function setSyncStatus(type, text) {
  const dot = document.getElementById("sync-dot");
  const label = document.getElementById("sync-text");
  dot.className = `status-dot ${type === "connected" ? "ready" : "loading"}`;
  label.textContent = text;
}

// 주기적 백그라운드 동기화 (5초마다)
function initCloudSync() {
  fetchSync(false);
  setInterval(() => {
    fetchSync(true);
  }, 5000);
}

/* ==========================================================================
   CodeMirror Setup (Ivory Light Theme)
   ========================================================================== */
function initCodeMirror() {
  const textarea = document.getElementById("code-editor");
  STATE.editor = CodeMirror.fromTextArea(textarea, {
    mode: "python",
    theme: "default",
    lineNumbers: true,
    autoCloseBrackets: true,
    indentUnit: 4,
    tabSize: 4,
    indentWithTabs: false,
    extraKeys: {
      "Ctrl-Enter": () => runCode(),
      "Cmd-Enter": () => runCode(),
      "Tab": (cm) => cm.replaceSelection("    ", "end")
    }
  });

  // 에디터 내용 변경 시 실시간 반영 & 자동 저장 트리거
  STATE.editor.on("change", () => {
    if (STATE.isDiffMode) return;
    const currentCode = STATE.editor.getValue();
    if (!STATE.solutions[STATE.currentQuestionId]) {
      STATE.solutions[STATE.currentQuestionId] = {};
    }
    STATE.solutions[STATE.currentQuestionId][STATE.currentMember] = currentCode;
    triggerAutoSave();
  });
}

/* ==========================================================================
   Pyodide Python 3 Execution (With sys.stdin simulation)
   ========================================================================== */
async function initPyodide() {
  const statusEl = document.getElementById("pyodide-status");
  try {
    // @ts-ignore
    STATE.pyodide = await loadPyodide({
      indexURL: "https://cdn.jsdelivr.net/pyodide/v0.25.0/full/"
    });
    STATE.isPyodideReady = true;

    statusEl.innerHTML = `
      <span class="status-dot ready"></span>
      <span class="status-text">Python 3.11 준비 완료</span>
    `;
    statusEl.title = "브라우저 내장 WebAssembly Python 준비 완료 (서버 통신 없이 즉시 실행)";
  } catch (error) {
    console.error("Pyodide 로드 에러:", error);
    statusEl.innerHTML = `
      <span class="status-dot" style="background: #dc2626;"></span>
      <span class="status-text">Python 로드 실패</span>
    `;
  }
}

async function runCode() {
  if (!STATE.isPyodideReady) {
    showToast("Python 엔진을 준비 중입니다. 잠시만 기다려주세요.");
    return;
  }

  const code = STATE.editor.getValue();
  const terminal = document.getElementById("terminal-output");
  const timeBadge = document.getElementById("run-time-badge");
  
  terminal.innerHTML = "";
  timeBadge.style.display = "inline-block";
  timeBadge.textContent = "실행 중...";

  const startTime = performance.now();

  try {
    // sys.stdin 및 stdout/stderr 시뮬레이션 환경 구성
    // 사용자의 기본 코드가 sys.stdin.readline()을 사용하므로 기본 입력값 "3\n5\n" 제공
    await STATE.pyodide.runPythonAsync(`
import sys
import io

# 입력 버퍼 및 출력 버퍼 가상화
sys.stdin = io.StringIO("3\\n5\\n10\\n20\\n")
sys.stdout = io.StringIO()
sys.stderr = io.StringIO()
    `);

    // 코드 실행
    await STATE.pyodide.runPythonAsync(code);

    const stdout = await STATE.pyodide.runPythonAsync("sys.stdout.getvalue()");
    const stderr = await STATE.pyodide.runPythonAsync("sys.stderr.getvalue()");

    const duration = (performance.now() - startTime).toFixed(1);
    timeBadge.textContent = `실행 시간: ${duration}ms`;

    if (stdout.trim()) {
      appendTerminal(stdout, "stdout");
    }
    if (stderr.trim()) {
      appendTerminal(stderr, "error");
    }
    if (!stdout.trim() && !stderr.trim()) {
      appendTerminal("실행이 성공적으로 완료되었습니다. (출력 없음)", "system");
    }

  } catch (err) {
    const duration = (performance.now() - startTime).toFixed(1);
    timeBadge.textContent = `실행 에러 (${duration}ms)`;
    appendTerminal(err.message, "error");
  }
}

function appendTerminal(text, type = "stdout") {
  const terminal = document.getElementById("terminal-output");
  const div = document.createElement("div");
  div.className = `terminal-line ${type}`;
  div.textContent = text;
  terminal.appendChild(div);
  terminal.scrollTop = terminal.scrollHeight;
}

/* ==========================================================================
   Question & 4-Member UI Rendering
   ========================================================================== */
function loadQuestion(id) {
  STATE.currentQuestionId = id;
  const q = STATE.questions.find(x => x.id === id);
  if (!q) return;

  // 헤더 정보 갱신
  document.getElementById("current-q-num").textContent = `Q. ${String(q.id).padStart(2, '0')}`;
  document.getElementById("current-q-title").textContent = q.title;
  
  const diffBadge = document.getElementById("current-q-diff");
  diffBadge.textContent = q.difficulty;
  diffBadge.className = `q-badge q-diff ${q.difficulty}`;

  document.getElementById("current-q-cat").textContent = q.category;
  document.getElementById("current-q-desc").innerHTML = q.desc;

  // 테스트케이스 렌더링
  renderTestCases(q.testCases);

  // 사이드바 하이라이트
  document.querySelectorAll(".q-item").forEach(item => {
    item.classList.toggle("active", Number(item.dataset.id) === id);
  });

  // 4인 팀원 탭 렌더링
  renderMemberTabs();

  // 에디터 코드 로드
  loadCurrentMemberCode();

  if (STATE.isDiffMode) {
    refreshDiffView();
  }
}

function loadCurrentMemberCode() {
  const qId = STATE.currentQuestionId;
  const member = STATE.currentMember;
  const code = (STATE.solutions[qId] && STATE.solutions[qId][member]) || DEFAULT_CODE;
  
  if (STATE.editor) {
    STATE.editor.setValue(code);
    STATE.editor.clearHistory();
  }
}

// 4명 고정 탭: 김민희, 양소희, 정호준, 차승우
function renderMemberTabs() {
  const container = document.getElementById("member-tabs");
  container.innerHTML = "";

  FIXED_MEMBERS.forEach(member => {
    const tab = document.createElement("div");
    tab.className = `member-tab ${member === STATE.currentMember ? "active" : ""}`;
    tab.innerHTML = `<i class="fa-solid fa-user-circle"></i> ${member}`;
    tab.addEventListener("click", () => {
      STATE.currentMember = member;
      renderMemberTabs();
      loadCurrentMemberCode();
    });
    container.appendChild(tab);
  });
}

function renderTestCases(testCases = []) {
  const container = document.getElementById("testcases-list");
  container.innerHTML = `
    <div class="tc-card">
      <div class="tc-info">
        <div><span class="tc-label">입력 스트림 (sys.stdin):</span> <span class="tc-val">a=3, b=5</span></div>
        <div><span class="tc-label">기대 출력:</span> <span class="tc-val">8</span></div>
      </div>
      <span class="tc-badge pass">준비 완료</span>
    </div>
  `;
}

function renderSidebarQuestions() {
  const listEl = document.getElementById("question-list");
  const searchQuery = document.getElementById("question-search").value.toLowerCase().trim();
  const filterDiff = document.getElementById("filter-difficulty").value;
  const filterCat = document.getElementById("filter-category").value;

  listEl.innerHTML = "";

  const filtered = STATE.questions.filter(q => {
    const matchSearch = String(q.id).includes(searchQuery) || q.title.toLowerCase().includes(searchQuery) || q.category.toLowerCase().includes(searchQuery);
    const matchDiff = filterDiff === "all" || q.difficulty === filterDiff;
    const matchCat = filterCat === "all" || q.category === filterCat;
    return matchSearch && matchDiff && matchCat;
  });

  filtered.forEach(q => {
    // 4명 중 한 명이라도 기본 코드가 아닌 수정 코드를 올렸으면 체크
    const isSolved = FIXED_MEMBERS.some(m => {
      const code = STATE.solutions[q.id] && STATE.solutions[q.id][m];
      return code && code.trim() !== "" && code !== DEFAULT_CODE;
    });

    const item = document.createElement("div");
    item.className = `q-item ${q.id === STATE.currentQuestionId ? "active" : ""}`;
    item.dataset.id = q.id;

    item.innerHTML = `
      <div class="q-item-info">
        <span class="badge-tag ${q.difficulty}">${q.difficulty}</span>
        <div class="q-item-title">${q.title}</div>
      </div>
      <div class="q-item-status">
        <span class="status-badge ${isSolved ? 'solved' : ''}">
          <i class="${isSolved ? 'fa-solid fa-circle-check' : 'fa-regular fa-circle'}"></i>
        </span>
      </div>
    `;

    item.addEventListener("click", () => {
      loadQuestion(q.id);
    });

    listEl.appendChild(item);
  });
}

function renderCategoryFilter() {
  const catSelect = document.getElementById("filter-category");
  const categories = [...new Set(STATE.questions.map(q => q.category))];
  
  categories.forEach(cat => {
    const opt = document.createElement("option");
    opt.value = cat;
    opt.textContent = cat;
    catSelect.appendChild(opt);
  });
}

function updateProgress() {
  let solvedCount = 0;
  STATE.questions.forEach(q => {
    const isSolved = FIXED_MEMBERS.some(m => {
      const code = STATE.solutions[q.id] && STATE.solutions[q.id][m];
      return code && code.trim() !== "" && code !== DEFAULT_CODE;
    });
    if (isSolved) solvedCount++;
  });

  const percent = Math.round((solvedCount / STATE.questions.length) * 100);
  document.getElementById("progress-percent").textContent = `${percent}%`;
  document.getElementById("progress-count").textContent = `${solvedCount} / ${STATE.questions.length} 완료`;
  document.getElementById("progress-fill").style.width = `${percent}%`;
}

/* ==========================================================================
   Side-by-Side Diff Comparison View
   ========================================================================== */
function toggleDiffMode() {
  STATE.isDiffMode = !STATE.isDiffMode;
  const standardView = document.getElementById("standard-view");
  const diffView = document.getElementById("diff-view");
  const toggleBtn = document.getElementById("btn-toggle-diff-mode");
  const modeText = document.getElementById("diff-mode-text");

  if (STATE.isDiffMode) {
    standardView.style.display = "none";
    diffView.style.display = "flex";
    modeText.textContent = "에디터 모드로 복귀";
    toggleBtn.classList.replace("btn-accent", "btn-secondary");
    
    populateDiffDropdowns();
    refreshDiffView();
  } else {
    diffView.style.display = "none";
    standardView.style.display = "flex";
    modeText.textContent = "코드 비교 모드";
    toggleBtn.classList.replace("btn-secondary", "btn-accent");

    loadCurrentMemberCode();
    setTimeout(() => STATE.editor.refresh(), 50);
  }
}

function populateDiffDropdowns() {
  const leftSelect = document.getElementById("diff-member-left");
  const rightSelect = document.getElementById("diff-member-right");

  leftSelect.innerHTML = "";
  rightSelect.innerHTML = "";

  FIXED_MEMBERS.forEach((m, idx) => {
    const opt1 = document.createElement("option");
    opt1.value = m;
    opt1.textContent = m;
    if (idx === 0) opt1.selected = true;
    leftSelect.appendChild(opt1);

    const opt2 = document.createElement("option");
    opt2.value = m;
    opt2.textContent = m;
    if (idx === 1) opt2.selected = true;
    rightSelect.appendChild(opt2);
  });
}

function refreshDiffView() {
  const container = document.getElementById("diff-editor-container");
  container.innerHTML = "";

  const memberLeft = document.getElementById("diff-member-left").value;
  const memberRight = document.getElementById("diff-member-right").value;
  const qId = STATE.currentQuestionId;

  const codeLeft = (STATE.solutions[qId] && STATE.solutions[qId][memberLeft]) || DEFAULT_CODE;
  const codeRight = (STATE.solutions[qId] && STATE.solutions[qId][memberRight]) || DEFAULT_CODE;

  // @ts-ignore
  STATE.diffMergeView = CodeMirror.MergeView(container, {
    value: codeLeft,
    origLeft: null,
    orig: codeRight,
    lineNumbers: true,
    mode: "python",
    theme: "default",
    highlightDifferences: true,
    connect: "align",
    collapseIdentical: false,
    allowEditingOriginals: false
  });
}

/* ==========================================================================
   Event Listeners
   ========================================================================== */
function setupEventListeners() {
  // Search & Filter
  document.getElementById("question-search").addEventListener("input", renderSidebarQuestions);
  document.getElementById("filter-difficulty").addEventListener("change", renderSidebarQuestions);
  document.getElementById("filter-category").addEventListener("change", renderSidebarQuestions);

  // Execution
  document.getElementById("btn-run-code").addEventListener("click", runCode);
  document.getElementById("btn-run-tests").addEventListener("click", runCode);
  document.getElementById("btn-clear-term").addEventListener("click", () => {
    document.getElementById("terminal-output").innerHTML = "";
  });

  // Diff Mode
  document.getElementById("btn-toggle-diff-mode").addEventListener("click", toggleDiffMode);
  document.getElementById("diff-member-left").addEventListener("change", refreshDiffView);
  document.getElementById("diff-member-right").addEventListener("change", refreshDiffView);

  // Sync Now Button
  document.getElementById("btn-sync-now").addEventListener("click", async () => {
    showToast("클라우드에서 최신 데이터를 가져오는 중...");
    await fetchSync(false);
    loadCurrentMemberCode();
    renderSidebarQuestions();
    showToast("동기화가 완료되었습니다.");
  });

  // Reset Template
  document.getElementById("btn-reset-template").addEventListener("click", () => {
    if (confirm("현재 작성 중인 코드를 디폴트 코드로 초기화하시겠습니까?")) {
      STATE.editor.setValue(DEFAULT_CODE);
      triggerAutoSave();
      showToast("코드가 디폴트로 초기화되었습니다.");
    }
  });

  // Copy Diff Right to Left
  document.getElementById("btn-copy-diff").addEventListener("click", () => {
    const memberLeft = document.getElementById("diff-member-left").value;
    const memberRight = document.getElementById("diff-member-right").value;
    const qId = STATE.currentQuestionId;

    const rightCode = STATE.solutions[qId] && STATE.solutions[qId][memberRight];
    if (rightCode) {
      if (confirm(`'${memberRight}'의 코드를 '${memberLeft}'의 답안으로 복사하여 덮어쓰시겠습니까?`)) {
        STATE.solutions[qId][memberLeft] = rightCode;
        triggerAutoSave();
        refreshDiffView();
        showToast("코드가 복사되어 저장되었습니다.");
      }
    }
  });

  // Room Settings Modal
  const modal = document.getElementById("settings-modal");
  document.getElementById("btn-room-settings").addEventListener("click", () => {
    document.getElementById("input-room-id").value = STATE.roomId;
    modal.style.display = "flex";
  });
  document.getElementById("btn-close-modal").addEventListener("click", () => {
    modal.style.display = "none";
  });
  document.getElementById("btn-save-settings").addEventListener("click", () => {
    const newRoom = document.getElementById("input-room-id").value.trim();
    if (newRoom) {
      STATE.roomId = newRoom;
      localStorage.setItem(STORAGE_KEY_ROOM, newRoom);
      pushSync();
      showToast(`동기화 룸 [${newRoom}] 설정 완료!`);
    }
    modal.style.display = "none";
  });

  // Export JSON
  document.getElementById("btn-export-data").addEventListener("click", () => {
    const exportData = {
      project: "Coding Masters 100 - 김민희, 양소희, 정호준, 차승우",
      exportedAt: new Date().toISOString(),
      members: FIXED_MEMBERS,
      solutions: STATE.solutions
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `CodingMasters_4인_풀이_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("전체 100문제 풀이 파일이 백업되었습니다.");
  });

  // Import JSON
  const fileInput = document.getElementById("file-import-input");
  document.getElementById("btn-import-data").addEventListener("click", () => {
    fileInput.click();
  });
  fileInput.addEventListener("change", (e) => {
    // @ts-ignore
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        // @ts-ignore
        const imported = JSON.parse(event.target.result);
        if (imported.solutions) {
          STATE.solutions = { ...STATE.solutions, ...imported.solutions };
          saveLocal();
          pushSync();
          loadQuestion(STATE.currentQuestionId);
          renderSidebarQuestions();
          showToast("풀이 데이터가 성공적으로 병합되었습니다!");
        }
      } catch (err) {
        alert("JSON 파싱 에러: " + err.message);
      }
    };
    reader.readAsText(file);
    fileInput.value = "";
  });
}

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => {
    toast.classList.remove("show");
  }, 2500);
}
