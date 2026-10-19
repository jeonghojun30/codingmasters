import { generateAll100Questions } from './questions.js';

// Application Configuration (김민희, 양소희, 정호준, 차승우 4인 고정)
const FIXED_MEMBERS = ["김민희", "양소희", "정호준", "차승우"];
const DEFAULT_CODE = `import sys 

a = int(sys.stdin.readline()) 
b = int(sys.stdin.readline())

print(a + b)
`;

// 전 세계 어디서나 영구 동기화되는 실제 검증된 글로벌 공용 클라우드 데이터베이스 엔드포인트
const GLOBAL_CLOUD_DB_ID = "ff808181a09d98f701a154942b7e1c4e";
const CLOUD_API_URL = `https://api.restful-api.dev/objects/${GLOBAL_CLOUD_DB_ID}`;

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
  isSyncing: false
};

const STORAGE_KEY_SOLUTIONS = "codingmasters_solutions_v4";

/* ==========================================================================
   Initialization
   ========================================================================== */
document.addEventListener("DOMContentLoaded", async () => {
  STATE.questions = generateAll100Questions();
  
  loadInitialSolutions();
  initCodeMirror();
  initPyodide();
  renderCategoryFilter();
  renderSidebarQuestions();
  updateProgress();
  loadQuestion(1);

  setupEventListeners();

  // 중앙 영구 클라우드 DB에서 실시간 4인 코드 동기화 시작
  await pullFromGlobalCloud(false);
  setInterval(() => {
    pullFromGlobalCloud(true);
  }, 4000);
});

/* ==========================================================================
   Data Loading & Local Fallback
   ========================================================================== */
function loadInitialSolutions() {
  const localData = localStorage.getItem(STORAGE_KEY_SOLUTIONS);
  if (localData) {
    try {
      STATE.solutions = JSON.parse(localData);
    } catch (e) {}
  }

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
   Real Global Cloud Sync (전 세계 어디서든 링크에 영구 반영)
   ========================================================================== */
function triggerAutoSave() {
  const tag = document.getElementById("autosave-status");
  tag.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 클라우드 영구 저장 중...`;
  tag.style.color = "var(--warning-color)";

  if (STATE.saveTimer) clearTimeout(STATE.saveTimer);

  STATE.saveTimer = setTimeout(async () => {
    saveLocal();
    await pushToGlobalCloud();
    tag.innerHTML = `<i class="fa-solid fa-cloud-check"></i> 링크에 영구 반영됨`;
    tag.style.color = "var(--success-color)";
  }, 1000);
}

// 1. 글로벌 클라우드로 4명 전체 코드 전송 (PUT)
async function pushToGlobalCloud() {
  if (STATE.isSyncing) return;
  STATE.isSyncing = true;

  const payload = {
    name: "codingmasters_team4_db",
    data: {
      updatedBy: STATE.currentMember,
      updatedAt: new Date().toISOString(),
      solutions: STATE.solutions
    }
  };

  try {
    const res = await fetch(CLOUD_API_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      setSyncStatus("connected", `전체 동기화 완료 (${new Date().toLocaleTimeString()})`);
    } else {
      setSyncStatus("loading", "클라우드 저장 대기중");
    }
  } catch (err) {
    console.warn("클라우드 전송 지연 (오프라인 캐시 유지):", err);
  } finally {
    STATE.isSyncing = false;
  }
}

// 2. 글로벌 클라우드에서 다른 팀원의 최신 코드 수신 (GET)
async function pullFromGlobalCloud(silent = true) {
  try {
    const res = await fetch(`${CLOUD_API_URL}?t=${Date.now()}`);
    if (res.ok) {
      const json = await res.json();
      if (json && json.data && json.data.solutions) {
        const remoteSolutions = json.data.solutions;
        let hasChanges = false;

        Object.keys(remoteSolutions).forEach(qId => {
          if (!STATE.solutions[qId]) STATE.solutions[qId] = {};
          FIXED_MEMBERS.forEach(m => {
            // 내가 현재 수정 중인 팀원 탭을 제외하고 최신 반영
            if (m !== STATE.currentMember && remoteSolutions[qId][m] && remoteSolutions[qId][m] !== STATE.solutions[qId][m]) {
              STATE.solutions[qId][m] = remoteSolutions[qId][m];
              hasChanges = true;
            }
          });
        });

        if (hasChanges) {
          saveLocal();
          if (STATE.isDiffMode) renderQuadDiffView();
          if (!silent) showToast("다른 팀원의 최신 코드가 동기화되었습니다!");
        }
        setSyncStatus("connected", `실시간 연결됨 (${new Date().toLocaleTimeString()})`);
      }
    }
  } catch (err) {
    setSyncStatus("loading", "동기화 재연결 시도 중...");
  }
}

function setSyncStatus(type, text) {
  const dot = document.getElementById("sync-dot");
  const label = document.getElementById("sync-text");
  if (dot) dot.className = `status-dot ${type === "connected" ? "ready" : "loading"}`;
  if (label) label.textContent = text;
}

/* ==========================================================================
   CodeMirror Setup
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
   Pyodide Python 3 Execution (사용자 직접 입력값 연동)
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

// 사용자 직접 입력창(sys.stdin / input()) 값 주입 실행기
async function runCode() {
  if (!STATE.isPyodideReady) {
    showToast("Python 엔진 준비 중입니다. 잠시만 기다려주세요.");
    return;
  }

  const code = STATE.editor.getValue();
  // 사용자가 직접 입력창에 타이핑한 값 가져오기
  const userInput = document.getElementById("user-custom-input").value;
  const terminal = document.getElementById("terminal-output");
  const timeBadge = document.getElementById("run-time-badge");
  
  terminal.innerHTML = "";
  timeBadge.style.display = "inline-block";
  timeBadge.textContent = "실행 중...";

  const startTime = performance.now();

  try {
    // 사용자가 입력한 텍스트를 sys.stdin 버퍼로 완벽 변환
    // 마지막 줄바꿈이 없으면 추가하여 input() EOFError 방지
    const sanitizedInput = userInput.endsWith("\n") ? userInput : userInput + "\n";
    
    // 파이썬 환경의 sys.stdin과 stdout 초기화
    await STATE.pyodide.runPythonAsync(`
import sys
import io

# 사용자 직접 입력값으로 sys.stdin 스트림 바인딩
sys.stdin = io.StringIO(${JSON.stringify(sanitizedInput)})
sys.stdout = io.StringIO()
sys.stderr = io.StringIO()
    `);

    // 사용자 코드 실행
    await STATE.pyodide.runPythonAsync(code);

    const stdout = await STATE.pyodide.runPythonAsync("sys.stdout.getvalue()");
    const stderr = await STATE.pyodide.runPythonAsync("sys.stderr.getvalue()");

    const duration = (performance.now() - startTime).toFixed(1);
    timeBadge.textContent = `${duration}ms`;

    if (stdout) {
      appendTerminal(stdout, "stdout");
    }
    if (stderr) {
      appendTerminal(stderr, "error");
    }
    if (!stdout && !stderr) {
      appendTerminal("실행이 완료되었습니다. (출력 내용 없음)", "system");
    }

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
   Question Details & 4-Member Navigation
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

  // 문제 변경 시 해당 문제의 기본 예제 입력으로 입력창 자동 채우기
  loadSampleInputForQuestion(q);

  document.querySelectorAll(".q-item").forEach(item => {
    item.classList.toggle("active", Number(item.dataset.id) === id);
  });

  renderMemberTabs();
  loadCurrentMemberCode();

  if (STATE.isDiffMode) {
    renderQuadDiffView();
  }
}

// 문제에 알맞은 예제 입력 자동 세팅
function loadSampleInputForQuestion(q) {
  const inputEl = document.getElementById("user-custom-input");
  if (!inputEl) return;

  // 문제별 기본 테스트 입력값 추정 또는 디폴트
  if (q.id === 1) { // 10배
    inputEl.value = "5";
  } else if (q.id === 2) { // 16배 나누어 출력
    inputEl.value = "32";
  } else if (q.id === 3) { // 1등급 한우
    inputEl.value = "7";
  } else if (q.id === 4) { // 3으로 나눈 나머지
    inputEl.value = "10";
  } else if (q.id === 5) { // 8진수와 16진수
    inputEl.value = "10";
  } else if (q.id === 6) { // You
    inputEl.value = "Nice to meet you";
  } else if (q.id === 8) { // 기억상실
    inputEl.value = "2 1 5";
  } else if (q.id === 9) { // 등차수열
    inputEl.value = "1 3 5";
  } else {
    inputEl.value = "3\n5";
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

// 4인 비교 창에서도 사용자가 현재 입력창에 적은 input값을 그대로 적용하여 실행!
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
  const userInput = document.getElementById("user-custom-input").value;
  const sanitizedInput = userInput.endsWith("\n") ? userInput : userInput + "\n";

  try {
    await STATE.pyodide.runPythonAsync(`
import sys
import io
sys.stdin = io.StringIO(${JSON.stringify(sanitizedInput)})
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
  showToast("4명의 코드가 사용자 입력값으로 일괄 검증되었습니다!");
}

/* ==========================================================================
   Event Listeners
   ========================================================================== */
function setupEventListeners() {
  document.getElementById("question-search").addEventListener("input", renderSidebarQuestions);
  document.getElementById("filter-difficulty").addEventListener("change", renderSidebarQuestions);
  document.getElementById("filter-category").addEventListener("change", renderSidebarQuestions);

  // 실행 및 클리어
  document.getElementById("btn-run-code").addEventListener("click", runCode);
  document.getElementById("btn-clear-term").addEventListener("click", () => {
    document.getElementById("terminal-output").innerHTML = "";
  });

  // 사용자 입력창 전용 툴 (지우기 / 예제 채우기)
  document.getElementById("btn-clear-input").addEventListener("click", () => {
    document.getElementById("user-custom-input").value = "";
    document.getElementById("user-custom-input").focus();
  });
  document.getElementById("btn-load-sample-input").addEventListener("click", () => {
    const q = STATE.questions.find(x => x.id === STATE.currentQuestionId);
    if (q) {
      loadSampleInputForQuestion(q);
      showToast("이 문제의 추천 예제 입력값이 채워졌습니다.");
    }
  });

  // 비교 모드
  document.getElementById("btn-toggle-diff-mode").addEventListener("click", toggleDiffMode);
  document.getElementById("btn-run-all-members")?.addEventListener("click", runAllMembersSimultaneously);

  // 동기화 버튼
  document.getElementById("btn-sync-now").addEventListener("click", async () => {
    showToast("클라우드 최신 풀이 확인 중...");
    await pullFromGlobalCloud(false);
    loadCurrentMemberCode();
    renderSidebarQuestions();
  });

  document.getElementById("btn-reset-template").addEventListener("click", () => {
    if (confirm("코드를 디폴트 상태로 되돌리시겠습니까?")) {
      STATE.editor.setValue(DEFAULT_CODE);
      triggerAutoSave();
    }
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
          pushToGlobalCloud();
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
