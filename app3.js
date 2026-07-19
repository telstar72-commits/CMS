/* ===== Cash Flow Monitoring System v3 ===== */

const GH_OWNER = "telstar72-commits";
const GH_REPO = "CMS";
const GH_BRANCH = "main";
const GH_DATA_DIR = "data";

const COL = {
  customer: ["고객사"],
  category: ["구분"],
  projectAmount: ["프로젝트금액", "프로젝트 금액"],
  projectName: ["프로젝트명"],
  invoiceDate: ["세금계산서발행", "세금계산서 발행", "세금계산서발행일", "계금계산서발행", "게금계산서발행"],
  amount: ["금액"],
  received: ["수금액"],
  unpaid: ["미결제금액(TC)", "미결제금액", "미결재금액(TC)", "미결재금액", "미수금(TC)", "미수금"],
  project: ["프로젝트번호", "발주번호"],
};
const EXACT_ONLY = new Set(["amount"]);

const won = n => "₩" + Math.round(n || 0).toLocaleString("ko-KR");
const eok = n => (n / 1e8).toFixed(1) + "억";
const norm = s => String(s ?? "").replace(/\s/g, "");

// 고객사별 색 팔레트 (종합 카드 4색 순환): 파랑, 앰버, 청록, 빨강
const CUST_COLORS = [
  { solid: "#2563eb", soft: "#cddffa", dark: "#0c447c", tagBg: "#e6f0fb" }, // 파랑
  { solid: "#d97706", soft: "#f6e2c0", dark: "#8a5a0a", tagBg: "#fbf0dc" }, // 앰버
  { solid: "#0f766e", soft: "#cfe9e5", dark: "#0f766e", tagBg: "#d8ede9" }, // 청록
  { solid: "#dc2626", soft: "#f7d4d4", dark: "#a32d2d", tagBg: "#fbe6e6" }, // 빨강
];
// 고객사 등장 순서대로 색 배정 (4곳 초과 시 순환)
let custColorMap = {};
function assignCustomerColors(order) {
  custColorMap = {};
  order.forEach((name, i) => { custColorMap[name] = CUST_COLORS[i % CUST_COLORS.length]; });
}
function custColor(name) {
  return custColorMap[name] || CUST_COLORS[0];
}

function mapHeader(headerRow) {
  const idx = {};
  for (const key in COL) {
    idx[key] = -1;
    for (let c = 0; c < headerRow.length; c++)
      if (COL[key].some(n => norm(headerRow[c]) === norm(n))) { idx[key] = c; break; }
  }
  for (const key in COL) {
    if (idx[key] >= 0 || EXACT_ONLY.has(key)) continue;
    for (let c = 0; c < headerRow.length; c++)
      if (COL[key].some(n => norm(headerRow[c]).includes(norm(n)))) { idx[key] = c; break; }
  }
  return idx;
}
function findHeaderRow(rows) {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const cells = rows[r].map(norm);
    if (cells.includes("고객사") && cells.includes("구분")) return r;
  }
  return 0;
}
function hasInvoice(v) {
  if (v === null || v === undefined) return false;
  if (v instanceof Date) return true;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim();
  return s !== "" && s !== "-" && s !== "–" && s !== "—";
}
function toNum(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return v;
  const s = String(v).replace(/[₩,\s]/g, "").replace(/[()]/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// 한 파일 파싱
function parseFile(rows) {
  const hr = findHeaderRow(rows);
  const idx = mapHeader(rows[hr]);
  if (idx.customer < 0 || idx.category < 0)
    throw new Error("'고객사' 또는 '구분' 컬럼을 찾지 못했습니다.");

  const totals = { total: 0, wait: 0, done: 0, unpaid: 0 };
  const byCust = {}; // 고객사별 집계
  const records = []; let seq = 0;
  const projects = {}; // 프로젝트별 진행율
  const order = []; // 고객사 등장 순서

  for (let r = hr + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;
    const cust = String(row[idx.customer] ?? "").trim();
    const cat = String(row[idx.category] ?? "").trim();
    if (!(cust && ["계약금", "중도금", "잔금"].includes(cat))) continue;

    const amt = toNum(row[idx.amount]);
    const invoiced = idx.invoiceDate >= 0 && hasInvoice(row[idx.invoiceDate]);
    const pa = toNum(row[idx.projectAmount]);
    const rec = toNum(row[idx.received]);
    const up = toNum(row[idx.unpaid]);
    const pnum = idx.project >= 0 ? String(row[idx.project] ?? "").trim() : "";
    const pname = idx.projectName >= 0 ? String(row[idx.projectName] ?? "").trim() : "";

    if (!byCust[cust]) { byCust[cust] = { total: 0, wait: 0, done: 0, unpaid: 0 }; order.push(cust); }
    const b = byCust[cust];
    if (cat.includes("계약금")) { b.total += pa; totals.total += pa; }
    if (invoiced) { b.wait += amt; totals.wait += amt; }
    b.done += rec; totals.done += rec;
    b.unpaid += up; totals.unpaid += up;

    records.push({ seq: seq++, cust, amt, invoiced });

    const pk = pnum || pname || (cust + seq);
    if (!projects[pk]) projects[pk] = { cust, name: pname || pnum, pa: 0, rec: 0 };
    if (cat.includes("계약금")) projects[pk].pa = pa;
    projects[pk].rec += rec;
  }
  return { totals, byCust, records, projects, order };
}

// 두 파일 비교: 발행칸에서 빠진 금액 = 그 기간 실제 수금 (고객사별)
function compareByCust(prev, curr) {
  const pm = new Map(prev.records.map(r => [r.seq, r]));
  const byC = {}; let total = 0;
  for (const c of curr.records) {
    const p = pm.get(c.seq);
    if (p && p.invoiced && !c.invoiced) { byC[c.cust] = (byC[c.cust] || 0) + c.amt; total += c.amt; }
  }
  return { total, byC };
}

function monthKey(name) {
  const m = name.match(/(\d{2})(\d{2})(\d{2})/);
  return m ? `20${m[1]}-${m[2]}` : null;
}
function fileSortNum(name) {
  const m = name.match(/(\d{6,8})/);
  return m ? parseInt(m[1]) : 0;
}
// 파일명에 '매입'이 있으면 매입(지급) 파일
function isPurchaseFile(name) {
  return /매입/.test(name);
}

// 매입 파일 파싱: Summary (2) 시트에서 업체×월 상세 + 월별 합계
// 반환: { monthly: {"2026-03": 합계}, detail: Map("업체|월" => 금액) }
function parsePurchase(wb) {
  // 지급 반영 시트 우선순위: 매입자료 → Sheet2 → Summary (2) → 첫 시트
  let sheetName = null;
  for (const cand of ["매입자료", "Sheet2", "Summary (2)"]) {
    if (wb.SheetNames.includes(cand)) { sheetName = cand; break; }
  }
  if (!sheetName) sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });

  // 월 헤더 행 찾기: "26-03" 형태가 2개 이상 있는 행
  let hr = -1, monthCols = {};
  for (let r = 0; r < Math.min(rows.length, 12); r++) {
    const found = {};
    rows[r].forEach((cell, c) => {
      const m = String(cell).match(/^(\d{2})-(\d{2})$/);
      if (m) found[c] = `20${m[1]}-${m[2]}`;
    });
    if (Object.keys(found).length >= 2) { hr = r; monthCols = found; break; }
  }
  if (hr < 0) return { monthly: {}, detail: new Map() };

  // 업체명(라벨) 컬럼 = 월 컬럼 중 가장 앞의 바로 앞 컬럼
  const firstMonthCol = Math.min(...Object.keys(monthCols).map(Number));
  const labelCol = firstMonthCol - 1 >= 0 ? firstMonthCol - 1 : 0;

  const monthly = {};
  for (const mk of Object.values(monthCols)) monthly[mk] = 0;
  const detail = new Map(); // "업체|월" => 금액

  for (let r = hr + 1; r < rows.length; r++) {
    const label = String(rows[r][labelCol] ?? "").trim();
    if (!label || label === "총합계" || label === "합계" || label.includes("비어 있음")) continue;
    for (const c in monthCols) {
      const v = rows[r][c];
      if (typeof v === "number" && v !== 0) {
        const mk = monthCols[c];
        monthly[mk] += v;
        detail.set(label + "|" + mk, v);
      }
    }
  }
  return { monthly, detail };
}

// 두 매입 파일 비교: 이전엔 있던 발행 건이 이번에 빠짐/감소 = 그 사이 지급 완료
// 반환: { total, byMonth: {"2026-06": 지급액} } — 발행일(월)별로 집계
function comparePurchase(prevDetail, currDetail) {
  let total = 0;
  const byMonth = {};
  for (const [key, amt] of prevDetail) {
    const now = currDetail.get(key) || 0;
    if (now < amt) {
      const paid = amt - now;
      total += paid;
      const mk = key.split("|")[1]; // "업체|2026-06" → "2026-06"
      byMonth[mk] = (byMonth[mk] || 0) + paid;
    }
  }
  return { total, byMonth };
}

/* ===== 데이터 로드 (GitHub data 폴더 자동) ===== */
async function fetchDataFolder() {
  const api = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_DATA_DIR}?ref=${GH_BRANCH}&t=${Date.now()}`;
  const res = await fetch(api);
  if (!res.ok) {
    if (res.status === 404) return [];
    throw new Error("GitHub 응답 오류 " + res.status);
  }
  const items = await res.json();
  const files = items
    .filter(f => f.type === "file" && /\.(xlsx|xls|csv)$/i.test(f.name))
    .map(f => ({ name: f.name, url: f.download_url, path: f.path, sha: f.sha, snum: fileSortNum(f.name), mkey: monthKey(f.name), purchase: isPurchaseFile(f.name) }))
    .sort((a, b) => a.snum - b.snum);
  return files;
}
async function loadParsed(file) {
  const dl = await fetch(file.url);
  const buf = await dl.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });
  return parseFile(rows);
}
// 매입 파일 로드 → 월별 지급액
async function loadPurchase(file) {
  const dl = await fetch(file.url);
  const buf = await dl.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  return parsePurchase(wb);
}

/* ===== 렌더링 ===== */
const el = id => document.getElementById(id);
let custChart, projChart, monthChart;

function renderSummary(t) {
  el("s-total").textContent = won(t.total);
  el("s-wait").textContent = won(t.wait);
  el("s-done").textContent = won(t.done);
  el("s-unpaid").textContent = won(t.unpaid);
}

// 고객사 카드 (동적 증가, 고객사별 색)
function renderCustomerCards(byCust, order) {
  const wrap = el("cust-cards");
  wrap.innerHTML = order.map(name => {
    const v = byCust[name];
    const c = custColor(name);
    return `<div class="ccard">
      <div class="ccard-name" style="background:${c.solid}">${name}</div>
      <div class="ccard-nums">
        <div><span class="ccard-lbl">수주</span><span class="ccard-val">${won(v.total)}</span></div>
        <div><span class="ccard-lbl">미수금</span><span class="ccard-val neg">${won(v.unpaid)}</span></div>
        <div><span class="ccard-lbl">수금완료</span><span class="ccard-val pos">${won(v.done)}</span></div>
      </div>
    </div>`;
  }).join("");
}

// 고객사별 막대: 연한=발행액(wait), 진한=실제수금(비교)
function renderCustomerChart(byCust, order, received) {
  const labels = order;
  const issued = order.map(c => byCust[c].wait);      // 세금계산서 발행액 (연한, 배경)
  const collected = order.map(c => received[c] || 0); // 실제 수금 (진한, 겹침)
  if (custChart) custChart.destroy();
  custChart = new Chart(el("custChart"), {
    data: { labels, datasets: [
      { type: "bar", label: "세금계산서 발행액", data: issued, backgroundColor: "#a5d6b7", borderRadius: 3,
        categoryPercentage: 0.6, barPercentage: 1.0, grouped: false, order: 2 },
      { type: "bar", label: "실제 수금액", data: collected, backgroundColor: "#16a34a", borderRadius: 3,
        categoryPercentage: 0.36, barPercentage: 1.0, grouped: false, order: 1 },
    ]},
    options: { responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "top", labels: { font: { size: 12 } } },
        tooltip: { callbacks: { label: c => c.dataset.label + ": " + won(c.parsed.y) } } },
      scales: { y: { beginAtZero: true, ticks: { callback: v => "₩" + eok(v) } } } }
  });
}

// 프로젝트 진행율
function renderProjects(projects) {
  const list = Object.values(projects).filter(p => p.pa > 0)
    .sort((a, b) => b.pa - a.pa);
  const totPa = list.reduce((s, p) => s + p.pa, 0);
  const totRec = list.reduce((s, p) => s + p.rec, 0);
  const overallPct = totPa ? (totRec / totPa * 100) : 0;

  el("proj-overall").textContent = overallPct.toFixed(0) + "%";
  el("proj-overall-sub").textContent = `총수주 ${eok(totPa)} · 수금 ${eok(totRec)}`;

  // 억 단위 간결 표기 (얇은 막대용)
  const eokShort = n => {
    const e = n / 1e8;
    return (e >= 10 ? e.toFixed(1) : e.toFixed(2)) + "억";
  };

  el("proj-list").innerHTML = list.map(p => {
    const pctRaw = p.pa ? (p.rec / p.pa * 100) : 0;
    const pct = Math.min(Math.max(pctRaw, 0), 100);      // 채운 폭 (0~100 클램프)
    const remain = Math.max(p.pa - p.rec, 0);            // 남은 금액
    const remainPct = 100 - pct;
    const c = custColor(p.cust);                          // 고객사 색
    const eokTotal = p.pa / 1e8;
    const totLabel = (Number.isInteger(eokTotal) ? eokTotal : eokTotal.toFixed(1)) + "억";
    const doneLabel = `${eokShort(p.rec)} (${pctRaw.toFixed(0)}%)`;
    const remainLabel = `${eokShort(remain)} (${remainPct.toFixed(0)}%)`;
    return `<div class="prow">
      <div class="prow-head">
        <span class="prow-name">${p.name || "(이름없음)"} <span class="prow-total">(${totLabel})</span></span>
        <span class="prow-cust" style="color:${c.dark}; background:${c.tagBg}">${p.cust}</span>
      </div>
      <div class="pbar">
        <div class="pbar-fill" style="width:${pct}%; background:${c.solid}">
          ${pct >= 30 ? `<span class="pbar-in">${doneLabel}</span>` : ""}
        </div>
        <div class="pbar-remain" style="width:${remainPct}%; background:${c.soft}">
          ${remainPct >= 30 ? `<span class="pbar-in" style="color:${c.dark}">${remainLabel}</span>` : ""}
        </div>
      </div>
    </div>`;
  }).join("");
}

// 월별 목표대비 성과 (목표=발행액, 성과=실제수금, 달성율=성과/목표)
function renderMonthly(monthRows) {
  const labels = monthRows.map(r => r.month);
  const target = monthRows.map(r => r.target);
  const perf = monthRows.map(r => r.perf);
  const rate = monthRows.map(r =>
    (r.target && r.target > 0 && r.perf != null) ? Math.round(r.perf / r.target * 100) : null
  );

  if (monthChart) monthChart.destroy();
  monthChart = new Chart(el("monthChart"), {
    data: {
      labels,
      datasets: [
        { type: "bar", label: "목표 (세금계산서 발행)", data: target, backgroundColor: "#9ed4d1", order: 5, yAxisID: "y",
          categoryPercentage: 0.6, barPercentage: 1.0, grouped: false },
        { type: "bar", label: "성과 (실제 수금)", data: perf, backgroundColor: "#178f8a", order: 4, yAxisID: "y",
          categoryPercentage: 0.36, barPercentage: 1.0, grouped: false },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "top", labels: { font: { size: 12 } } },
        tooltip: { callbacks: { label: c => c.dataset.label + ": " + won(c.parsed.y) } }
      },
      scales: {
        x: { ticks: { autoSkip: false, maxRotation: 45, font: { size: 10 } } },
        y: { position: "left", beginAtZero: true, ticks: { callback: v => "₩" + eok(v) }, title: { display: true, text: "금액", font: { size: 11 } } },
      }
    }
  });

  // 표: 데이터 있는 달만
  el("month-table").querySelector("tbody").innerHTML = monthRows
    .filter(r => r.target != null || r.perf != null)
    .map(r => {
      const rt = (r.target && r.target > 0 && r.perf != null) ? Math.round(r.perf / r.target * 100) + "%" : "-";
      return `<tr><td>${r.month}</td><td class="num-target">${won(r.target)}</td><td class="num-done">${won(r.perf)}</td><td>${rt}</td></tr>`;
    }).join("");
}

// 미수금 현황(고객사별) / 미지급 현황(업체별)
function renderReceivablePayable(receivableByCust, payableByVendor) {
  const box = el("cashflow");
  const recvList = Object.entries(receivableByCust).sort((a, b) => b[1] - a[1]);
  const payList = Object.entries(payableByVendor).sort((a, b) => b[1] - a[1]);
  const hasData = recvList.length > 0 || payList.length > 0;
  if (!hasData) { if (box) box.classList.add("hidden"); return; }
  if (box) box.classList.remove("hidden");

  const recvTotal = recvList.reduce((s, [, v]) => s + v, 0);
  const payTotal = payList.reduce((s, [, v]) => s + v, 0);
  const MIN_ROWS = 7; // 기본 7칸

  // 빈 행 채우기 (항목이 7개 미만일 때)
  const fillEmpty = (count) => {
    let html = "";
    for (let i = 0; i < count; i++) html += `<div class="rp-row empty"><span class="rp-name">-</span><span class="rp-amt">-</span></div>`;
    return html;
  };

  // 미수금 (고객사별) — 고객사 색, 클릭 시 프로젝트별 상세
  el("recv-total").textContent = won(recvTotal);
  let recvHtml = recvList.map(([name, v]) => {
    const c = custColor(name);
    return `<div class="rp-row clickable" data-type="recv" data-name="${encodeURIComponent(name)}">
      <span class="rp-name"><span class="rp-dot" style="background:${c.solid}"></span>${name}</span>
      <span class="rp-amt recv">${won(v)}</span>
    </div>`;
  }).join("");
  if (recvList.length < MIN_ROWS) recvHtml += fillEmpty(MIN_ROWS - recvList.length);
  el("recv-list").innerHTML = recvHtml;

  // 미지급 (업체별) — 전체 표시, 클릭 시 월별 상세
  el("pay-total").textContent = won(payTotal);
  let payHtml = payList.map(([name, v]) =>
    `<div class="rp-row clickable" data-type="pay" data-name="${encodeURIComponent(name)}"><span class="rp-name">${name}</span><span class="rp-amt pay">${won(v)}</span></div>`
  ).join("");
  if (payList.length < MIN_ROWS) payHtml += fillEmpty(MIN_ROWS - payList.length);
  el("pay-list").innerHTML = payHtml;

  // 클릭 이벤트 연결
  document.querySelectorAll("#recv-list .rp-row.clickable, #pay-list .rp-row.clickable").forEach(row => {
    row.addEventListener("click", () => {
      const type = row.dataset.type;
      const name = decodeURIComponent(row.dataset.name);
      openDetailModal(type, name);
    });
  });
}

// 상세 팝업 열기
function openDetailModal(type, name) {
  const monthLabel = mk => {
    const [y, m] = mk.split("-");
    return `${y}년 ${parseInt(m)}월`;
  };
  let rows = [], sub = "", amtClass = "";
  if (type === "pay") {
    // 미지급: 업체의 월별(발행월) 상세
    const detail = (window.__payableDetail || {})[name] || {};
    rows = Object.keys(detail).sort().map(mk => ({ label: monthLabel(mk), amt: detail[mk] }));
    sub = "미지급 상세 내역 (세금계산서 발행월 기준)";
    amtClass = "pay";
  } else {
    // 미수금: 고객사의 프로젝트별 상세
    const detail = (window.__receivableDetail || {})[name] || [];
    rows = detail.slice().sort((a, b) => b.amt - a.amt).map(p => ({ label: p.name, amt: p.amt }));
    sub = "미수금 상세 내역 (프로젝트별)";
    amtClass = "recv";
  }
  const total = rows.reduce((s, r) => s + r.amt, 0);

  el("detail-title").textContent = name;
  el("detail-sub").textContent = sub;
  el("detail-rows").innerHTML = rows.length
    ? rows.map(r => `<div class="drow"><span class="drow-label">${r.label}</span><span class="drow-amt ${amtClass === "pay" ? "num-unpaid" : "num-done"}">${won(r.amt)}</span></div>`).join("")
    : `<div class="drow"><span class="drow-label">상세 내역이 없습니다.</span><span></span></div>`;
  el("detail-total").textContent = won(total);
  el("detail-total").className = "detail-total " + (amtClass === "pay" ? "num-unpaid" : "num-done");
  // 합계 행 배경색 (미수=초록, 미지급=빨강)
  const totalRow = document.querySelector(".detail-total-row");
  if (totalRow) totalRow.className = "detail-total-row " + amtClass;
  el("detail-modal").classList.remove("hidden");
}
function closeDetailModal() { el("detail-modal").classList.add("hidden"); }

// 저장된 파일 목록 (매출/매입 분리, 삭제 버튼 포함)
let currentFiles = []; // 삭제 시 sha/path 참조용
function renderFileList(files) {
  currentFiles = files;

  const rowHtml = f => {
    const mk = f.mkey ? `<span class="badge">${f.mkey}</span>` : "";
    return `<div class="sf-row">
      <span class="sf-icon">📄</span>
      <span class="sf-name">${f.name}</span>
      ${mk}
      <button class="sf-del" data-name="${encodeURIComponent(f.name)}">삭제</button>
    </div>`;
  };

  const salesFiles = files.filter(f => !f.purchase).slice().reverse();
  const purchaseFiles = files.filter(f => f.purchase).slice().reverse();

  el("sales-list").innerHTML = salesFiles.length
    ? salesFiles.map(rowHtml).join("")
    : `<div class="sf-empty">아직 매출(자금관리) 파일이 없습니다.</div>`;
  el("purchase-list").innerHTML = purchaseFiles.length
    ? purchaseFiles.map(rowHtml).join("")
    : `<div class="sf-empty">아직 매입 파일이 없습니다.</div>`;

  // 삭제 버튼 이벤트 (양쪽 모두)
  document.querySelectorAll("#sales-list .sf-del, #purchase-list .sf-del").forEach(btn => {
    btn.addEventListener("click", () => {
      const name = decodeURIComponent(btn.dataset.name);
      openDeleteConfirm(name);
    });
  });
}

/* ===== GitHub 쓰기 (업로드/삭제) — 토큰 필요 ===== */
const TOKEN_KEY = "cms_gh_token";
function getToken() { try { return window.sessionStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } }
function setToken(t) { try { window.sessionStorage.setItem(TOKEN_KEY, t); } catch {} }

// 토큰 확보 (없으면 입력 요청)
function ensureToken() {
  let t = getToken();
  if (t) return t;
  t = window.prompt("GitHub 접근 토큰을 입력하세요.\n(한 번 입력하면 이 브라우저에서 계속 기억됩니다)");
  if (t) { setToken(t.trim()); return t.trim(); }
  return "";
}

// 파일을 base64로 변환
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = reader.result.split(",")[1];
      resolve(b64);
    };
    reader.onerror = () => reject(new Error("파일 읽기 실패"));
    reader.readAsDataURL(file);
  });
}

// 업로드: data 폴더에 파일 저장 (PUT contents)
async function uploadFile(file) {
  const token = ensureToken();
  if (!token) return;
  const path = `${GH_DATA_DIR}/${file.name}`;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const api = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${encodedPath}`;
  const content = await fileToBase64(file);

  // 이미 있으면 sha 필요 (덮어쓰기)
  let sha = null;
  try {
    const chk = await fetch(api + `?ref=${GH_BRANCH}`, { headers: { Authorization: "Bearer " + token } });
    if (chk.ok) { const j = await chk.json(); sha = j.sha; }
  } catch {}

  const body = { message: `Upload ${file.name}`, content, branch: GH_BRANCH };
  if (sha) body.sha = sha;

  const res = await fetch(api, {
    method: "PUT",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 401) { setToken(""); throw new Error("토큰이 올바르지 않습니다. 다시 시도해주세요."); }
    throw new Error(err.message || ("업로드 실패 " + res.status));
  }
}

// 삭제: 목록에서 받은 path/sha를 그대로 사용 (한글 인코딩 문제 방지)
async function deleteFile(name) {
  const token = ensureToken();
  if (!token) return;
  // 목록에서 해당 파일의 path/sha 찾기
  const f = currentFiles.find(x => x.name === name);
  if (!f) throw new Error("파일 정보를 찾지 못했습니다. 새로고침 후 다시 시도해주세요.");

  // GitHub이 준 path를 세그먼트별로 인코딩 (슬래시는 유지)
  const encodedPath = f.path.split("/").map(encodeURIComponent).join("/");
  const api = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${encodedPath}`;

  const res = await fetch(api, {
    method: "DELETE",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ message: `Delete ${name}`, sha: f.sha, branch: GH_BRANCH }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 401) { setToken(""); throw new Error("토큰이 올바르지 않습니다."); }
    throw new Error(err.message || ("삭제 실패 " + res.status));
  }
}

// 삭제 확인 팝업
let pendingDelete = null;
function openDeleteConfirm(name) {
  pendingDelete = name;
  el("modal-text").textContent = `"${name}" 데이터를 지우시겠습니까?`;
  el("modal").classList.remove("hidden");
}
function closeModal() { el("modal").classList.add("hidden"); pendingDelete = null; }

async function confirmDelete() {
  const name = pendingDelete;
  closeModal();
  if (!name) return;
  const status = el("boot-status");
  try {
    status.textContent = "삭제 중...";
    await deleteFile(name);
    // 화면에서 즉시 제거 (GitHub 캐시 갱신을 기다리지 않음)
    currentFiles = currentFiles.filter(f => f.name !== name);
    renderFileList(currentFiles);
    status.textContent = "삭제 완료";
    // 전체 지표 갱신을 위해 잠시 후 새로고침 (GitHub 캐시 반영 시간 확보)
    setTimeout(() => location.reload(), 1500);
  } catch (err) {
    status.textContent = "";
    // 이미 없는 파일이면 목록에서만 제거
    if (String(err.message).includes("Not Found") || String(err.message).includes("찾지")) {
      currentFiles = currentFiles.filter(f => f.name !== name);
      renderFileList(currentFiles);
      status.textContent = "이미 삭제된 파일입니다";
    } else {
      alert("삭제 실패: " + (err.message || err));
    }
  }
}

// 업로드 처리
async function handleUpload(fileList) {
  const files = Array.from(fileList).filter(f => /\.(xlsx|xls|csv)$/i.test(f.name));
  if (files.length === 0) return;
  const status = el("boot-status");
  try {
    for (const f of files) {
      status.textContent = `${f.name} 업로드 중...`;
      await uploadFile(f);
    }
    status.textContent = "업로드 완료, 새로고침 중...";
    setTimeout(() => location.reload(), 1500);
  } catch (err) {
    status.textContent = "";
    alert("업로드 실패: " + (err.message || err));
  }
}

/* ===== 메인 ===== */
async function boot() {
  const status = el("boot-status");
  try {
    status.textContent = "데이터 폴더 확인 중...";
    const files = await fetchDataFolder();

    if (files.length === 0) {
      status.textContent = "";
      el("empty-note").classList.remove("hidden");
      return;
    }

    status.textContent = `${files.length}개 파일 불러오는 중...`;

    // 매출 파일과 매입 파일 분리
    const salesFiles = files.filter(f => !f.purchase);
    const purchaseFiles = files.filter(f => f.purchase);

    if (salesFiles.length === 0) {
      status.textContent = "";
      el("empty-note").classList.remove("hidden");
      return;
    }

    const parsedList = [];
    for (const f of salesFiles) parsedList.push({ file: f, data: await loadParsed(f) });

    // 매입: 파일별로 파싱 (발행 상세 + 월별 발행액), 시간순 정렬
    const purchaseParsed = [];
    for (const f of purchaseFiles) {
      const p = await loadPurchase(f);
      purchaseParsed.push({ file: f, ...p });
    }
    purchaseParsed.sort((a, b) => a.file.snum - b.file.snum);

    // 월별 매입 발행액(목표) = 최신 매입 파일 기준
    const purchaseIssuedByMonth = {};
    if (purchaseParsed.length > 0) {
      const latestP = purchaseParsed[purchaseParsed.length - 1];
      Object.assign(purchaseIssuedByMonth, latestP.monthly);
    }
    // 월별 매입 실제지급액 = 직전 매입 파일 대비 빠진 금액 (발행일 월별)
    let purchasePaidByMonth = {};
    if (purchaseParsed.length >= 2) {
      const pp = purchaseParsed[purchaseParsed.length - 2];
      const cp = purchaseParsed[purchaseParsed.length - 1];
      purchasePaidByMonth = comparePurchase(pp.detail, cp.detail).byMonth;
    }
    // 업체별 미지급(줄 돈) = 최신 매입 파일의 업체별 발행액 합
    const payableByVendor = {};
    const payableDetailByVendor = {}; // 업체별 월별 상세 (팝업용)
    if (purchaseParsed.length > 0) {
      const latestP = purchaseParsed[purchaseParsed.length - 1];
      for (const [key, amt] of latestP.detail) {
        const [vendor, mk] = key.split("|");
        payableByVendor[vendor] = (payableByVendor[vendor] || 0) + amt;
        (payableDetailByVendor[vendor] = payableDetailByVendor[vendor] || {})[mk] = amt;
      }
    }
    window.__payableDetail = payableDetailByVendor;

    const latest = parsedList[parsedList.length - 1].data;
    const prev = parsedList.length >= 2 ? parsedList[parsedList.length - 2].data : null;

    // 1. 종합
    renderSummary(latest.totals);
    // 고객사 색 배정 (등장 순서대로)
    assignCustomerColors(latest.order);
    // 2. 고객사 카드
    renderCustomerCards(latest.byCust, latest.order);
    // 3. 고객사별 막대 (발행액 + 실제수금)
    const received = prev ? compareByCust(prev, latest).byC : {};
    renderCustomerChart(latest.byCust, latest.order, received);
    // 4. 프로젝트 진행율
    renderProjects(latest.projects);

    // 5. 월별 목표대비 성과 (데이터 있는 가장 이른 달부터 12개월 자동 축)
    //    목표 = 그 달 대표파일의 세금계산서 발행액 / 성과 = 그 달 실제 수금액(전월 대비)
    const byMonth = {};
    for (const p of parsedList) { if (p.file.mkey) (byMonth[p.file.mkey] ||= []).push(p); }
    for (const k in byMonth) byMonth[k].sort((a, b) => a.file.snum - b.file.snum);

    // 시작 월 = 매출/매입 데이터 중 가장 이른 달 (없으면 현재 연-월)
    const allMonths = [...Object.keys(byMonth), ...Object.keys(purchaseIssuedByMonth)].sort();
    let START_Y, START_M;
    if (allMonths.length > 0) {
      const [y, m] = allMonths[0].split("-").map(Number);
      START_Y = y; START_M = m;
    } else {
      const now = new Date();
      START_Y = now.getFullYear(); START_M = now.getMonth() + 1;
    }

    // 시작 달부터 12개월 라벨 생성
    const axis = [];
    for (let i = 0; i < 12; i++) {
      const mIdx = (START_M - 1 + i);
      const y = START_Y + Math.floor(mIdx / 12);
      const m = (mIdx % 12) + 1;
      axis.push(`${y}-${String(m).padStart(2, "0")}`);
    }

    // 각 달의 대표 데이터 (있으면), 없으면 null
    const repByMonth = {};
    for (const k of Object.keys(byMonth)) {
      repByMonth[k] = byMonth[k][byMonth[k].length - 1].data;
    }

    // 이전 달(YYYY-MM) 키 구하기
    const prevMonthKey = (ym) => {
      let [y, m] = ym.split("-").map(Number);
      m -= 1; if (m === 0) { m = 12; y -= 1; }
      return `${y}-${String(m).padStart(2, "0")}`;
    };

    // 목표 = 지난달 발행액, 성과 = 이번달 수금액(지난달 대비 발행칸에서 빠진 금액)
    // 지난달 데이터가 없으면 목표/성과 모두 비움
    const monthRows = [];
    for (const k of axis) {
      const rep = repByMonth[k] || null;               // 이번 달 데이터
      const prevKey = prevMonthKey(k);
      const prevRep = repByMonth[prevKey] || null;      // 지난 달 데이터
      let target = null, perf = null;
      if (prevRep) {
        target = prevRep.totals.wait;                   // 목표 = 지난달 세금계산서 발행액
        if (rep) {
          perf = compareByCust(prevRep, rep).total;     // 성과 = 지난달→이번달 수금
        }
      }
      monthRows.push({ month: k, target, perf });
    }
    renderMonthly(monthRows);

    // 5-2. 받을 돈(고객사별 미수) / 줄 돈(업체별 미지급)
    //   받을 돈 = 고객사별 미수금(latest.byCust[].unpaid)
    //   줄 돈 = 최신 매입 파일 업체별 발행액(payableByVendor)
    const receivableByCust = {};
    for (const name of latest.order) {
      const v = latest.byCust[name];
      if (v && v.unpaid > 0) receivableByCust[name] = v.unpaid;
    }
    // 미수금 상세: 고객사별 프로젝트 목록 (미수 = 수주 - 수금)
    const recvDetailByCust = {};
    for (const p of Object.values(latest.projects)) {
      if (!p.cust) continue;
      const unpaid = Math.max((p.pa || 0) - (p.rec || 0), 0);
      if (unpaid <= 0) continue;
      (recvDetailByCust[p.cust] = recvDetailByCust[p.cust] || []).push({ name: p.name || "(이름없음)", amt: unpaid });
    }
    window.__receivableDetail = recvDetailByCust;
    renderReceivablePayable(receivableByCust, payableByVendor);

    // 6. 저장 파일 목록
    renderFileList(files);

    status.textContent = "";
    el("dashboard").classList.remove("hidden");
  } catch (err) {
    status.textContent = "불러오기 실패: " + (err.message || err);
  }
}

/* ===== UI 이벤트 연결 (업로드 버튼, 삭제 모달) ===== */
function wireControls() {
  // 파일불러오기 버튼 → 숨은 input 클릭
  const upBtn = el("upload-btn");
  const upInput = el("upload-input");
  if (upBtn && upInput) {
    upBtn.addEventListener("click", () => upInput.click());
    upInput.addEventListener("change", e => {
      if (e.target.files.length) handleUpload(e.target.files);
      e.target.value = ""; // 같은 파일 재선택 가능하게
    });
  }
  // 삭제 모달 예/아니오
  const yes = el("modal-yes"), no = el("modal-no");
  if (yes) yes.addEventListener("click", confirmDelete);
  if (no) no.addEventListener("click", closeModal);

  // 상세 팝업 닫기 (× 버튼 + 바깥 클릭)
  const dClose = el("detail-close"), dModal = el("detail-modal");
  if (dClose) dClose.addEventListener("click", closeDetailModal);
  if (dModal) dModal.addEventListener("click", (e) => {
    if (e.target === dModal) closeDetailModal(); // 바깥(오버레이) 클릭만
  });
}

wireControls();
boot();
