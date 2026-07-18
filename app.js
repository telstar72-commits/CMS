/* ===== 수주·수금 분석 로직 ===== */

// 컬럼 이름은 표기가 조금씩 달라도 잡히도록 유연하게 매칭
const COL = {
  customer: ["고객사"],
  category: ["구분"],
  projectAmount: ["프로젝트금액", "프로젝트 금액"],
  invoiceDate: ["세금계산서발행", "세금계산서 발행", "세금계산서발행일", "계금계산서발행"],
  amount: ["금액"],
  received: ["수금액"],
  unpaid: ["미결제금액(TC)", "미결제금액", "미결재금액(TC)", "미결재금액", "미수금(TC)", "미수금"],
};

const won = n => "₩" + Math.round(n || 0).toLocaleString("ko-KR");

// 헤더 행에서 각 논리 컬럼의 실제 인덱스를 찾는다
function mapHeader(headerRow) {
  const norm = s => String(s ?? "").replace(/\s/g, "");
  const idx = {};
  for (const key in COL) {
    idx[key] = -1;
    for (let c = 0; c < headerRow.length; c++) {
      const cell = norm(headerRow[c]);
      if (COL[key].some(name => cell === norm(name) || cell.includes(norm(name)))) {
        idx[key] = c; break;
      }
    }
  }
  return idx;
}

// 헤더 행 자동 탐지: "고객사"와 "구분"이 같이 있는 행
function findHeaderRow(rows) {
  const norm = s => String(s ?? "").replace(/\s/g, "");
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const cells = rows[r].map(norm);
    if (cells.includes("고객사") && cells.includes("구분")) return r;
  }
  return 0;
}

// 값에 실제 날짜가 들어있는지 판정
function hasDate(v) {
  if (v === null || v === undefined || v === "") return false;
  if (v instanceof Date) return true;
  if (typeof v === "number" && v > 1000) return true; // 엑셀 날짜 시리얼
  const s = String(v).trim();
  if (!s || s === "-") return false;
  return /\d{4}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}/.test(s);
}

// 숫자 파싱 (₩, 콤마, 공백 제거)
function toNum(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return v;
  const s = String(v).replace(/[₩,\s]/g, "").replace(/[()]/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function analyze(rows) {
  const hr = findHeaderRow(rows);
  const idx = mapHeader(rows[hr]);

  if (idx.customer < 0 || idx.category < 0) {
    throw new Error("'고객사' 또는 '구분' 컬럼을 찾지 못했습니다. 헤더가 표의 위쪽에 있는지 확인해주세요.");
  }

  const byCustomer = {}; // 고객사 -> {total, wait, done, unpaid}
  const totals = { total: 0, wait: 0, done: 0, unpaid: 0 };

  const bucket = c => (byCustomer[c] ||= { total: 0, wait: 0, done: 0, unpaid: 0 });

  for (let r = hr + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;

    const customer = String(row[idx.customer] ?? "").trim();
    const category = String(row[idx.category] ?? "").trim();
    if (!customer && !category) continue;
    const cust = customer || "(미지정)";
    const b = bucket(cust);

    // 총수주금액: 구분이 '계약금'인 행의 프로젝트금액
    if (category.includes("계약금")) {
      const pa = toNum(row[idx.projectAmount]);
      b.total += pa; totals.total += pa;
    }

    // 수금대기: 세금계산서 발행칸에 날짜가 있으면 해당 행 '금액'
    if (idx.invoiceDate >= 0 && hasDate(row[idx.invoiceDate])) {
      const amt = toNum(row[idx.amount]);
      b.wait += amt; totals.wait += amt;
    }

    // 수금완료: 수금액 합계
    if (idx.received >= 0) {
      const rec = toNum(row[idx.received]);
      b.done += rec; totals.done += rec;
    }

    // 현 미수금: 미결제금액(TC) 합계
    if (idx.unpaid >= 0) {
      const up = toNum(row[idx.unpaid]);
      b.unpaid += up; totals.unpaid += up;
    }
  }

  return { totals, byCustomer };
}

/* ===== 렌더링 ===== */
let chart;

function render({ totals, byCustomer }) {
  document.getElementById("v-total").textContent = won(totals.total);
  document.getElementById("v-wait").textContent = won(totals.wait);
  document.getElementById("v-done").textContent = won(totals.done);
  document.getElementById("v-unpaid").textContent = won(totals.unpaid);

  // 총수주금액 기준 내림차순 정렬
  const entries = Object.entries(byCustomer)
    .sort((a, b) => b[1].total - a[1].total);

  // 테이블
  const tbody = document.querySelector("#table tbody");
  tbody.innerHTML = entries.map(([name, v]) => `
    <tr>
      <td>${name}</td>
      <td class="num-total">${won(v.total)}</td>
      <td class="num-wait">${won(v.wait)}</td>
      <td class="num-done">${won(v.done)}</td>
      <td class="num-unpaid">${won(v.unpaid)}</td>
    </tr>`).join("");

  const tfoot = document.querySelector("#table tfoot");
  tfoot.innerHTML = `
    <tr>
      <td>합계</td>
      <td class="num-total">${won(totals.total)}</td>
      <td class="num-wait">${won(totals.wait)}</td>
      <td class="num-done">${won(totals.done)}</td>
      <td class="num-unpaid">${won(totals.unpaid)}</td>
    </tr>`;

  // 차트
  const labels = entries.map(e => e[0]);
  const mk = key => entries.map(e => e[1][key]);
  if (chart) chart.destroy();
  chart = new Chart(document.getElementById("chart"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "총수주금액", data: mk("total"), backgroundColor: "#2563eb" },
        { label: "수금대기", data: mk("wait"), backgroundColor: "#d97706" },
        { label: "수금완료", data: mk("done"), backgroundColor: "#16a34a" },
        { label: "현 미수금", data: mk("unpaid"), backgroundColor: "#dc2626" },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: "top", labels: { font: { size: 12 } } },
        tooltip: { callbacks: { label: c => c.dataset.label + ": " + won(c.parsed.y) } }
      },
      scales: {
        y: { ticks: { callback: v => "₩" + (v / 1e8).toFixed(1) + "억" } },
        x: { ticks: { font: { size: 11 } } }
      }
    }
  });

  document.getElementById("placeholder").classList.add("hidden");
  document.getElementById("result").classList.remove("hidden");
}

/* ===== 파일 입력 ===== */
const drop = document.getElementById("drop");
const fileInput = document.getElementById("file");
const errBox = document.getElementById("error");

function showErr(msg) {
  errBox.textContent = "⚠ " + msg;
  errBox.classList.remove("hidden");
}

function handleFile(file) {
  errBox.classList.add("hidden");
  document.getElementById("filename").textContent = "📄 " + file.name;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb = XLSX.read(e.target.result, { type: "array", cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });
      render(analyze(rows));
    } catch (err) {
      showErr(err.message || "파일을 분석하지 못했습니다.");
    }
  };
  reader.readAsArrayBuffer(file);
}

fileInput.addEventListener("change", e => { if (e.target.files[0]) handleFile(e.target.files[0]); });
["dragenter","dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave","drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => { if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
