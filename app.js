import { generateAll100Questions } from './questions.js';

// Application Configuration
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
  isDiffMode: false,
  pyodide: null,
  isPyodideReady: false,
  editor: null,
  saveTimer: null,
  
  // 영구 저장소 설정
  syncConfig: {
    type: "firebase", // 'firebase' | 'github' | 'local'
    firebaseUrl: "https://codingmasters-team4-default-rtdb.firebaseio.com", // 기본 실시간 DB
    githubRepo: "jeonghojun30/codingmasters",
    githubToken: "",
    githubSha: null
  }
};

const STORAGE_KEY_SOLUTIONS = "codingmasters_solutions_v3";
const STORAGE_KEY_SYNC_CFG = "codingmasters_sync_cfg_v1";

/* ==========================================================================
   Initialization
   ========================================================================== */
document.addEventListener("DOMContentLoaded", async () => {
  STATE.questions = generateAll100Questions();
  
  loadSyncConfig();
  loadInitialSolutions();

  initCodeMirror();
  initPyodide();
  renderCategoryFilter();
  renderSidebarQuestions();
  updateProgress();
  loadQuestion(1);

  setupEventListeners();

  // 중앙 영구 저장소에서 최신 데이터 즉시 로드 & 자동 폴링
  syncFromCloud();
  setInterval(() => {
    syncFromCloud(true);
  }, 4000);
});

/* ==========================================================================
   Sync Configuration & Local Cache
   ========================================================================== */
function loadSyncConfig() {
  const savedCfg = localStorage.getItem(STORAGE_KEY_SYNC_CFG);
  if (savedCfg) {
    try {
      STATE.syncConfig = { ...STATE.syncConfig, ...JSON.parse(savedCfg) };
    } catch (e) {}
  }
}

function saveSyncConfig() {
  localStorage.setItem(STORAGE_KEY_SYNC_CFG, JSON.stringify(STATE.syncConfig));
}

function loadInitialSolutions() {
  const localData = localStorage.getItem(STORAGE_KEY_SOLUTIONS);
  if (localData) {
    try {
      STATE.solutions = JSON.parse(localData);
    } catch (e) {}
  }

  // 100문제 및 4인 팀원에 대해 기본 코드 보장
  STATE.questions.forEach(q => {
    if (!STATE.solutions[q.id]) STATE.solutions[q.id] = {};
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
   Permanent Cloud Sync Engine (깃허브 링크 영구 반영 엔진)
   ========================================================================== */
// 디바운스 자동 저장 (코딩 멈춘 후 1초 뒤 클라우드에 영구 푸시)
function triggerAutoSave() {
  const tag = document.getElementById("autosave-status");
  tag.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 영구 저장 중...`;
  tag.style.color = "var(--warning-color)";

  if (STATE.saveTimer) clearTimeout(STATE.saveTimer);

  STATE.saveTimer = setTimeout(async () => {
    saveLocal();
    await pushToCloud();
    tag.innerHTML = `<i class="fa-solid fa-cloud-check"></i> 링크에 영구 반영됨`;
    tag.style.color = "var(--success-color)";
  }, 1000);
}

// 1. 클라우드에 전체 저장 (PUSH)
async function pushToCloud() {
  const payload = {
    project: "jeonghojun30_codingmasters",
    updatedAt: new Date().toISOString(),
    solutions: STATE.solutions
  };

  // A. GitHub Repository Contents API (깃허브 레포지토리에 직접 commit)
  if (STATE.syncConfig.githubToken && STATE.syncConfig.githubRepo) {
    try {
      const contentBase64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2))));
      const body = {
        message: `Auto-save team solutions by ${STATE.currentMember}`,
        content: contentBase64
      };
      if (STATE.syncConfig.githubSha) {
        body.sha = STATE.syncConfig.githubSha;
      }

      const res = await fetch(`https://api.github.com/repos/${STATE.syncConfig.githubRepo}/contents/solutions.json`, {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${STATE.syncConfig.githubToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      if (res.ok) {
        const json = await res.json();
        STATE.syncConfig.githubSha = json.content.sha;
        saveSyncConfig();
        setSyncStatus("connected", `GitHub에 영구 커밋됨 (${new Date().toLocaleTimeString()})`);
        return;
      }
    } catch (e) {
      console.warn("GitHub API 동기화 에러:", e);
    }
  }

  // B. Firebase Realtime Database / Global REST Endpoint
  if (STATE.syncConfig.firebaseUrl) {
    try {
      const url = STATE.syncConfig.firebaseUrl.replace(/\/$/, "") + "/codingmasters.json";
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        setSyncStatus("connected", `클라우드 링크에 영구 저장됨 (${new Date().toLocaleTimeString()})`);
        return;
      }
    } catch (e) {
      console.warn("Firebase 동기화 일시 지연:", e);
    }
  }

  // C. 로컬 server.py (로컬 환경일 때)
  try {
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      setSyncStatus("connected", "로컬 DB 영구 저장 완료");
    }
  } catch (e) {}
}

// 2. 클라우드에서 전체 로드 (PULL)
async function syncFromCloud(silent = false) {
  let remoteData = null;

  // A. GitHub 레포지토리 solutions.json 확인
  if (STATE.syncConfig.githubRepo) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${STATE.syncConfig.githubRepo}/main/solutions.json?t=${Date.now()}`);
      if (res.ok) {
        const json = await res.json();
        if (json && json.solutions) remoteData = json.solutions;
      }
    } catch (e) {}
  }

  // B. Firebase Realtime Database 확인
  if (!remoteData && STATE.syncConfig.firebaseUrl) {
    try {
      const url = STATE.syncConfig.firebaseUrl.replace(/\/$/, "") + "/codingmasters.json?t=" + Date.now();
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        if (json && json.solutions) remoteData = json.solutions;
      }
    } catch (e) {}
  }

  // C. 로컬 server.py 확인
  if (!remoteData) {
    try {
      const res = await fetch("/api/sync");
      if (res.ok) {
        const json = await res.json();
        if (json && json.solutions) remoteData = json.solutions;
      }
    } catch (e) {}
  }

  if (remoteData) {
    let hasChanges = false;
    Object.keys(remoteData).forEach(qId => {
      if (!STATE.solutions[qId]) STATE.solutions[qId] = {};
      FIXED_MEMBERS.forEach(m => {
        // 내가 지금 타이핑하고 있는 탭이 아닌 다른 팀원의 최신 풀이를 갱신
        if (m !== STATE.currentMember && remoteData[qId][m] && remoteData[qId][m] !== STATE.solutions[qId][m]) {
          STATE.solutions[qId][m] = remoteData[qId][m];
          hasChanges = true;
        }
      });
    });

    if (hasChanges) {
      saveLocal();
      if (STATE.isDiffMode) renderQuadDiffView();
      if (!silent) showToast("다른 팀원의 최신 풀이가 실시간 동기화되었습니다!");
    }
    setSyncStatus("connected", `실시간 동기화 활성 (${new Date().toLocaleTimeString()})`);
  }
}

function setSyncStatus(type, text) {
  const dot = document.getElementById("sync-dot");
  const label = document.getElementById("sync-text");
  if (dot) dot.className = `status-dot ${type === "connected" ? "ready" : "loading"}`;
  if (label) label.textContent = text;
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
   Pyodide Python 3 Execution
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
  } catch (error) {
    statusEl.innerHTML = `
      <span class="status-dot" style="background: #dc2626;"></span>
      <span class="status-text">Python 로드 실패</span>
    `;
  }
}

async function runCode() {
  if (!STATE.isPyodideReady) {
    showToast("Python 엔진 준비 중입니다.");
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
    await STATE.pyodide.runPythonAsync(`
import sys
import io
sys.stdin = io.StringIO("3\\n5\\n10\\n20\\n")
sys.stdout = io.StringIO()
sys.stderr = io.StringIO()
    `);

    await STATE.pyodide.runPythonAsync(code);
    const stdout = await STATE.pyodide.runPythonAsync("sys.stdout.getvalue()");
    const stderr = await STATE.pyodide.runPythonAsync("sys.stderr.getvalue()");

    const duration = (performance.now() - startTime).toFixed(1);
    timeBadge.textContent = `${duration}ms`;

    if (stdout.trim()) appendTerminal(stdout, "stdout");
    if (stderr.trim()) appendTerminal(stderr, "error");
    if (!stdout.trim() && !stderr.trim()) appendTerminal("정상 실행 완료 (출력 없음)", "system");

  } catch (err) {
    const duration = (performance.now() - startTime).toFixed(1);
    timeBadge.textContent = `에러 (${duration}ms)`;
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
   Question & 4-Member UI
   ========================================================================== */
function loadQuestion(id) {
  STATE.currentQuestionId = id;
  const q = STATE.questions.find(x => x.id === id);
  if (!q) return;

  document.getElementById("current-q-num").textContent = `Q. ${String(q.id).padStart(2, '0')}`;
  document.getElementById("current-q-title").textContent = q.title;
  
  const diffBadge = document.getElementById("current-q-diff");
  diffBadge.textContent = q.difficulty;
  diffBadge.className = `q-badge q-diff ${q.difficulty}`;

  document.getElementById("current-q-cat").textContent = q.category;
  document.getElementById("current-q-desc").innerHTML = q.desc;

  document.querySelectorAll(".q-item").forEach(item => {
    item.classList.toggle("active", Number(item.dataset.id) === id);
  });

  renderMemberTabs();
  loadCurrentMemberCode();

  if (STATE.isDiffMode) {
    renderQuadDiffView();
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
   4-Member Quad Comparison View
   ========================================================================== */
const quadEditors = {};

function toggleDiffMode() {
  STATE.isDiffMode = !STATE.isDiffMode;
  const standardView = document.getElementById("standard-view");
  const diffView = document.getElementById("diff-view");
  const toggleBtn = document.getElementById("btn-toggle-diff-mode");
  const modeText = document.getElementById("diff-mode-text");

  if (STATE.isDiffMode) {
    standardView.style.display = "none";
    diffView.style.display = "flex";
    modeText.textContent = "단일 에디터로 복귀";
    toggleBtn.classList.replace("btn-accent", "btn-secondary");
    renderQuadDiffView();
  } else {
    diffView.style.display = "none";
    standardView.style.display = "flex";
    modeText.textContent = "4인 전체 비교 모드";
    toggleBtn.classList.replace("btn-secondary", "btn-accent");
    loadCurrentMemberCode();
    setTimeout(() => STATE.editor.refresh(), 50);
  }
}

function renderQuadDiffView() {
  const container = document.getElementById("quad-diff-container");
  container.innerHTML = "";
  const qId = STATE.currentQuestionId;

  FIXED_MEMBERS.forEach(member => {
    const card = document.createElement("div");
    card.className = "quad-card";
    const code = (STATE.solutions[qId] && STATE.solutions[qId][member]) || DEFAULT_CODE;

    card.innerHTML = `
      <div class="quad-card-header">
        <span class="quad-member-name"><i class="fa-solid fa-user"></i> ${member}</span>
        <div class="quad-card-tools">
          <button class="btn btn-sm btn-secondary btn-copy-member" data-member="${member}" title="코드 복사">
            <i class="fa-solid fa-copy"></i> 복사
          </button>
          <button class="btn btn-sm btn-primary btn-run-member" data-member="${member}" title="이 코드만 단독 실행">
            <i class="fa-solid fa-play"></i> 실행
          </button>
        </div>
      </div>
      <div class="quad-editor-body">
        <textarea id="quad-editor-${member}"></textarea>
      </div>
      <div class="quad-output-bar" id="quad-out-${member}">대기중 (실행 결과가 여기에 표시됩니다)</div>
    `;

    container.appendChild(card);

    setTimeout(() => {
      const textarea = document.getElementById(`quad-editor-${member}`);
      if (textarea) {
        const cm = CodeMirror.fromTextArea(textarea, {
          mode: "python",
          theme: "default",
          lineNumbers: true,
          autoCloseBrackets: true,
          indentUnit: 4,
          tabSize: 4
        });
        cm.setValue(code);

        cm.on("change", () => {
          if (!STATE.solutions[qId]) STATE.solutions[qId] = {};
          STATE.solutions[qId][member] = cm.getValue();
          triggerAutoSave();
        });

        quadEditors[member] = cm;
      }
    }, 20);
  });

  setTimeout(() => {
    document.querySelectorAll(".btn-copy-member").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const member = e.currentTarget.dataset.member;
        const code = quadEditors[member] ? quadEditors[member].getValue() : "";
        navigator.clipboard.writeText(code);
        showToast(`${member}의 코드가 복사되었습니다!`);
      });
    });

    document.querySelectorAll(".btn-run-member").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const member = e.currentTarget.dataset.member;
        await runSingleMemberCode(member);
      });
    });
  }, 50);
}

async function runSingleMemberCode(member) {
  if (!STATE.isPyodideReady) {
    showToast("Python 준비 중...");
    return;
  }

  const outBar = document.getElementById(`quad-out-${member}`);
  if (!outBar) return;
  outBar.textContent = "실행 중...";
  outBar.style.color = "#d97706";

  const code = quadEditors[member] ? quadEditors[member].getValue() : DEFAULT_CODE;

  try {
    await STATE.pyodide.runPythonAsync(`
import sys
import io
sys.stdin = io.StringIO("3\\n5\\n10\\n20\\n")
sys.stdout = io.StringIO()
sys.stderr = io.StringIO()
    `);

    await STATE.pyodide.runPythonAsync(code);
    const stdout = await STATE.pyodide.runPythonAsync("sys.stdout.getvalue()");
    const stderr = await STATE.pyodide.runPythonAsync("sys.stderr.getvalue()");

    if (stderr.trim()) {
      outBar.textContent = `[에러] ${stderr.trim().split("\n").pop()}`;
      outBar.style.color = "#ff7b72";
    } else if (stdout.trim()) {
      outBar.textContent = `[출력] ${stdout.trim().replace(/\n/g, " | ")}`;
      outBar.style.color = "#58a6ff";
    } else {
      outBar.textContent = "[정상 완료] 출력 없음";
      outBar.style.color = "#3fb950";
    }
  } catch (err) {
    outBar.textContent = `[예외] ${err.message.split("\n")[0]}`;
    outBar.style.color = "#ff7b72";
  }
}

async function runAllMembersSimultaneously() {
  for (const m of FIXED_MEMBERS) {
    await runSingleMemberCode(m);
  }
  showToast("4명의 코드가 모두 실행되었습니다!");
}

/* ==========================================================================
   Event Listeners
   ========================================================================= */
function setupEventListeners() {
  document.getElementById("question-search").addEventListener("input", renderSidebarQuestions);
  document.getElementById("filter-difficulty").addEventListener("change", renderSidebarQuestions);
  document.getElementById("filter-category").addEventListener("change", renderSidebarQuestions);

  document.getElementById("btn-run-code").addEventListener("click", runCode);
  document.getElementById("btn-run-tests").addEventListener("click", runCode);
  document.getElementById("btn-clear-term").addEventListener("click", () => {
    document.getElementById("terminal-output").innerHTML = "";
  });

  document.getElementById("btn-toggle-diff-mode").addEventListener("click", toggleDiffMode);
  document.getElementById("btn-run-all-members")?.addEventListener("click", runAllMembersSimultaneously);

  document.getElementById("btn-sync-now").addEventListener("click", async () => {
    showToast("클라우드 최신 풀이 확인 중...");
    await syncFromCloud(false);
    loadCurrentMemberCode();
    renderSidebarQuestions();
  });

  document.getElementById("btn-reset-template").addEventListener("click", () => {
    if (confirm("코드를 디폴트 상태로 되돌리시겠습니까?")) {
      STATE.editor.setValue(DEFAULT_CODE);
      triggerAutoSave();
    }
  });

  // Settings Modal
  const modal = document.getElementById("settings-modal");
  document.getElementById("btn-room-settings").addEventListener("click", () => {
    modal.style.display = "flex";
  });
  document.getElementById("btn-close-modal").addEventListener("click", () => {
    modal.style.display = "none";
  });
  document.getElementById("btn-save-settings").addEventListener("click", () => {
    modal.style.display = "none";
    pushToCloud();
    showToast("영구 저장소 설정이 적용되었습니다!");
  });

  // JSON Export / Import
  document.getElementById("btn-export-data").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({
      project: "Coding Masters 100",
      members: FIXED_MEMBERS,
      solutions: STATE.solutions
    }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `CodingMasters_4인_전체풀이_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("100문제 풀이 파일이 다운로드되었습니다.");
  });

  const fileInput = document.getElementById("file-import-input");
  document.getElementById("btn-import-data").addEventListener("click", () => fileInput.click());
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
          pushToCloud();
          loadQuestion(STATE.currentQuestionId);
          renderSidebarQuestions();
          showToast("풀이 파일이 클라우드와 로컬에 완벽히 병합되었습니다!");
        }
      } catch (err) {
        alert("파싱 에러: " + err.message);
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
  setTimeout(() => toast.classList.remove("show"), 2500);
}
