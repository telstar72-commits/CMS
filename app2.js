/* ===== Cash Flow Monitoring System ===== */

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
  document.getElementById("filename").innerHTML =
    files.map(f => "📄 " + f.name).join("<br>");

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
