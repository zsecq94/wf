#!/usr/bin/env node
// wf — git 이력 기반 일일 작업 내역 추출 + 진척도 관리 CLI (외부 의존성 없음)
//
//   wf add <git-url|경로> [이름]   저장소 등록 (repos/<이름>.git 에 mirror clone)
//   wf ls                          등록된 저장소·설정 확인
//   wf sync                        모든 저장소 fetch
//   wf daily [범위]                 작업 내역 출력 (기본: 오늘, fetch 후 실행. last = 마지막 보고 이후)
//   wf progress ...                진척도(progress.md) 조회/갱신
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPOS_DIR = join(ROOT, 'repos');
const CONFIG_FILE = join(ROOT, 'config.json');
const PROGRESS_FILE = join(ROOT, 'progress.md');
const execFileAsync = promisify(execFile);

const log = (...a) => console.error(...a); // 진행 메시지는 stderr → stdout은 파이프용으로 깨끗하게 유지
const die = (msg) => { log(msg); process.exit(1); };

// config.json (gitignore 대상 — 사람마다 다르다. 양식은 config.example.json)
//   authors:  집계할 커밋 작성자 이메일 (없으면 git config user.email)
//   products: 커밋 → 보고용 제품명 규칙 (선택). 순서대로 평가한다.
//     { repo?, scope?: [..], path?: [..], name }  scope 는 `type(scope):` 접두, path 는 변경 파일 경로 접두
//     scope/path 가 모두 없는 규칙은 그 저장소의 기본값
const config = loadConfig();
function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  let c;
  try { c = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { return die(`config.json 파싱 실패: ${e.message}\n  config.example.json 을 참고해 고치세요.`); }
  // 타입이 어긋나면 스택 트레이스 대신 어디가 틀렸는지 알려 준다
  const bad = (what) => die(`config.json 형식 오류: ${what}\n  양식: config.example.json`);
  if (c === null || typeof c !== 'object' || Array.isArray(c)) bad('최상위는 { } 객체여야 합니다');
  if (c.authors != null && !(Array.isArray(c.authors) && c.authors.every((a) => typeof a === 'string'))) bad('authors 는 이메일 문자열 배열이어야 합니다');
  if (c.products != null && !Array.isArray(c.products)) bad('products 는 규칙 배열이어야 합니다');
  for (const [i, r] of (c.products ?? []).entries()) {
    if (!r || typeof r !== 'object' || typeof r.name !== 'string') bad(`products[${i}] 에 name(문자열)이 필요합니다`);
    for (const k of ['scope', 'path']) if (r[k] != null && !Array.isArray(r[k])) bad(`products[${i}].${k} 는 배열이어야 합니다`);
  }
  return c;
}

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts,
  });
}

// --since-as-filter 는 git 2.37 에서 생겼다. 그보다 낮으면 log 가 실패해 "커밋 0개" 로 보일 수 있으므로 미리 막는다.
function requireGit() {
  let v;
  try { v = git(ROOT, ['--version']); } catch { return die('git 을 찾을 수 없습니다. PATH 를 확인하세요.'); }
  const [maj, min] = (/(\d+)\.(\d+)/.exec(v) ?? []).slice(1).map(Number);
  if (!(maj > 2 || (maj === 2 && min >= 37))) die(`git ${maj}.${min} 감지 — 2.37 이상이 필요합니다 (--since-as-filter).`);
}

function authors() {
  if (config.authors?.length) return config.authors;
  try { return [git(ROOT, ['config', 'user.email']).trim()]; } catch { return []; }
}

function repos() {
  if (!existsSync(REPOS_DIR)) return [];
  return readdirSync(REPOS_DIR).filter((n) => n.endsWith('.git')).sort()
    .map((n) => ({ name: n.slice(0, -4), dir: join(REPOS_DIR, n) }));
}

// ---------- 날짜 ----------
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }; // 로컬 자정
const addDays = (s, n) => { const d = fromYmd(s); d.setDate(d.getDate() + n); return ymd(d); };

// 하루:  'today' | 'yesterday' | '-3' | 'YYYY-MM-DD'      범위: 'A..B'
// 기간:  'last' (마지막 보고 다음 날 ~ 오늘 — progress.md 최신 섹션 날짜 기준)
//        'week' (이번 주 월요일 ~ 오늘) | 'lastweek' (지난주 월~일) | 'month' (이달 1일 ~ 오늘)
const RANGE_HELP = 'today | yesterday | -N | YYYY-MM-DD | A..B | last | week | lastweek | month';
function parseRange(arg = 'today') {
  const shift = (days, base = new Date()) => { const d = new Date(base); d.setDate(d.getDate() + days); return ymd(d); };
  const today = shift(0);
  const monday = (d) => shift(-((d.getDay() + 6) % 7), d); // 일요일(0) 은 -6
  if (arg === 'last') {
    const latest = loadProgress().at(-1)?.date;
    if (!latest) die('progress.md 에 날짜 섹션이 없어 마지막 보고일을 알 수 없습니다. 범위를 직접 주세요.');
    return { from: latest < today ? addDays(latest, 1) : today, to: today };
  }
  if (arg === 'week') return { from: monday(new Date()), to: today };
  if (arg === 'lastweek') { const from = addDays(monday(new Date()), -7); return { from, to: addDays(from, 6) }; }
  if (arg === 'month') return { from: today.slice(0, 8) + '01', to: today };
  const one = (s) => {
    if (s === 'today') return today;
    if (s === 'yesterday') return shift(-1);
    if (/^-\d+$/.test(s)) return shift(Number(s));
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return die(`날짜 형식 오류: ${s}  (${RANGE_HELP})`);
  };
  const [a, b = a] = arg.split('..');
  return { from: one(a), to: one(b) };
}

// ---------- 커밋 수집 ----------
const FS = '\x1f', RS = '\x1e';

function collect(repo, { from, to }) {
  const args = [
    '-c', 'core.quotePath=false', 'log', '--branches', '--tags', '--source', '--no-merges', '--reverse', '--numstat',
    `--since-as-filter=${from} 00:00:00`, `--until=${to} 23:59:59`,
    '--date=format-local:%Y-%m-%d %H:%M',
    `--format=${RS}%H${FS}%h${FS}%ae${FS}%cd${FS}%S${FS}%s${FS}%b${FS}`,
    // <email> 로 감싸 정확 일치 (부분 일치면 me@x.com 이 some@x.com 까지 잡는다). -F 로 +·. 을 문자 그대로.
    '--fixed-strings', ...authors().map((a) => `--author=<${a}>`),
  ];
  let out;
  try { out = git(repo.dir, args); }
  catch (e) { return { commits: [], error: (e.stderr || e.message).trim().split('\n')[0] || 'git log 실패' }; }
  const commits = out.split(RS).filter(Boolean).map((chunk) => {
    const [hash, short, email, date, source, subject, body, stat] = chunk.split(FS);
    const files = []; let add = 0, del = 0;
    for (const line of (stat || '').split('\n')) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!m) continue;
      if (m[1] !== '-') { add += +m[1]; del += +m[2]; }
      files.push(m[3]);
    }
    return {
      hash, short, email, date, subject, body: body.trim(), files, add, del,
      branch: source.replace(/^refs\/(heads|tags|remotes)\//, ''),
    };
  });
  return { commits };
}

// ---------- 제품 매핑 ----------
// 커밋 제목의 scope 를 먼저 보고(작성자의 의도), 없으면 변경 파일 경로로 판단한다.
// 경로로는 여러 제품에 걸칠 수 있으므로 ' · ' 로 이어 붙인다. 아무 규칙에도 안 걸리면 저장소 기본 규칙.
const scopesOf = (subject) => (/^\w+\(([^)]+)\)!?:/.exec(subject)?.[1] ?? '').split(/[,/ ]+/).filter(Boolean);
const underPath = (file, prefix) => file === prefix || file.startsWith(prefix.replace(/\/?$/, '/'));

function productOf(repoName, c) {
  const rules = (config.products ?? []).filter((r) => r.name && (!r.repo || r.repo === repoName));
  if (!rules.length) return null;
  const scopes = scopesOf(c.subject);
  const byScope = rules.find((r) => r.scope?.some((s) => scopes.includes(s)));
  if (byScope) return byScope.name;
  const byPath = [...new Set(rules.filter((r) => r.path?.some((p) => c.files.some((f) => underPath(f, p)))).map((r) => r.name))];
  if (byPath.length) return byPath.join(' · ');
  return rules.find((r) => !r.scope?.length && !r.path?.length)?.name ?? null;
}

function renderDaily(range, results, days = 7) {
  const { from, to } = range;
  const single = from === to;
  const all = results.flatMap((r) => r.commits);
  const sum = (k) => all.reduce((s, c) => s + c[k], 0);
  const L = [
    `# ${single ? from : `${from} ~ ${to}`} 작업 내역`, '',
    `- 작성자: ${authors().join(', ')}`,
    `- 커밋 ${all.length}개 / 저장소 ${results.filter((r) => r.commits.length).length}개 / +${sum('add')} -${sum('del')}${results.some((r) => r.error) ? ' / 수집 실패 있음' : ''}`,
  ];
  const products = [...new Set((config.products ?? []).map((r) => r.name))];
  L.push(products.length ? `- 제품 (커밋 앞 [태그], config.json products): ${products.join(' / ')}` : '- 제품 매핑 없음 — config.json 의 products 를 채우면 커밋마다 [제품명] 태그가 붙습니다', '');
  for (const r of results) {
    if (!r.commits.length) continue;
    L.push(`## ${r.name} (${r.commits.length} commits)`, '');
    const byBranch = new Map();
    for (const c of r.commits) (byBranch.get(c.branch) ?? byBranch.set(c.branch, []).get(c.branch)).push(c);
    for (const [branch, commits] of byBranch) {
      L.push(`### ${branch}`);
      for (const c of commits) {
        const when = single ? c.date.slice(11) : c.date.slice(5);
        const tag = c.product ? `[${c.product}] ` : '';
        L.push(`- \`${c.short}\` ${when} ${tag}${c.subject} (+${c.add}/-${c.del})`);
        if (c.files.length) {
          const shown = c.files.slice(0, 8).join(', ');
          L.push(`  - ${shown}${c.files.length > 8 ? ` 외 ${c.files.length - 8}개` : ''}`);
        }
        for (const b of c.body.split('\n').filter(Boolean)) L.push(`  > ${b}`);
      }
      L.push('');
    }
  }
  const idle = results.filter((r) => !r.error && !r.commits.length).map((r) => r.name);
  if (idle.length) L.push(`_커밋 없음: ${idle.join(', ')}_`, '');
  const failed = results.filter((r) => r.error);
  if (failed.length) L.push(`**수집 실패 (보고에서 빠짐):** ${failed.map((r) => `${r.name} — ${r.error}`).join(' / ')}`, '');
  const sections = loadProgress();
  if (sections.length) {
    // 보고일 섹션 — 오늘 보고일 때만 만들어 저장한다(마지막 보고일의 근거). 과거 범위 조회는 미리보기만.
    const { sec, created } = ensureSection(sections, to);
    if (created && to === ymd(new Date())) { saveProgress(sections); log(`progress.md: ${to} 섹션 생성 (${created})`); }
    else if (created) log(`progress.md: ${to} 섹션 없음 — 미리보기 (${created}), progress set --date=${to} 하면 생성`);
    L.push(`## 진척도 (${sec.date})`, '', renderBoard(sections, to, days), '');
  }
  return L.join('\n');
}

// ---------- 진척도 (progress.md) ----------
// 날짜별 섹션으로 쌓인다. 새 날짜 섹션은 직전 섹션을 복사해서 시작한다.
//   ## YYYY-MM-DD
//   <제목> - <N>%        (제목에 ' - ' 포함 가능)
//   - <메모>              (직전 항목에 귀속)
function loadProgress() {
  const sections = [];
  if (!existsSync(PROGRESS_FILE)) return sections;
  let cur = null;
  for (const raw of readFileSync(PROGRESS_FILE, 'utf8').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    let m;
    if ((m = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/.exec(line))) { cur = { date: m[1], items: [] }; sections.push(cur); continue; }
    if (!cur) { cur = { date: ymd(new Date()), items: [] }; sections.push(cur); } // 헤더 없는 옛 형식 → 오늘 날짜로 흡수
    if ((m = /^(.*\S)\s+-\s+(\d{1,3})%$/.exec(line))) cur.items.push({ title: m[1], pct: +m[2], notes: [] });
    else if ((m = /^-\s+(.*)$/.exec(line)) && cur.items.at(-1)?.notes) cur.items.at(-1).notes.push(m[1]);
    else cur.items.push({ raw: line }); // 형식 밖의 줄은 그대로 보존
  }
  return sections.sort((a, b) => a.date.localeCompare(b.date));
}

function renderItems(items) {
  return items
    .map((i) => (i.raw != null ? i.raw : [`${i.title} - ${i.pct}%`, ...i.notes.map((n) => `- ${n}`)].join('\n')))
    .join('\n');
}

// 보고용 보기 — 저장 형식과 같은 `제목 - N%` 한 줄 형식이되, 보고일 섹션의 진행 중 항목 뒤에
// 최근 days 일 안에 완료된 항목을 `제목 - 100%` 로 같이 둔다. 완료가 다음 날 바로 사라져 진척이
// 누적돼 보이지 않던 것을 막는다. 파일은 바꾸지 않는다.
function renderBoard(sections, date, days = 7) {
  const sec = sections.find((s) => s.date === date);
  const open = (sec?.items ?? []).filter((i) => i.raw != null || i.pct < 100);
  const done = new Map(); // title → 완료한 날의 항목 (같은 제목이 여러 날 100% 면 마지막 날)
  const since = addDays(date, -days);
  for (const s of sections) {
    if (s.date < since || s.date > date) continue;
    for (const i of s.items) if (i.raw == null && i.pct === 100) done.set(i.title, { ...i, date: s.date });
  }
  const recent = [...done.values()].sort((a, b) => b.date.localeCompare(a.date));
  const out = renderItems([...open, ...recent]);
  return out || '(항목 없음)';
}

function saveProgress(sections) {
  writeFileSync(PROGRESS_FILE, sections.map((s) => `## ${s.date}\n\n${renderItems(s.items)}\n`).join('\n'));
}

// date 섹션을 돌려준다. 없으면 그 날짜보다 앞선 마지막 섹션에서 아직 100% 가 아닌 항목만 복사해 만든다
// (완료 항목은 완료된 날 섹션에만 남는다). 앞선 섹션이 없으면(뒤 날짜만 있으면) 빈 섹션 — 미래 상태를
// 과거로 복사하지 않는다. 변경 사항은 저장하지 않음 — 호출자가 저장.
function ensureSection(sections, date) {
  let sec = sections.find((s) => s.date === date);
  if (sec) return { sec, created: false };
  const prev = [...sections].reverse().find((s) => s.date < date);
  sec = { date, items: structuredClone((prev?.items ?? []).filter((i) => i.raw == null && i.pct < 100)) };
  sections.push(sec);
  sections.sort((a, b) => a.date.localeCompare(b.date));
  return { sec, created: prev ? `${prev.date} 미완료 항목 복사` : '앞선 섹션 없음 — 빈 섹션' };
}

function findItem(items, q) {
  const real = items.filter((i) => i.raw == null);
  const exact = real.find((i) => i.title === q);
  if (exact) return exact;
  const hits = real.filter((i) => i.title.toLowerCase().includes(q.toLowerCase()));
  if (hits.length > 1) die(`여러 항목과 일치합니다: ${hits.map((h) => `"${h.title}"`).join(', ')}`);
  return hits[0];
}

function cmdProgress([sub, title, ...rest], flags) {
  const sections = loadProgress();
  const dateFlag = [...flags].find((f) => f.startsWith('--date='))?.slice(7);
  if (dateFlag && !/^\d{4}-\d{2}-\d{2}$/.test(dateFlag)) die('--date=YYYY-MM-DD 형식으로 주세요.');

  const days = Number([...flags].find((f) => f.startsWith('--days='))?.slice(7) ?? 7);
  if (!Number.isInteger(days) || days < 0) die('--days=N (0 이상 정수) 형식으로 주세요.');

  if (!sub) { // 조회: 지정 날짜(없으면 최신 섹션)의 보고용 보기. 섹션이 없으면 만들지 않고 미리보기만.
    if (!sections.length) return log('progress.md 가 비어 있습니다. wf progress set "<제목>" <N> 으로 추가하세요.');
    const date = dateFlag ?? sections.at(-1).date;
    const { created } = ensureSection(sections, date);
    log(`[${date}]${created ? ` (섹션 없음 — ${created}, set 하면 생성)` : ''}${days ? ` 완료 ${days}일` : ''}`);
    return console.log(renderBoard(sections, date, days));
  }
  if (sub === 'done') { // 기간 안에 100% 가 된 항목 (완료 항목은 완료한 날 섹션에만 남는다)
    const { from, to } = parseRange(title ?? 'month');
    const seen = new Set(), done = [];
    for (const s of sections) {
      if (s.date < from || s.date > to) continue;
      for (const i of s.items) if (i.raw == null && i.pct === 100 && !seen.has(i.title)) { seen.add(i.title); done.push({ date: s.date, ...i }); }
    }
    log(`[${from} ~ ${to}] 완료 ${done.length}건`);
    for (const i of done) console.log([`${i.date}  ${i.title}`, ...i.notes.map((n) => `  - ${n}`)].join('\n'));
    return;
  }
  if (sub === 'history') { // 항목별 진척률 추이
    const titles = [...new Set(sections.flatMap((s) => s.items.filter((i) => i.raw == null).map((i) => i.title)))]
      .filter((t) => !title || t.toLowerCase().includes(title.toLowerCase()));
    for (const t of titles) {
      const trail = []; let last;
      for (const s of sections) { const i = s.items.find((x) => x.title === t); if (i && i.pct !== last) { trail.push(`${s.date.slice(5)} ${i.pct}%`); last = i.pct; } }
      console.log(`${t}\n  ${trail.join(' → ')}`);
    }
    return;
  }

  if (!title) die(`사용법: wf progress ${sub} "<제목>" ...`);
  const { sec, created } = ensureSection(sections, dateFlag ?? ymd(new Date()));
  if (created) log(`새 섹션 ${sec.date} (${created})`);
  let item = findItem(sec.items, title);
  switch (sub) {
    case 'set': {
      const raw = String(rest[0] ?? '').replace(/%$/, '');
      const pct = Number(raw);
      if (!/^\d{1,3}$/.test(raw) || pct > 100) die(`진척률은 0-100 정수여야 합니다: ${rest[0] ?? '(없음)'}  — 사용법: wf progress set "<제목>" <0-100> ["메모"]`);
      if (!item) { item = { title, pct, notes: [] }; sec.items.push(item); log(`추가: ${title} - ${pct}%`); }
      else { log(`갱신: ${item.title} ${item.pct}% → ${pct}%`); item.pct = pct; }
      if (rest[1]) item.notes.push(rest[1]);
      break;
    }
    case 'note':
      if (!item) die(`항목 없음: ${title}`);
      if (!rest[0]) die('사용법: wf progress note "<제목>" "<메모>"');
      item.notes.push(rest[0]);
      log(`메모 추가: ${item.title}`);
      break;
    case 'rm':
      if (!item) die(`항목 없음: ${title}`);
      sec.items.splice(sec.items.indexOf(item), 1);
      log(`삭제: ${item.title}`);
      break;
    default: die(`알 수 없는 하위 명령: ${sub}  (set | note | rm | history | done)`);
  }
  saveProgress(sections);
  log(`[${sec.date}]`);
  console.log(renderBoard(sections, sec.date, days));
}

// ---------- 저장소 ----------
function cmdAdd([src, name]) {
  if (!src) die('사용법: wf add <git-url|로컬경로> [이름]');
  name ??= basename(src.replace(/\/+$/, '')).replace(/\.git$/, '');
  // 이름은 repos/ 바로 아래 디렉토리 하나여야 한다 — 경로가 섞이면 gitignore 밖에 mirror 가 생긴다
  if (!name || /[\/\\]/.test(name) || name === '.' || name === '..') die(`저장소 이름에 경로를 쓸 수 없습니다: ${name}`);
  const dir = join(REPOS_DIR, `${name}.git`);
  if (existsSync(dir)) die(`이미 등록됨: ${dir}`);
  mkdirSync(REPOS_DIR, { recursive: true });
  execFileSync('git', ['clone', '--mirror', src, dir], { stdio: 'inherit' });
  // 작성자 필터(config.json authors) 설정에 참고하도록 커밋 작성자 목록 출력
  const count = new Map();
  for (const a of git(dir, ['log', '--all', '--format=%an <%ae>']).split('\n').filter(Boolean)) count.set(a, (count.get(a) ?? 0) + 1);
  log(`\n등록됨: ${name}\n커밋 작성자:`);
  for (const [a, n] of [...count].sort((x, y) => y[1] - x[1])) log(`  ${String(n).padStart(5)}  ${a}`);
  log(`\n현재 필터 작성자: ${authors().join(', ') || '(없음)'}  — 다르면 config.json 의 authors 를 수정하세요.`);
}

function cmdList() {
  const rs = repos();
  log(`작성자 필터: ${authors().join(', ') || '(없음 — config.json 의 authors 를 채우세요)'}`);
  if (!rs.length) return log('등록된 저장소가 없습니다. wf add <url> 로 추가하세요.');
  for (const r of rs) {
    let url = '';
    try { url = git(r.dir, ['remote', 'get-url', 'origin']).trim(); } catch {}
    const rules = (config.products ?? []).filter((p) => !p.repo || p.repo === r.name).map((p) => p.name);
    console.log(`${r.name}\t${url}${rules.length ? `\n  제품: ${[...new Set(rules)].join(' · ')}` : '\n  제품: (매핑 없음)'}`);
  }
}

async function cmdSync() {
  const rs = repos();
  if (!rs.length) return log('등록된 저장소가 없습니다. wf add <url> 로 추가하세요.');
  await Promise.all(rs.map(async (r) => {
    // 응답 없는 원격(VPN 끊김 등)에서 무한 대기하지 않도록 timeout — 실패는 exit 1 로 알린다
    try { await execFileAsync('git', ['fetch', '--prune', '--quiet'], { cwd: r.dir, timeout: 60_000 }); log(`✓ ${r.name}`); }
    catch (e) { log(`✗ ${r.name}: ${e.killed ? '60초 내 응답 없음' : (e.stderr || e.message).trim()}`); process.exitCode = 1; }
  }));
}

async function cmdDaily([arg], flags) {
  const range = parseRange(arg);
  requireGit();
  if (!repos().length) die('등록된 저장소가 없습니다. wf add <url> 로 추가하세요. (설정 절차: README.md)');
  if (!flags.has('--no-sync')) await cmdSync();
  const results = repos().map((r) => {
    const { commits, error } = collect(r, range);
    if (error) { log(`✗ ${r.name}: 커밋 수집 실패 — ${error}`); process.exitCode = 1; }
    return { name: r.name, error, commits: commits.map((c) => ({ ...c, product: productOf(r.name, c) })) };
  });
  if (flags.has('--json')) {
    const sections = loadProgress();
    const progress = sections.length ? ensureSection(sections, range.to).sec.items : [];
    return console.log(JSON.stringify({ ...range, authors: authors(), repos: results, progress }, null, 2));
  }
  const days = Number([...flags].find((f) => f.startsWith('--days='))?.slice(7) ?? 7);
  console.log(renderDaily(range, results, Number.isInteger(days) && days >= 0 ? days : 7));
}

// ---------- main ----------
const HELP = `wf — git 이력 기반 작업 내역 / 진척도 CLI

  wf add <git-url|경로> [이름]        저장소 등록 (mirror clone → repos/)
  wf ls                               등록된 저장소·작성자 필터·제품 매핑 확인
  wf sync                             전체 저장소 fetch
  wf daily [범위] [--json] [--no-sync] 작업 내역 (기본 today)
       범위: yesterday | -N | YYYY-MM-DD | A..B | last (마지막 보고 이후) | week | lastweek | month
  wf progress [--date=D] [--days=N]   진척도 — 진행 중 + 최근 N일(기본 7) 완료 항목
  wf progress set "<제목>" <N> ["메모"] 진척률 갱신 (없으면 추가)
  wf progress note "<제목>" "<메모>"   메모 추가
  wf progress rm "<제목>"              항목 삭제
  wf progress history ["<제목>"]       항목별 진척률 추이
  wf progress done [범위]              기간에 완료(100%)된 항목 (기본 month)

config.json (양식: config.example.json) 의 authors 로 집계할 커밋을 고르고, products 규칙이 있으면
daily 출력의 커밋마다 [제품명] 태그를 붙입니다 (scope 우선, 없으면 변경 파일 경로).

progress.md 는 날짜(## YYYY-MM-DD) 섹션으로 쌓입니다. set/note/rm 은 오늘 섹션에 적용되며
(--date=YYYY-MM-DD 로 변경 가능), 섹션이 없으면 직전 날짜에서 100% 미만인 항목만 복사해 만듭니다.
조회(wf progress, wf daily 의 진척도 블록)는 파일을 바꾸지 않습니다
(wf daily 는 보고일이 오늘일 때만 섹션을 만듭니다).
제목은 정확히 일치하거나, 유일하게 부분 일치하면 됩니다. (예: "홈")
`;

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const [cmd, ...args] = argv.filter((a) => !a.startsWith('--'));
const commands = { add: cmdAdd, ls: cmdList, sync: cmdSync, daily: cmdDaily, progress: cmdProgress };
if (!cmd || flags.has('--help') || !commands[cmd]) { process.stdout.write(HELP); process.exit(cmd && !commands[cmd] ? 1 : 0); }
await commands[cmd](args, flags);
