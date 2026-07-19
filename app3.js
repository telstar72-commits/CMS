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

/* ===== 데이터 로드 (GitHub data 폴더 자동) ===== */
async function fetchDataFolder() {
  const api = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_DATA_DIR}?ref=${GH_BRANCH}`;
  const res = await fetch(api);
  if (!res.ok) {
    if (res.status === 404) return [];
    throw new Error("GitHub 응답 오류 " + res.status);
  }
  const items = await res.json();
  const files = items
    .filter(f => f.type === "file" && /\.(xlsx|xls|csv)$/i.test(f.name))
    .map(f => ({ name: f.name, url: f.download_url, snum: fileSortNum(f.name), mkey: monthKey(f.name) }))
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

/* ===== 렌더링 ===== */
const el = id => document.getElementById(id);
let custChart, projChart, monthChart;

function renderSummary(t) {
  el("s-total").textContent = won(t.total);
  el("s-wait").textContent = won(t.wait);
  el("s-done").textContent = won(t.done);
  el("s-unpaid").textContent = won(t.unpaid);
}

// 고객사 카드 (동적 증가)
function renderCustomerCards(byCust, order) {
  const wrap = el("cust-cards");
  wrap.innerHTML = order.map(name => {
    const v = byCust[name];
    return `<div class="ccard">
      <div class="ccard-name">${name}</div>
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
  const issued = order.map(c => byCust[c].wait);      // 세금계산서 발행액 (연한)
  const collected = order.map(c => received[c] || 0); // 실제 수금 (진한)
  if (custChart) custChart.destroy();
  custChart = new Chart(el("custChart"), {
    type: "bar",
    data: { labels, datasets: [
      { label: "세금계산서 발행액", data: issued, backgroundColor: "#a5d6b7", borderRadius: 4 },
      { label: "실제 수금액", data: collected, backgroundColor: "#16a34a", borderRadius: 4 },
    ]},
    options: { responsive: true, maintainAspectRatio: false,
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

  el("proj-list").innerHTML = list.map(p => {
    const pctRaw = p.pa ? (p.rec / p.pa * 100) : 0;
    const pct = Math.min(Math.max(pctRaw, 0), 100);      // 채운 폭 (0~100 클램프)
    const remain = Math.max(p.pa - p.rec, 0);            // 남은 금액
    const remainPct = 100 - pct;
    // 제목 옆 총액 (억 단위, 소수 없으면 정수로)
    const eokTotal = p.pa / 1e8;
    const totLabel = (Number.isInteger(eokTotal) ? eokTotal : eokTotal.toFixed(1)) + "억";
    // 각 구간 라벨 (구간이 너무 좁으면 텍스트 숨김)
    const doneLabel = `${won(p.rec)} (${pctRaw.toFixed(0)}%)`;
    const remainLabel = `${won(remain)} (${remainPct.toFixed(0)}%)`;
    return `<div class="prow">
      <div class="prow-head">
        <span class="prow-name">${p.name || "(이름없음)"} <span class="prow-total">(${totLabel})</span></span>
        <span class="prow-cust">${p.cust}</span>
      </div>
      <div class="pbar">
        <div class="pbar-fill" style="width:${pct}%">
          ${pct >= 14 ? `<span class="pbar-in">${doneLabel}</span>` : ""}
        </div>
        <div class="pbar-remain" style="width:${remainPct}%">
          ${remainPct >= 14 ? `<span class="pbar-in dark">${remainLabel}</span>` : ""}
        </div>
      </div>
    </div>`;
  }).join("");
}

// 월별 추이
function renderMonthly(monthRows) {
  const labels = monthRows.map(r => r.month);
  const bar = monthRows.map(r => r.received);
  const line = monthRows.map(r => r.cumDone);
  if (monthChart) monthChart.destroy();
  monthChart = new Chart(el("monthChart"), {
    data: { labels, datasets: [
      { type: "bar", label: "그 달 수금액", data: bar, backgroundColor: "#16a34a", borderRadius: 4, order: 2 },
      { type: "line", label: "누적 수금완료", data: line, borderColor: "#2563eb", backgroundColor: "#2563eb", tension: 0.3, pointRadius: 4, order: 1 },
    ]},
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "top", labels: { font: { size: 12 } } },
        tooltip: { callbacks: { label: c => c.dataset.label + ": " + won(c.parsed.y) } } },
      scales: { y: { beginAtZero: true, ticks: { callback: v => "₩" + eok(v) } } } }
  });

  el("month-table").querySelector("tbody").innerHTML = monthRows.map(r =>
    `<tr><td>${r.month}</td><td class="num-done">${won(r.received)}</td><td class="num-total">${won(r.cumDone)}</td></tr>`
  ).join("");
}

// 저장된 파일 목록
function renderFileList(files) {
  el("saved-count").textContent = `${files.length}개`;
  el("saved-list").innerHTML = files.slice().reverse().map(f => {
    const mk = f.mkey ? `<span class="badge">${f.mkey}</span>` : "";
    return `<div class="sf-row">📄 <span class="sf-name">${f.name}</span> ${mk}</div>`;
  }).join("");
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
    const parsedList = [];
    for (const f of files) parsedList.push({ file: f, data: await loadParsed(f) });

    const latest = parsedList[parsedList.length - 1].data;
    const prev = parsedList.length >= 2 ? parsedList[parsedList.length - 2].data : null;

    // 1. 종합
    renderSummary(latest.totals);
    // 2. 고객사 카드
    renderCustomerCards(latest.byCust, latest.order);
    // 3. 고객사별 막대 (발행액 + 실제수금)
    const received = prev ? compareByCust(prev, latest).byC : {};
    renderCustomerChart(latest.byCust, latest.order, received);
    // 4. 프로젝트 진행율
    renderProjects(latest.projects);

    // 5. 월별 추이 (각 달 최신 파일 대표)
    const byMonth = {};
    for (const p of parsedList) { if (p.file.mkey) (byMonth[p.file.mkey] ||= []).push(p); }
    const months = Object.keys(byMonth).sort();
    const monthRows = [];
    let prevRep = null;
    for (const k of months) {
      const arr = byMonth[k];
      arr.sort((a, b) => a.file.snum - b.file.snum);
      const rep = arr[arr.length - 1].data;
      const mr = prevRep ? compareByCust(prevRep, rep).total : rep.totals.done;
      monthRows.push({ month: k, received: mr, cumDone: rep.totals.done });
      prevRep = rep;
    }
    renderMonthly(monthRows);

    // 6. 저장 파일 목록
    renderFileList(files);

    status.textContent = "";
    el("dashboard").classList.remove("hidden");
  } catch (err) {
    status.textContent = "불러오기 실패: " + (err.message || err);
  }
}

boot();
