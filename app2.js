/* ===== Cash Flow Monitoring System ===== */

// GitHub 저장소 설정: 이 폴더에 매달 엑셀을 올리면 월별 히스토리로 자동 집계됩니다
const GH_OWNER = "telstar72-commits";
const GH_REPO = "CMS";
const GH_BRANCH = "main";
const GH_DATA_DIR = "data"; // 저장소 안에 만들 폴더명

// 컬럼 이름 유연 매칭
const COL = {
  customer: ["고객사"],
  category: ["구분"],
  projectAmount: ["프로젝트금액", "프로젝트 금액"],
  invoiceDate: ["세금계산서발행", "세금계산서 발행", "세금계산서발행일", "계금계산서발행", "게금계산서발행"],
  amount: ["금액"],
  received: ["수금액"],
  unpaid: ["미결제금액(TC)", "미결제금액", "미결재금액(TC)", "미결재금액", "미수금(TC)", "미수금"],
  project: ["프로젝트번호", "발주번호"],
};

const won = n => "₩" + Math.round(n || 0).toLocaleString("ko-KR");
const wonSigned = n => (n >= 0 ? "+" : "−") + "₩" + Math.abs(Math.round(n || 0)).toLocaleString("ko-KR");

// 정확 일치만 허용할 컬럼 (부분일치 시 다른 컬럼에 잘못 걸리는 것 방지)
// 예: "금액"은 "프로젝트금액"에 부분일치하면 안 됨
const EXACT_ONLY = new Set(["amount"]);

function mapHeader(headerRow) {
  const norm = s => String(s ?? "").replace(/\s/g, "");
  const idx = {};
  // 1차: 모든 컬럼을 정확 일치로 먼저 잡는다
  for (const key in COL) {
    idx[key] = -1;
    for (let c = 0; c < headerRow.length; c++) {
      if (COL[key].some(name => norm(headerRow[c]) === norm(name))) { idx[key] = c; break; }
    }
  }
  // 2차: 정확 일치로 못 잡은 컬럼만 부분 일치 허용 (단 EXACT_ONLY 제외)
  for (const key in COL) {
    if (idx[key] >= 0 || EXACT_ONLY.has(key)) continue;
    for (let c = 0; c < headerRow.length; c++) {
      if (COL[key].some(name => norm(headerRow[c]).includes(norm(name)))) { idx[key] = c; break; }
    }
  }
  return idx;
}

function findHeaderRow(rows) {
  const norm = s => String(s ?? "").replace(/\s/g, "");
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const cells = rows[r].map(norm);
    if (cells.includes("고객사") && cells.includes("구분")) return r;
  }
  return 0;
}

// 세금계산서발행 칸이 채워져 있는지 (날짜/텍스트 있으면 true)
function hasInvoice(v) {
  if (v === null || v === undefined) return false;
  if (v instanceof Date) return true;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim();
  if (!s || s === "-" || s === "–" || s === "—") return false;
  return true;
}

function toNum(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return v;
  const s = String(v).replace(/[₩,\s]/g, "").replace(/[()]/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// 파일 하나를 파싱해서 행 목록과 현황 집계를 반환
function parseFile(rows) {
  const hr = findHeaderRow(rows);
  const idx = mapHeader(rows[hr]);
  if (idx.customer < 0 || idx.category < 0) {
    throw new Error("'고객사' 또는 '구분' 컬럼을 찾지 못했습니다. 헤더가 표의 위쪽에 있는지 확인해주세요.");
  }

  const byCustomer = {};
  const totals = { total: 0, wait: 0, done: 0, unpaid: 0 };
  const bucket = c => (byCustomer[c] ||= { total: 0, wait: 0, done: 0, unpaid: 0 });

  const records = []; // 비교용: 각 행의 순번/발행상태/금액
  let seq = 0; // 메인표 행 순번 (파일 간 위치 매칭용)

  for (let r = hr + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;
    const customer = String(row[idx.customer] ?? "").trim();
    const category = String(row[idx.category] ?? "").trim();

    // 메인 표 행만 집계: 고객사가 있고, 구분이 계약금/중도금/잔금인 행
    // (하단에 붙은 '잔금 미발행' 같은 별도 표는 제외)
    const isMainRow = customer && ["계약금", "중도금", "잔금"].includes(category);
    if (!isMainRow) continue;

    const cust = customer;
    const b = bucket(cust);

    const amt = toNum(row[idx.amount]);
    const invoiced = idx.invoiceDate >= 0 && hasInvoice(row[idx.invoiceDate]);

    if (category.includes("계약금")) {
      const pa = toNum(row[idx.projectAmount]);
      b.total += pa; totals.total += pa;
    }
    if (invoiced) { b.wait += amt; totals.wait += amt; }
    if (idx.received >= 0) { const rec = toNum(row[idx.received]); b.done += rec; totals.done += rec; }
    if (idx.unpaid >= 0) { const up = toNum(row[idx.unpaid]); b.unpaid += up; totals.unpaid += up; }

    records.push({ seq: seq++, cust, category, amt, invoiced });
  }

  return { totals, byCustomer, records };
}

// 두 파일 비교: 이전엔 발행(true), 최근엔 미발행(false) → 그 기간 수금
// 두 파일은 같은 프로젝트 목록을 같은 순서로 유지하므로 행 순번(seq)으로 매칭
function compare(prev, curr) {
  const prevMap = new Map();
  for (const rec of prev.records) prevMap.set(rec.seq, rec);

  const byCustomer = {};
  let total = 0;
  for (const c of curr.records) {
    const p = prevMap.get(c.seq);
    if (!p) continue;
    if (p.invoiced && !c.invoiced) {
      byCustomer[c.cust] = (byCustomer[c.cust] || 0) + c.amt;
      total += c.amt;
    }
  }
  return { total, byCustomer };
}

/* ===== 렌더링: 단일 파일 현황 ===== */
let chart, cmpChart;

function renderStatus({ totals, byCustomer }) {
  document.getElementById("v-total").textContent = won(totals.total);
  document.getElementById("v-wait").textContent = won(totals.wait);
  document.getElementById("v-done").textContent = won(totals.done);
  document.getElementById("v-unpaid").textContent = won(totals.unpaid);

  const entries = Object.entries(byCustomer).sort((a, b) => b[1].total - a[1].total);

  const tbody = document.querySelector("#table tbody");
  tbody.innerHTML = entries.map(([name, v]) => `
    <tr><td>${name}</td>
      <td class="num-total">${won(v.total)}</td>
      <td class="num-wait">${won(v.wait)}</td>
      <td class="num-done">${won(v.done)}</td>
      <td class="num-unpaid">${won(v.unpaid)}</td></tr>`).join("");
  document.querySelector("#table tfoot").innerHTML = `
    <tr><td>합계</td>
      <td class="num-total">${won(totals.total)}</td>
      <td class="num-wait">${won(totals.wait)}</td>
      <td class="num-done">${won(totals.done)}</td>
      <td class="num-unpaid">${won(totals.unpaid)}</td></tr>`;

  const labels = entries.map(e => e[0]);
  const mk = key => entries.map(e => e[1][key]);
  if (chart) chart.destroy();
  chart = new Chart(document.getElementById("chart"), {
    type: "bar",
    data: { labels, datasets: [
      { label: "총수주금액", data: mk("total"), backgroundColor: "#2563eb" },
      { label: "수금대기", data: mk("wait"), backgroundColor: "#d97706" },
      { label: "수금완료", data: mk("done"), backgroundColor: "#16a34a" },
      { label: "현 미수금", data: mk("unpaid"), backgroundColor: "#dc2626" },
    ]},
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "top", labels: { font: { size: 12 } } },
        tooltip: { callbacks: { label: c => c.dataset.label + ": " + won(c.parsed.y) } } },
      scales: { y: { ticks: { callback: v => "₩" + (v / 1e8).toFixed(1) + "억" } },
        x: { ticks: { font: { size: 11 } } } } }
  });

  document.getElementById("placeholder").classList.add("hidden");
  document.getElementById("result").classList.remove("hidden");
}

/* ===== 렌더링: 기간 비교 ===== */
function renderCompare(cmp, prevName, currName) {
  const box = document.getElementById("compare");
  box.classList.remove("hidden");
  document.getElementById("cmp-label").textContent = `${prevName} → ${currName}`;
  document.getElementById("cmp-total").textContent = won(cmp.total);

  const entries = Object.entries(cmp.byCustomer).sort((a, b) => b[1] - a[1]);
  document.querySelector("#cmp-table tbody").innerHTML = entries.map(([name, v]) =>
    `<tr><td>${name}</td><td class="num-done">${won(v)}</td></tr>`).join("")
    || `<tr><td colspan="2" style="text-align:center;color:var(--sub)">이 기간에 발행칸에서 빠진(수금된) 항목이 없습니다.</td></tr>`;
  document.querySelector("#cmp-table tfoot").innerHTML =
    `<tr><td>합계</td><td class="num-done">${won(cmp.total)}</td></tr>`;

  const labels = entries.map(e => e[0]);
  const data = entries.map(e => e[1]);
  if (cmpChart) cmpChart.destroy();
  cmpChart = new Chart(document.getElementById("cmpChart"), {
    type: "bar",
    data: { labels, datasets: [{ label: "기간 수금액", data, backgroundColor: "#16a34a" }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: c => "수금액: " + won(c.parsed.y) } } },
      scales: { y: { ticks: { callback: v => "₩" + (v / 1e8).toFixed(1) + "억" } } } }
  });
}

/* ===== 파일 입력 ===== */
const drop = document.getElementById("drop");
const fileInput = document.getElementById("file");
const errBox = document.getElementById("error");

function showErr(msg) { errBox.textContent = "⚠ " + msg; errBox.classList.remove("hidden"); }

// 파일명에서 날짜 숫자 추출 (정렬용). 예: _260713_ → 260713
function fileOrder(name) {
  const m = name.match(/(\d{6,8})/);
  return m ? parseInt(m[1]) : 0;
}

function readXlsx(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: "array", cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });
        resolve(parseFile(rows));
      } catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error("파일을 읽지 못했습니다."));
    reader.readAsArrayBuffer(file);
  });
}

async function handleFiles(fileList) {
  errBox.classList.add("hidden");
  const files = Array.from(fileList).sort((a, b) => fileOrder(a.name) - fileOrder(b.name));

  // 업로드된 파일 리스트 표시 (개수 + 이전/최근 라벨)
  const listEl = document.getElementById("filelist");
  const roleLabel = (i) => {
    if (files.length < 2) return "";
    if (i === 0) return `<span class="badge prev">이전 시점</span>`;
    if (i === files.length - 1) return `<span class="badge curr">최근 시점</span>`;
    return "";
  };
  listEl.innerHTML =
    `<div class="fl-head">인식된 파일 ${files.length}개</div>` +
    files.map((f, i) => `<div class="fl-row">📄 <span class="fl-name">${f.name}</span> ${roleLabel(i)}</div>`).join("");
  listEl.classList.remove("hidden");

  try {
    const parsed = await Promise.all(files.map(readXlsx));

    // 현황: 가장 최근(정렬 마지막) 파일 기준
    const latest = parsed[parsed.length - 1];
    renderStatus(latest);

    // 비교: 파일 2개 이상이면 처음 vs 마지막
    if (parsed.length >= 2) {
      const prev = parsed[0], curr = parsed[parsed.length - 1];
      const cmp = compare(prev, curr);
      renderCompare(cmp, files[0].name, files[files.length - 1].name);
    } else {
      document.getElementById("compare").classList.add("hidden");
    }
  } catch (err) {
    showErr(err.message || "파일을 분석하지 못했습니다.");
  }
}

fileInput.addEventListener("change", e => { if (e.target.files.length) handleFiles(e.target.files); });
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => { if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });

/* ===== 월별 히스토리 (GitHub data 폴더 자동 집계) ===== */

// 파일명에서 월키(YYYY-MM) 추출. 예: _260715_ → 2026-07
function monthKey(name) {
  const m = name.match(/(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return `20${m[1]}-${m[2]}`;
}
function fileSortNum(name) {
  const m = name.match(/(\d{6,8})/);
  return m ? parseInt(m[1]) : 0;
}

let histChart;

async function loadHistory() {
  const statusEl = document.getElementById("hist-status");
  const box = document.getElementById("history");
  try {
    // 1) GitHub data 폴더의 파일 목록 읽기 (공개 저장소, 인증 불필요)
    const api = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_DATA_DIR}?ref=${GH_BRANCH}`;
    const res = await fetch(api);
    if (!res.ok) {
      // 폴더가 아직 없으면 조용히 숨김 (404) — 안내만
      if (res.status === 404) {
        box.classList.add("hidden");
        return;
      }
      throw new Error("GitHub 응답 오류 " + res.status);
    }
    const items = await res.json();
    const excelFiles = items.filter(f => f.type === "file" && /\.(xlsx|xls|csv)$/i.test(f.name));
    if (excelFiles.length === 0) { box.classList.add("hidden"); return; }

    box.classList.remove("hidden");
    statusEl.textContent = `${excelFiles.length}개 파일 불러오는 중...`;

    // 2) 각 파일 다운로드 + 파싱
    const parsedAll = [];
    for (const f of excelFiles) {
      const dl = await fetch(f.download_url);
      const buf = await dl.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array", cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });
      parsedAll.push({ name: f.name, mkey: monthKey(f.name), snum: fileSortNum(f.name), data: parseFile(rows) });
    }

    // 3) 월별 그룹 → 각 달 최신(마지막) 파일 대표
    const byMonth = {};
    for (const p of parsedAll) {
      if (!p.mkey) continue;
      (byMonth[p.mkey] ||= []).push(p);
    }
    const months = Object.keys(byMonth).sort();
    for (const k of months) byMonth[k].sort((a, b) => a.snum - b.snum);

    // 4) 월별 추이 계산: 막대=그달 새 수금(직전달 대표 대비 발행칸에서 빠진 금액), 선=누적 수금완료
    const rows = [];
    let prevRep = null;
    for (const k of months) {
      const rep = byMonth[k][byMonth[k].length - 1].data;
      const monthReceived = prevRep ? compare(prevRep, rep).total : rep.totals.done;
      rows.push({ month: k, received: monthReceived, cumDone: rep.totals.done });
      prevRep = rep;
    }

    renderHistory(rows, byMonth);
    statusEl.textContent = `${months.length}개월 · 파일 ${excelFiles.length}개`;
  } catch (err) {
    statusEl.textContent = "히스토리를 불러오지 못했습니다: " + (err.message || err);
  }
}

function renderHistory(rows, byMonth) {
  const labels = rows.map(r => r.month);
  const bar = rows.map(r => r.received);
  const line = rows.map(r => r.cumDone);

  if (histChart) histChart.destroy();
  histChart = new Chart(document.getElementById("histChart"), {
    data: {
      labels,
      datasets: [
        { type: "bar", label: "그 달 수금액", data: bar, backgroundColor: "#16a34a", yAxisID: "y", order: 2 },
        { type: "line", label: "누적 수금완료", data: line, borderColor: "#2563eb", backgroundColor: "#2563eb",
          tension: 0.3, yAxisID: "y", order: 1, pointRadius: 4 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: "top", labels: { font: { size: 12 } } },
        tooltip: { callbacks: { label: c => c.dataset.label + ": " + won(c.parsed.y) } }
      },
      scales: { y: { ticks: { callback: v => "₩" + (v / 1e8).toFixed(1) + "억" } } }
    }
  });

  // 월별 표
  const tbody = document.querySelector("#hist-table tbody");
  tbody.innerHTML = rows.map(r =>
    `<tr><td>${r.month}</td><td class="num-done">${won(r.received)}</td><td class="num-total">${won(r.cumDone)}</td></tr>`
  ).join("");
}

// 페이지 로드 시 자동으로 히스토리 불러오기
loadHistory();
