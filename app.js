const $ = (id) => document.getElementById(id);

const state = { type: 'receipt', tone: 'formal' };
const SETTINGS_KEY = 'rentalmind-consult-settings';
const SETTING_FIELDS = ['agent', 'hours'];
const MAIN_PHONE = '1660-2564';
const KAKAO_URL = 'https://open.kakao.com/o/sw7HPNVi';
const SAVED_KEY = 'rentalmind-custom-messages';
const LEAD_FIELDS = ['customer', 'customerPhone', 'productName', 'modelCode', 'productLink', 'promotion', 'contract', 'monthlyFee'];
const CUSTOMER_FIELDS = [...LEAD_FIELDS, 'productType', 'brand', 'model', 'cardFee', 'benefit', 'rewardAmount', 'rewardWhen', 'memo', 'leadPaste', 'commSearch'];

function val(id) {
  return $(id).value.trim();
}

function won(v) {
  const n = Number(String(v).replace(/[^0-9]/g, ''));
  return n ? n.toLocaleString('ko-KR') + '원' : '';
}

function features() {
  return [...document.querySelectorAll('#features input:checked')].map((c) => c.value);
}

// ───── 수수료표 (매월 초 브랜드별 엑셀을 한 번 등록해 한 달간 사용) ─────
// Claude 앱(아티팩트)에서는 공유 저장소(db)에 올려 모든 상담원이 같은 표를 보고,
// 로컬에서 열면 이 브라우저(localStorage)에만 저장한다.
const COMM_KEY = 'rentalmind-commission-tables';
const BRANDS = [
  { key: 'lg', name: 'LG전자', match: /LG/i },
  { key: 'coway', name: '코웨이', match: /코웨이/ },
  { key: 'skmagic', name: 'SK매직', match: /SK/i },
  { key: 'cuckoo', name: '쿠쿠', match: /쿠쿠/ },
  { key: 'chungho', name: '청호나이스', match: /청호/ },
];
// 브랜드명 → { date, month, uploadedAt, notes, rows: [[카테고리, 모델코드, 상품명, 관리구분, 약정명, 관리주기, 프로모션, 1년차, 예상수당, 지급수당]] }
let commTables = {};
let commDb = null;      // 공유 저장소 (없으면 null → localStorage 사용)
let commCanUpload = true;
let commStatus = '';    // 불러오는 중 / 연결 안 됨 안내
const COMM_COLS = ['카테고리', '모델코드', '상품명', '관리구분', '약정명', '관리주기', '프로모션', '1년차', '예상수당'];
const CHUNK_BYTES = 180 * 1024; // 문서 1개 한도(256KiB)보다 작게 나눠 저장

const thisMonth = () => new Date().toISOString().slice(0, 7);
const brandOf = (text) => BRANDS.find((b) => b.match.test(text));

async function loadComm() {
  try { commTables = JSON.parse(localStorage.getItem(COMM_KEY) || '{}'); } catch (e) { commTables = {}; }
  // 이전 버전에서 저장한 표에는 month 가 없음
  Object.values(commTables).forEach((t) => { t.month = t.month || (t.date || '').slice(0, 7); });
  refreshCommFilters();
  const db = await window.claude?.use?.('db');
  if (!db) return;
  commDb = db;
  commTables = {};
  const user = await window.claude.use('user');
  commCanUpload = user ? await user.canEdit() : false;
  commStatus = '등록된 수수료표를 불러오는 중…';
  refreshCommFilters();
  const timer = setTimeout(() => { commStatus = '수수료표 저장소에 아직 연결되지 않았어요. 잠시 후 다시 열어 주세요.'; refreshCommFilters(); }, 10000);
  // 브랜드별 요약 문서(5개)를 구독하고, 바뀐 브랜드만 나눠 저장된 행을 다시 읽음
  db.collection('commission').onSnapshot(async (snap) => {
    if (!snap.metadata.fromCache) { clearTimeout(timer); commStatus = ''; }
    for (const d of snap.docs) {
      const meta = d.data();
      const brand = BRANDS.find((b) => b.key === d.id);
      if (!brand || commTables[brand.name]?.uploadedAt === meta.uploadedAt) continue;
      const chunks = await db.collection(`commission/${d.id}/chunks`).get();
      const parts = chunks.docs.map((c) => c.data()).filter((c) => c.uploadedAt === meta.uploadedAt);
      if (parts.length !== meta.chunks) continue; // 다른 사람이 올리는 중이면 다음 알림 때 다시 읽음
      parts.sort((a, b) => a.index - b.index);
      commTables[brand.name] = { date: meta.date, month: meta.month, uploadedAt: meta.uploadedAt, notes: meta.notes || [], rows: parts.flatMap((c) => c.rows) };
    }
    refreshCommFilters();
  }, () => { clearTimeout(timer); commStatus = '수수료표를 불러오지 못했어요. 새로고침해 주세요.'; refreshCommFilters(); });
}

// 제목 행 "SK매직 수수료표 (2026-11-08 기준 · 상품 68개)" 와 그 아래 머리글 행을 기준으로 읽음
function parseCommSheet(rows, fileName) {
  const headerAt = rows.findIndex((r) => r.includes('모델코드') && r.includes('상품명'));
  if (headerAt < 0) return null;
  const header = rows[headerAt].map((h) => String(h).trim());
  const idx = COMM_COLS.map((c) => header.indexOf(c));
  const payIdx = header.findIndex((h) => h.startsWith('지급수당'));
  if (idx.some((i) => i < 0) || payIdx < 0) return null;
  const title = rows.slice(0, headerAt).map((r) => r.join(' ')).join(' ');
  const brand = brandOf(title) || brandOf(fileName);
  if (!brand) return { error: '브랜드(LG전자·코웨이·SK매직·쿠쿠·청호나이스)를 알 수 없어요' };
  const ymd = title.match(/(\d{4})-(\d{2})-(\d{2})/) || fileName.match(/(\d{4})(\d{2})(\d{2})/);
  const date = ymd ? `${ymd[1]}-${ymd[2]}-${ymd[3]}` : '';
  const num = (v) => Number(String(v).replace(/[^0-9.-]/g, '')) || 0;
  const data = rows.slice(headerAt + 1)
    .filter((r) => r[idx[1]])
    .map((r) => [...idx.map((i, k) => (k >= 7 ? num(r[i]) : String(r[i] ?? '').trim())), num(r[payIdx])]);
  const notes = rows.map((r) => String(r[0] ?? '').trim()).filter((c) => c.startsWith('※'));
  return { brand, date, month: date ? date.slice(0, 7) : thisMonth(), rows: data, notes };
}

async function saveCommTable(brand, table) {
  if (!commDb) {
    commTables[brand.name] = table;
    try { localStorage.setItem(COMM_KEY, JSON.stringify(commTables)); } catch (e) { return false; }
    return true;
  }
  // 행을 180KB 이하 묶음으로 나눠 chunks 에 쓰고, 마지막에 요약 문서를 바꿔 한 번에 교체되게 함
  const enc = new TextEncoder();
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const r of table.rows) {
    const b = enc.encode(JSON.stringify(r)).length + 1;
    if (size + b > CHUNK_BYTES && cur.length) { chunks.push(cur); cur = []; size = 0; }
    cur.push(r);
    size += b;
  }
  if (cur.length) chunks.push(cur);
  const col = commDb.collection(`commission/${brand.key}/chunks`);
  for (let i = 0; i < chunks.length; i++) {
    await col.doc(String(i)).set({ index: i, uploadedAt: table.uploadedAt, rows: chunks[i] });
  }
  const old = await col.get();
  for (const d of old.docs) if (Number(d.id) >= chunks.length) await col.doc(d.id).delete();
  await commDb.doc(`commission/${brand.key}`).set({
    brand: brand.name, date: table.date, month: table.month, uploadedAt: table.uploadedAt,
    notes: table.notes, chunks: chunks.length, rowCount: table.rows.length,
  });
  commTables[brand.name] = table;
  return true;
}

async function importCommFiles(files) {
  if (typeof XLSX === 'undefined') {
    toast('엑셀 읽기 도구를 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요.');
    return;
  }
  const done = [];
  const failed = [];
  $('commFile').disabled = true;
  commStatus = '수수료표를 등록하는 중…';
  refreshCommFilters();
  for (const file of files) {
    const name = file.name.normalize('NFC');
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
      const table = parseCommSheet(rows, name);
      if (!table || table.error) { failed.push(`${name}: ${table ? table.error : '모델코드·상품명·지급수당 열을 찾지 못했어요'}`); continue; }
      const { brand, ...rest } = table;
      const ok = await saveCommTable(brand, { ...rest, uploadedAt: new Date().toISOString() });
      done.push(`${brand.name} ${table.rows.length.toLocaleString('ko-KR')}행${ok ? '' : '(저장 실패)'}`);
    } catch (e) {
      failed.push(`${name}: ${e && e.code === 'quota_exceeded' ? '저장 공간이 가득 찼어요' : e && e.code === 'invalid_argument' ? '등록 권한이 없어요' : '읽거나 저장하지 못했어요'}`);
    }
  }
  $('commFile').value = '';
  $('commFile').disabled = false;
  commStatus = failed.join(' / ');
  refreshCommFilters();
  if (done.length) toast(`${done.join(', ')} 등록했어요.`);
}

function refreshCommFilters() {
  const month = thisMonth();
  const chips = BRANDS.map((b) => {
    const t = commTables[b.name];
    if (!t) return `<span class="brand-chip missing">${b.name} · 미등록</span>`;
    const stale = t.month !== month;
    return `<span class="brand-chip ${stale ? 'stale' : 'ok'}" title="${t.date || ''} 기준 · ${t.rows.length.toLocaleString('ko-KR')}행">${b.name} · ${t.month}${stale ? ' (지난 자료)' : ''}</span>`;
  }).join('');
  const missing = BRANDS.filter((b) => !commTables[b.name] || commTables[b.name].month !== month).map((b) => b.name);
  const hint = commStatus || (missing.length
    ? (commCanUpload ? `${month.replace('-', '년 ')}월 수수료표 등록 필요: ${missing.join(', ')}` : `${missing.join(', ')}의 이번 달 수수료표가 아직 등록되지 않았어요.`)
    : `${month.replace('-', '년 ')}월 수수료표 5개 브랜드 모두 등록됨`);
  // 공유 저장소가 없는 곳(로컬, GitHub Pages)에서는 이 브라우저에만 저장됨을 알림
  const where = commDb ? '' : ' · 이 브라우저에만 저장돼요';
  $('commLoaded').innerHTML = `<div class="brand-chips">${chips}</div><p class="comm-hint">${esc(hint + where)}</p>`;
  $('commUpload').hidden = !commCanUpload;
  const brands = Object.keys(commTables);
  keep($('commBrand'), brands, '브랜드');
  const terms = new Set();
  brands.forEach((b) => commTables[b].rows.forEach((r) => terms.add(r[4])));
  keep($('commTerm'), [...terms].filter(Boolean).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)), '약정');
  renderComm();
}

// 선택지를 다시 채우되, 고른 값이 남아 있으면 유지
function keep(sel, values, all) {
  const cur = sel.value;
  const html = `<option value="">${all}</option>` + values.map((v) => `<option>${esc(v)}</option>`).join('');
  if (sel.innerHTML !== html) sel.innerHTML = html;
  sel.value = values.includes(cur) ? cur : '';
}

// "방문관리 (패키지_신규)" → "방문관리". 전체 브랜드일 때는 이 큰 분류로만 고름
const careBase = (v) => String(v).replace(/\s*\(.*\)\s*$/, '').trim();
// 관리 선택지 = 관리구분 + 관리주기 (예: "방문관리 · 4개월관리")
// "자가관리(4M)" 처럼 관리구분에 붙은 (nM)은 "자가관리 · 4개월관리"와 같은 뜻으로 맞춤
const careKey = (r, brand) => {
  let raw = String(r[3] || '').trim();
  let cycle = String(r[5] || '').trim();
  const m = raw.match(/\s*\(\s*(\d+)\s*(?:M|개월)\s*\)/i);
  if (m) {
    raw = raw.replace(m[0], '').trim();
    if (!cycle || cycle === '-') cycle = `${m[1]}개월관리`;
  }
  const type = brand ? raw : careBase(raw);
  return cycle && cycle !== '-' ? `${type} · ${cycle}` : type;
};

// 관리 선택지: 브랜드를 고르면 그 브랜드의 관리구분 그대로, 아니면 큰 분류만. 많이 쓰이는 순서로
function refreshCareOptions(brand) {
  const counts = new Map();
  for (const [b, t] of Object.entries(commTables)) {
    if (brand && b !== brand) continue;
    t.rows.forEach((r) => { const k = r[3] && careKey(r, brand); if (k) counts.set(k, (counts.get(k) || 0) + 1); });
  }
  keep($('commCare'), [...counts].sort((a, b) => b[1] - a[1]).map(([v]) => v), '관리');
}

const norm = (v) => String(v).toLowerCase().replace(/[\s\-_]/g, '');
const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function renderComm() {
  const q = norm(val('commSearch'));
  const brand = $('commBrand').value;
  const term = $('commTerm').value;
  refreshCareOptions(brand);
  const care = $('commCare').value;
  const fee = Number(val('monthlyFee').replace(/[^0-9]/g, '')) || 0;
  const body = $('commBody');
  $('commNotes').innerHTML = '';
  if (!Object.keys(commTables).length) { body.innerHTML = ''; $('commCount').textContent = ''; return; }
  if (!q) { body.innerHTML = ''; $('commCount').textContent = '검색어를 입력하세요.'; return; }
  const hits = [];
  for (const [b, t] of Object.entries(commTables)) {
    if (brand && b !== brand) continue;
    for (const r of t.rows) {
      if (term && r[4] !== term) continue;
      if (care && careKey(r, brand) !== care) continue;
      if (norm(r[1]).includes(q) || norm(r[2]).includes(q)) hits.push([b, r]);
    }
  }
  // 모델코드 정확 일치 → 월렌탈이 리드와 같은 행 순으로 위에
  const score = ([, r]) => (norm(r[1]) === q ? 2 : 0) + (fee && r[7] === fee ? 1 : 0);
  hits.sort((a, b) => score(b) - score(a));
  const shown = hits.slice(0, 100);
  $('commCount').textContent = hits.length
    ? `${hits.length.toLocaleString('ko-KR')}건${hits.length > shown.length ? ` 중 ${shown.length}건 표시` : ''}${fee ? ` · 월렌탈 ${won(fee)}과 같은 행은 노란색` : ''}`
    : '검색 결과가 없어요.';
  // 검색 결과에 나온 브랜드의 엑셀 하단 ※ 안내문을 함께 표시
  const noteBrands = [...new Set(shown.map(([b]) => b))];
  $('commNotes').innerHTML = noteBrands.flatMap((b) => (commTables[b].notes || []).map((n) => `<p>${esc(b)} ${esc(n)}</p>`)).join('');
  body.innerHTML = shown.map(([b, r]) => `
    <tr class="${fee && r[7] === fee && norm(r[1]) === q ? 'match' : ''}">
      <td class="prod">${esc(r[2])}<span class="code">${esc(b)} · ${esc(r[1])}</span></td>
      <td>${esc(r[3])}<span class="code">${esc(r[5])}</span></td>
      <td>${esc(r[4])}</td>
      <td>${esc(r[6]) || '-'}</td>
      <td class="num">${r[7] ? won(r[7]) : '-'}</td>
      <td class="num">${r[8] ? won(r[8]) : '-'}</td>
      <td class="num pay">${r[9] ? won(r[9]) : '-'}</td>
      <td>${r[9] ? `<button type="button" class="use" data-pay="${r[9]}">수당에 넣기</button>` : ''}</td>
    </tr>`).join('');
}

function formatPhone(v) {
  const n = v.replace(/[^0-9]/g, '');
  if (n.length === 11) return n.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
  if (n.length === 10) return n.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
  return v.trim();
}

// 상품 링크는 광고 추적값(utm, gclid 등)을 빼고 ...detail.html?id=800 까지만
function cleanLink(url) {
  const m = url.match(/^(https?:\/\/[^?#\s]*detail\.html)\?(?:[^#\s]*&)?(id=[^&#\s]+)/);
  return m ? `${m[1]}?${m[2]}` : url;
}

// 상담 대시보드 리드 정보 → {이름}{연락처}{상품명}{모델코드}{링크위치}{프로모션}{개월수}{월렌탈}
function parseLead(text) {
  const line = (label) => {
    const m = text.match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'm'));
    const v = m ? m[1].trim() : '';
    return v === '-' ? '' : v;
  };
  const memo = line('메모');
  const memoParts = memo.split(/\s*[·/]\s*/);
  const promoAt = memoParts.indexOf('프로모션');
  const link = cleanLink((text.match(/https?:\/\/\S*detail\.html\S*/) || [])[0] || '');
  return {
    customer: line('이름'),
    customerPhone: formatPhone(line('연락처')),
    productName: line('상품명'),
    // 모델코드 줄이 없으면 상품명·링크 속 영문+숫자 코드(예: WPUIAC606SNW)로 대신
    modelCode: line('모델\\s*코드') || line('상품\\s*코드') || guessCode(line('상품명')),
    productLink: link,
    // "프로모션 · 반값 첫 15개월 월 22,450원" 처럼 '프로모션' 다음 항목
    promotion: promoAt >= 0 && memoParts[promoAt + 1] ? memoParts[promoAt + 1] : '',
    contract: (memoParts.find((p) => /^\d+\s*개월$/.test(p)) || '').replace(/\s/g, ''),
    // 메모 첫 항목 "[리뉴얼 상세] 자가관리(4M)" → 관리 필터용
    care: (memoParts[0] || '').replace(/^\[[^\]]*\]\s*/, '').trim(),
    monthlyFee: ((memo.match(/월렌탈\s*([\d,]+)/) || [])[1] || '').replace(/,/g, ''),
  };
}

function guessCode(text) {
  const m = (text || '').toUpperCase().match(/\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9-]{6,}\b/);
  return m ? m[0] : '';
}

// 모델코드 → 수수료표 검색어, 상품명의 [브랜드] → 브랜드 필터
let autoSearch = '';
function syncCommSearch(code, productName) {
  const cur = $('commSearch').value.trim();
  if (cur && cur !== autoSearch) return; // 상담원이 직접 입력한 검색어는 유지
  autoSearch = code || productName || '';
  $('commSearch').value = autoSearch;
  const brand = BRANDS.find((b) => b.match.test(productName || ''));
  if (brand && [...$('commBrand').options].some((o) => o.value === brand.name)) $('commBrand').value = brand.name;
  renderComm();
}

// 리드의 관리(예: 자가관리(4M))와 같은 관리 필터를 고름
function selectCare(care) {
  const sel = $('commCare');
  sel.value = '';
  if (care && /관리|케어|서비스/.test(care)) {
    const key = careKey(['', '', '', care, '', ''], $('commBrand').value);
    const opts = [...sel.options].map((o) => o.value).filter(Boolean);
    // 주기(4M 등)가 있을 때만 고름. "방문관리"처럼 주기가 없으면 전체를 보여줌
    if (key.includes(' · ') && opts.includes(key)) sel.value = key;
  }
  renderComm();
}

function applyLead() {
  const lead = parseLead($('leadPaste').value);
  const filled = LEAD_FIELDS.filter((f) => lead[f]);
  LEAD_FIELDS.forEach((f) => { $(f).value = lead[f] || ''; });
  autoSearch = $('commSearch').value.trim(); // 새 리드는 항상 덮어씀
  syncCommSearch(lead.modelCode, lead.productName);
  const years = parseInt(lead.contract, 10) / 12;
  $('commTerm').value = Number.isInteger(years) && [...$('commTerm').options].some((o) => o.value === `${years}년약정`) ? `${years}년약정` : '';
  renderComm();
  selectCare(lead.care);
  const missing = LEAD_FIELDS.filter((f) => !lead[f]).map((f) => $(f).closest('label').firstChild.textContent.trim());
  $('parseResult').textContent = filled.length
    ? `${filled.length}개 항목 입력됨${missing.length ? ` · 비어 있음: ${missing.join(', ')}` : ''}`
    : '리드 정보를 찾지 못했어요. 형식을 확인해 주세요.';
  render();
}

// "코웨이 얼음정수기 (아이콘 정수기 2)" 형태로 신청 제품 요약
function productLabel() {
  if (val('productName')) return val('productName');
  const parts = [val('brand'), val('productType') || '정수기'].filter(Boolean);
  let label = parts.join(' ');
  if (val('model')) label += ` (${val('model')})`;
  return label;
}

function collect() {
  return {
    name: val('customer') ? `${val('customer')} 고객님` : '고객님',
    product: productLabel(),
    customerPhone: val('customerPhone'),
    modelCode: val('modelCode'),
    link: cleanLink(val('productLink')),
    promotion: val('promotion'),
    reward: won(val('rewardAmount')),
    rewardWhen: val('rewardWhen'),
    feats: features(),
    fee: won(val('monthlyFee')),
    cardFee: won(val('cardFee')),
    contract: val('contract'),
    benefit: val('benefit'),
    memo: val('memo'),
    agent: val('agent'),
    phone: MAIN_PHONE,
    hours: val('hours'),
    kakao: KAKAO_URL,
    customTitle: val('customTitle'),
    customBody: val('customBody'),
  };
}

function contactLines(d, tone) {
  const lines = [];
  if (d.phone) lines.push(tone === 'friendly' ? `📞 대표번호: ${d.phone}` : `▶ 대표번호: ${d.phone}`);
  if (d.hours) lines.push(tone === 'friendly' ? `⏰ 상담시간: ${d.hours}` : `▶ 상담시간: ${d.hours}`);
  if (d.kakao) lines.push(tone === 'friendly' ? `💬 카카오톡 상담: ${d.kakao}` : `▶ 카카오톡 상담: ${d.kakao}`);
  return lines;
}

function signature(d, tone) {
  const who = d.agent ? `렌탈마인드 상담원 ${d.agent}` : '렌탈마인드';
  return tone === 'friendly' ? `${who} 드림 😊` : `- ${who} 드림 -`;
}

function featureText(d) {
  return d.feats.length ? `관심 기능(${d.feats.join(', ')})` : '';
}

function productLines(d, tone) {
  const b = tone === 'friendly' ? '✔️' : '·';
  const lines = [`${b} 상품명: ${d.product}`];
  if (d.modelCode) lines.push(`${b} 모델코드: ${d.modelCode}`);
  if (d.contract) lines.push(`${b} 약정기간: ${d.contract}`);
  if (d.fee) lines.push(`${b} 월 렌탈료: ${d.fee}`);
  if (d.promotion) lines.push(`${b} 프로모션: ${d.promotion}`);
  return lines;
}

function linkLine(d, tone) {
  if (!d.link) return [];
  return ['', tone === 'friendly' ? `🔗 상품 자세히 보기: ${d.link}` : `▶ 상품 상세 보기: ${d.link}`];
}

// 리드에 상품 상세 정보가 있을 때만 접수 안내에 신청 내역을 붙임
function receiptDetails(d, tone) {
  if (!(d.modelCode || d.fee || d.promotion || d.contract || d.link)) return [];
  return [
    '',
    tone === 'friendly' ? '📋 신청하신 내용이에요' : '[신청 내역]',
    ...productLines(d, tone),
    ...linkLine(d, tone),
  ];
}

function rewardLines(d, tone) {
  const amount = d.reward || '(금액 입력 필요)';
  if (tone === 'friendly') {
    return [
      `🎁 ${d.name}께 지급되는 수당은 ${amount}이에요!`,
      d.rewardWhen ? `지급 시기: ${d.rewardWhen}` : `지급 시기는 설치 완료 후 따로 안내드릴게요.`,
    ];
  }
  return [
    `[고객님 수당 안내]`,
    `· 지급 금액: ${amount}`,
    d.rewardWhen ? `· 지급 시기: ${d.rewardWhen}` : `· 지급 시기: 설치 완료 후 별도 안내`,
  ];
}

// 고객이 그대로 복사해 채워 보내는 접수 양식
function applyFormLines(d, tone) {
  const intro = tone === 'friendly'
    ? [`📝 접수 진행을 위해 아래 내용을 채워서 답장 주세요!`]
    : [`[접수 필요 정보]`, `원활한 접수를 위해 아래 양식을 복사하여 작성 후 회신 부탁드립니다.`];
  return [
    ...intro,
    ``,
    `1. 주민번호(앞 6자리-뒤 1자리): `,
    `2. 약정기간: ${d.contract}`,
    `3. 설치주소지: `,
    `4. 결제정보(은행계좌 또는 카드번호): `,
    `5. 결제일: `,
    `6. 설치요청일과 시간대: `,
    ``,
    ...(tone === 'friendly'
      ? [
        `주민번호는 꼭 앞 6자리와 뒤 1자리만 보내주세요 🙏`,
        `결제정보를 문자로 보내기 부담되시면 통화로 알려주셔도 괜찮아요.`,
        `보내주신 정보는 렌탈 접수에만 사용하고 안전하게 관리할게요 🔒`,
      ]
      : [
        `※ 주민번호는 앞 6자리와 뒤 1자리만 기재해 주세요.`,
        `※ 결제정보를 문자로 보내시기 부담되시면 상담원과 통화로 안내해 주셔도 됩니다.`,
        `※ 보내주신 정보는 렌탈 접수 목적으로만 사용되며 안전하게 관리됩니다.`,
      ]),
  ];
}

function quoteLines(d, tone) {
  const b = tone === 'friendly' ? '✔️' : '·';
  const lines = productLines(d, tone);
  if (d.cardFee) lines.push(`${b} 제휴카드 할인 시: 월 ${d.cardFee}~`);
  if (d.benefit) lines.push(`${b} 혜택: ${d.benefit}`);
  if (d.reward) lines.push(`${b} 고객님 수당: ${d.reward}${d.rewardWhen ? ` (${d.rewardWhen} 지급)` : ''}`);
  return [...lines, ...linkLine(d, tone)];
}

const templates = {
  receipt: {
    formal: (d) => [
      `[렌탈마인드] 정수기 렌탈 상담 신청 접수 안내`,
      ``,
      `안녕하세요, ${d.name}.`,
      `렌탈마인드에 ${receiptDetails(d, 'formal').length ? '정수기' : d.product} 렌탈 상담을 신청해 주셔서 감사합니다.`,
      ...receiptDetails(d, 'formal'),
      ``,
      ...rewardLines(d, 'formal'),
      ``,
      ...applyFormLines(d, 'formal'),
      ``,
      ...contactLines(d, 'formal'),
      ``,
      signature(d, 'formal'),
    ],
    friendly: (d) => [
      `안녕하세요 ${d.name}! 렌탈마인드입니다 💧`,
      ``,
      `${receiptDetails(d, 'friendly').length ? '정수기' : d.product} 렌탈 상담 신청 잘 받았어요 🙌`,
      ...receiptDetails(d, 'friendly'),
      ``,
      ...rewardLines(d, 'friendly'),
      ``,
      ...applyFormLines(d, 'friendly'),
      ``,
      ...contactLines(d, 'friendly'),
      ``,
      signature(d, 'friendly'),
    ],
    short: (d) => [
      `[렌탈마인드] ${d.name}, 정수기 상담 신청 접수되었습니다.${d.reward ? ` 고객님 수당 ${d.reward} 지급 예정.` : ''} 곧 연락드리겠습니다.${d.phone ? ` ☎${d.phone}` : ''}`,
    ],
  },
  quote: {
    formal: (d) => [
      `[렌탈마인드] 정수기 렌탈 견적 및 혜택 안내`,
      ``,
      `안녕하세요, ${d.name}.`,
      `상담해 주셔서 감사합니다. 문의하신 내용으로 견적을 안내드립니다.`,
      ``,
      ...quoteLines(d, 'formal'),
      ``,
      `※ 렌탈료는 카드사 실적·프로모션 기간에 따라 달라질 수 있습니다.`,
      `궁금하신 점이나 진행을 원하시면 편하게 연락 주세요.`,
      ``,
      ...contactLines(d, 'formal'),
      ``,
      signature(d, 'formal'),
    ],
    friendly: (d) => [
      `${d.name}, 상담 감사드려요! 렌탈마인드입니다 💧`,
      `말씀 나눈 내용으로 견적 정리해 드릴게요 📝`,
      ``,
      ...quoteLines(d, 'friendly'),
      ``,
      `※ 카드 실적이나 프로모션 기간에 따라 요금이 달라질 수 있어요.`,
      `진행 원하시거나 궁금한 점 있으면 언제든 말씀해 주세요 🙂`,
      ``,
      ...contactLines(d, 'friendly'),
      ``,
      signature(d, 'friendly'),
    ],
    short: (d) => [
      `[렌탈마인드] ${d.name}, ${d.product}${d.fee ? ` 월 ${d.fee}` : ''}${d.contract ? `(${d.contract})` : ''}${d.promotion ? `, ${d.promotion}` : ''}${d.benefit ? `, ${d.benefit}` : ''}${d.reward ? `, 수당 ${d.reward}` : ''}. 문의 ${d.phone || '회신 부탁드립니다'}${d.link ? ` ${d.link}` : ''}`,
    ],
  },
  custom: {
    formal: (d) => [
      `[렌탈마인드] ${d.customTitle || '안내 말씀드립니다'}`,
      ``,
      `안녕하세요, ${d.name}.`,
      ``,
      fillVars(d.customBody, d) || '(내용 입력 필요)',
      ``,
      ...contactLines(d, 'formal'),
      ``,
      signature(d, 'formal'),
    ],
    friendly: (d) => [
      `안녕하세요 ${d.name}! 렌탈마인드입니다 💧`,
      d.customTitle ? `📢 ${d.customTitle}` : null,
      ``,
      fillVars(d.customBody, d) || '(내용 입력 필요)',
      ``,
      ...contactLines(d, 'friendly'),
      ``,
      signature(d, 'friendly'),
    ],
    short: (d) => [
      `[렌탈마인드] ${d.name}, ${fillVars(d.customBody, d).replace(/\s*\n\s*/g, ' ') || '(내용 입력 필요)'}`,
    ],
  },
};

// 추가 메시지 본문의 {이름} 등을 입력값으로 치환 (값이 없으면 그대로 둠)
function fillVars(text, d) {
  const vars = {
    이름: val('customer'),
    상품명: val('productName') ? d.product : '',
    모델코드: d.modelCode,
    약정: d.contract,
    월렌탈: d.fee,
    프로모션: d.promotion,
    수당: d.reward,
  };
  return text.replace(/\{(이름|상품명|모델코드|약정|월렌탈|프로모션|수당)\}/g, (m, k) => vars[k] || m);
}

function build() {
  const d = collect();
  // null은 입력하지 않은 선택 항목 줄
  const lines = templates[state.type][state.tone](d).filter((l) => l !== null);
  if (d.memo && state.type !== 'custom') {
    if (state.tone === 'short') {
      lines[0] += ` ${d.memo}`;
    } else {
      // 연락처(없으면 서명) 바로 앞에 메모 삽입
      const tail = [...contactLines(d, state.tone), signature(d, state.tone)];
      const at = lines.findIndex((l) => tail.includes(l));
      lines.splice(at, 0, d.memo, '');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// 한글 2byte, 그 외 1byte (국내 문자 발송 기준)
function byteLength(str) {
  let n = 0;
  for (const ch of str) n += ch.charCodeAt(0) > 127 ? 2 : 1;
  return n;
}

function updateBytes() {
  const b = byteLength($('output').value);
  const el = $('bytes');
  const kind = b <= 90 ? 'SMS 단문' : b <= 2000 ? 'LMS 장문' : '2000byte 초과';
  el.textContent = `${b} byte · ${kind}`;
  el.classList.toggle('lms', b > 90);
}

function phoneDigits() {
  return val('customerPhone').replace(/[^0-9]/g, '');
}

// 메시지가 바뀌면 확인 체크를 풀어서 다시 확인하도록 함
function resetConfirm() {
  $('confirmCheck').checked = false;
  updateSendState();
}

function updateSendState() {
  const digits = phoneDigits();
  const validPhone = /^01\d{8,9}$/.test(digits);
  const r = $('recipient');
  if (!digits) r.textContent = '받는 사람: 연락처를 입력해 주세요.';
  else if (!validPhone) r.textContent = `받는 사람: ${val('customerPhone')} — 휴대폰 번호 형식이 아니에요.`;
  else r.textContent = `받는 사람: ${val('customer') || '고객'} (${formatPhone(digits)})`;
  r.classList.toggle('warn', !validPhone);
  $('sendBtn').disabled = !($('confirmCheck').checked && validPhone && $('output').value.trim());
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    $('output').select();
    document.execCommand('copy');
  }
}

async function send() {
  const text = $('output').value.trim();
  const digits = phoneDigits();
  // 확인 체크박스가 발송 전 확인 단계 (브라우저 confirm 창은 쓰지 않음)
  // 문자 앱에 본문이 안 들어가는 환경을 대비해 클립보드에도 복사
  await writeClipboard(text);
  const a = document.createElement('a');
  a.href = `sms:${digits}?&body=${encodeURIComponent(text)}`;
  a.click();
  toast('메시지를 복사했어요. 문자 앱이 열리지 않으면 직접 붙여넣기 하세요.');
}

function render() {
  document.querySelectorAll('.conditional').forEach((el) => {
    el.classList.toggle('show', el.dataset.show === state.type);
  });
  document.querySelectorAll('[data-hide]').forEach((el) => {
    el.hidden = el.dataset.hide === state.type;
  });
  const reward = won(val('rewardAmount'));
  $('rewardPreview').textContent = reward
    ? `✔ 문자에 "${reward}"으로 들어가요.${state.type === 'custom' ? ' (추가 메시지는 {수당} 을 쓴 곳에 표시)' : ''}`
    : '금액을 입력하면 문자에 자동으로 들어가요.';
  $('output').value = build();
  updateBytes();
  resetConfirm();
  renderComm();
}

function setupChips(containerId, key) {
  $(containerId).addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    $(containerId).querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    btn.classList.add('active');
    state[key] = btn.dataset[key];
    render();
  });
}

function loadSaved() {
  try {
    const list = JSON.parse(localStorage.getItem(SAVED_KEY) || 'null');
    if (Array.isArray(list)) return list;
  } catch (e) { /* 저장 불가 환경 */ }
  return [
    { title: '설치 일정 안내', body: '{상품명} 설치 일정 안내드립니다.\n설치 기사님이 방문 전 연락드릴 예정이니 확인 부탁드립니다.' },
    { title: '접수 정보 재요청', body: '접수 진행을 위해 보내주신 정보 중 일부 확인이 필요합니다.\n편하실 때 회신 또는 통화 부탁드립니다.' },
  ];
}

function storeSaved(list) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)); } catch (e) { /* 무시 */ }
}

function renderSaved() {
  const box = $('savedChips');
  box.innerHTML = '';
  loadSaved().forEach((item, i) => {
    const wrap = document.createElement('span');
    wrap.className = 'chip saved-chip';
    const load = document.createElement('span');
    load.textContent = item.title || item.body.slice(0, 12);
    load.style.cursor = 'pointer';
    load.addEventListener('click', () => {
      $('customTitle').value = item.title;
      $('customBody').value = item.body;
      render();
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.textContent = '×';
    del.title = '삭제';
    // 첫 클릭은 '삭제?' 확인 표시, 두 번째 클릭에 삭제
    del.addEventListener('click', () => {
      if (!del.classList.contains('armed')) {
        del.classList.add('armed');
        del.textContent = '삭제?';
        setTimeout(() => { del.classList.remove('armed'); del.textContent = '×'; }, 3000);
        return;
      }
      const list = loadSaved();
      list.splice(i, 1);
      storeSaved(list);
      renderSaved();
    });
    wrap.append(load, del);
    box.append(wrap);
  });
}

function saveCustom() {
  const body = $('customBody').value.trim();
  if (!body) { toast('저장할 내용을 먼저 입력해 주세요.'); return; }
  const title = val('customTitle');
  const list = loadSaved().filter((m) => !(title && m.title === title));
  list.push({ title, body });
  storeSaved(list);
  renderSaved();
  toast('자주 쓰는 메시지에 저장했어요.');
}

function loadSettings() {
  $('kakao').value = KAKAO_URL;
  $('phone').value = MAIN_PHONE;
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    SETTING_FIELDS.forEach((f) => { if (saved[f]) $(f).value = saved[f]; });
    if (!SETTING_FIELDS.some((f) => saved[f])) $('settingsBox').open = true;
  } catch (e) {
    $('settingsBox').open = true;
  }
}

function saveSettings() {
  try {
    const data = {};
    SETTING_FIELDS.forEach((f) => { data[f] = val(f); });
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
  } catch (e) { /* 저장 불가 환경은 무시 */ }
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.textContent = ''; }, 2000);
}

async function copy() {
  await writeClipboard($('output').value);
  toast('메시지를 복사했어요. 문자·카톡에 붙여넣기 하세요.');
}

// 새 리드: 고객·상품 입력과 수수료표 필터를 비우고 리드 칸으로 이동 (상담원 정보·수수료표는 유지)
function newLead() {
  CUSTOMER_FIELDS.forEach((f) => { $(f).value = ''; });
  document.querySelectorAll('#features input').forEach((c) => { c.checked = false; });
  ['commBrand', 'commTerm', 'commCare'].forEach((id) => { $(id).value = ''; });
  autoSearch = '';
  $('parseResult').textContent = '';
  resetConfirm();
  render();
  $('leadPaste').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('leadPaste').focus({ preventScroll: true });
  toast('새 리드를 붙여넣어 주세요.');
}

function reset() {
  CUSTOMER_FIELDS.forEach((f) => { $(f).value = ''; });
  document.querySelectorAll('#features input').forEach((c) => { c.checked = false; });
  $('parseResult').textContent = '';
  render();
  toast('고객 정보를 초기화했어요.');
}

setupChips('typeChips', 'type');
setupChips('toneChips', 'tone');
loadSettings();

document.querySelector('.form').addEventListener('input', (e) => {
  if (SETTING_FIELDS.includes(e.target.id)) saveSettings();
  render();
});
document.querySelector('.form').addEventListener('change', render);
$('output').addEventListener('input', () => { updateBytes(); resetConfirm(); });
$('confirmCheck').addEventListener('change', updateSendState);
$('sendBtn').addEventListener('click', send);
$('copyBtn').addEventListener('click', copy);
$('resetBtn').addEventListener('click', reset);
$('parseBtn').addEventListener('click', applyLead);
$('newLeadBtn').addEventListener('click', newLead);
$('saveCustomBtn').addEventListener('click', saveCustom);
$('commFile').addEventListener('change', (e) => importCommFiles(e.target.files));
$('commBody').addEventListener('click', (e) => {
  const btn = e.target.closest('.use');
  if (!btn) return;
  $('rewardAmount').value = btn.dataset.pay;
  render();
  toast(`수당 금액에 ${won(btn.dataset.pay)}을 넣었어요.`);
});
loadComm();
renderSaved();
// 붙여넣기·직접 입력 모두 자동 반영 (입력은 잠시 멈추면 반영)
let leadTimer;
$('leadPaste').addEventListener('paste', () => { clearTimeout(leadTimer); setTimeout(applyLead, 0); });
$('leadPaste').addEventListener('input', () => {
  clearTimeout(leadTimer);
  leadTimer = setTimeout(() => { if (/모델\s*코드|상품명|이름\s*:/.test($('leadPaste').value)) applyLead(); }, 600);
});
$('modelCode').addEventListener('input', () => syncCommSearch(val('modelCode'), val('productName')));

render();
