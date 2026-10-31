// GitHub Actions から定期実行：YouTube Data API で配信予定・アーカイブを取って
//   streams.json … 手帳アプリが読む（自動で予定に追加）
//   streams.ics  … iPhone カレンダーが購読する
// を書き出す。必要なのはリポジトリの Secret「YT_API_KEY」だけ。
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const KEY = (process.env.YT_API_KEY || '').trim();
const CHANNELS = [
  {handle: '@SaikiIttetsu'},
  {handle: '@Oriens_HERO', collab: 'Oriens'},   // ユニットチャンネル（全部コラボ扱い）
];
const KEEP_DAYS = 90;   // streams.json に残す過去分
const ICS_DAYS = 60;    // カレンダーに載せる過去分
const API = 'https://www.googleapis.com/youtube/v3/';
const DIR = new URL('..', import.meta.url);
const JSON_FILE = new URL('streams.json', DIR);
const ICS_FILE = new URL('streams.ics', DIR);

async function api(path, params) {
  const u = new URL(API + path);
  for (const [k, v] of Object.entries({...params, key: KEY})) u.searchParams.set(k, v);
  for (let i = 0; ; i++) {
    const r = await fetch(u);
    if (r.ok) return r.json();
    const t = await r.text();
    if (i < 2 && r.status >= 500) { await new Promise(res => setTimeout(res, 2000 * (i + 1))); continue; }
    // キーの中身は出さず、形だけ（正しいキーは AIza で始まる39文字）
    const shape = /API key not valid/.test(t)
      ? ` [key: ${KEY.length}文字, AIza始まり=${KEY.startsWith('AIza')}, 英数字と-_以外=${/[^A-Za-z0-9_-]/.test(KEY)}]` : '';
    throw new Error(`${path} ${r.status}${shape} ${t.slice(0, 300)}`);
  }
}

async function videos(ids, ch) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const v = await api('videos', {part: 'snippet,liveStreamingDetails,contentDetails', id: ids.slice(i, i + 50).join(','), maxResults: 50});
    out.push(...(v.items || []).map(x => ({...x, _ch: ch})));
  }
  return out;
}

async function channelVideos(ch) {
  const c = await api('channels', {part: 'contentDetails', forHandle: ch.handle});
  const item = c.items && c.items[0];
  if (!item) throw new Error('channel not found: ' + ch.handle);
  const pl = await api('playlistItems', {part: 'contentDetails', playlistId: item.contentDetails.relatedPlaylists.uploads, maxResults: 50});
  return videos((pl.items || []).map(x => x.contentDetails.videoId), ch);
}

function seconds(iso) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0;
}

// ---- タイトルから種類・ゲーム名・コラボ相手を推定（アプリで直せる） ----
const CREDIT = /にじさんじ|NIJISANJI|佐伯イッテツ|Oriens/i;
const NOT_GAME = /雑談|同時視聴|歌枠|カラオケ|告知|お知らせ|作業|朝活|ASMR|凸|企画|記念|周年|重大|振り返り|感想|続き|会議|3D|お絵描き|料理|晩酌|コラボ|マシュマロ/;
const EVENT = /記念|周年|3D|生誕|誕生日|新衣装|お披露目|重大告知/;
const GAMEISH = /[A-Za-z]|part|初見|実況|ゲーム|マイクラ|ポケ|麻雀|雀魂|桃鉄|マリオ|スプラ|モンハン|バイオ|アバタール|アイドルマスター|ライドウ|ペルソナ|ドラクエ/i;
const SERIES = /part\s*[0-9０-９]+|#\s*\d+|第\s*[0-9０-９一二三四五六七八九十]+\s*[回話章]|その\s*\d+|\d+\s*日目|day\s*\d+/i;

// ---- 概要欄からゲーム名（本人のテンプレ「【(＾ω＾)く…」より上だけ見る） ----
const SEP_LINE = /^[\s\-ー－=＝━─_~～*＊.。]+$/;
const GENERIC = /^(ストアページ|ストア|公式(サイト|HP|X)?|特設サイト|購入はこちら|体験版|Steam|ダウンロード)?[\s：:]*$/i;
const STORE = /store\.steampowered\.com|store\.nintendo|nintendo\.(co\.jp|com)\/(games|software)|store\.playstation\.com|store\.epicgames\.com|apps\.apple\.com|play\.google\.com\/store|itch\.io/i;
const URL_RE = /https?:\/\/\S+/;
const nameLike = s => s && s.length <= 60 && !URL_RE.test(s) && !GENERIC.test(s) && !/[。！？!?…]|[©ⓒ]/.test(s);
const tidy = s => s.replace(/【[^】]*】/g, '').replace(/[®™]/g, '').replace(/^[『「\s]+|[』」\s：:]+$/g, '').trim();

function descGame(desc, title) {
  const head = (desc || '').split(/【\(＾ω＾\)く|※お問い合わせ/)[0];
  const lines = head.split('\n').map(l => l.trim()).filter(l => l && !SEP_LINE.test(l));
  let name = '';
  // 1) 『ゲーム名』だけの行（リレー企画などで複数あれば、次の行に本人の名前がある方）
  const own = lines.map((l, i) => [l, i]).filter(([l]) => /^『[^』]+』$/.test(l));
  if (own.length === 1) name = own[0][0];
  else if (own.length > 1) { const hit = own.find(([, i]) => /SaikiIttetsu|佐伯/.test(lines[i + 1] || '')); if (hit) name = hit[0]; }
  // 2) ©表記のすぐ上の行
  if (!name) { const i = lines.findIndex(l => /^[©ⓒ]/.test(l)); if (i > 0 && nameLike(lines[i - 1])) name = lines[i - 1]; }
  // 3) ストアリンクの見出し（同じ行の前半か、1行上）
  let slug = '';
  if (!name) {
    for (let i = 0; i < lines.length && !name; i++) {
      const m = STORE.test(lines[i]) && lines[i].match(URL_RE);
      if (!m) continue;
      const s = /\/app\/\d+\/([^/?#\s]+)/.exec(m[0]);
      if (s && !slug) slug = decodeURIComponent(s[1]).replace(/_/g, ' ');
      const label = tidy(lines[i].slice(0, m.index));
      const prev = i > 0 && nameLike(tidy(lines[i - 1])) ? tidy(lines[i - 1]) : '';
      name = nameLike(label) ? label : prev;
    }
  }
  name = tidy(name);
  if (/[|｜]/.test(name)) { const parts = name.split(/\s*[|｜]\s*/).filter(Boolean); name = parts.find(p => title.includes(p)) || parts[parts.length - 1]; }
  const evidence = !!name || STORE.test(head) || /許諾/.test(head) ||
    head.split('\n').some(l => /[©ⓒ]/.test(l) && !/^[\s©ⓒ]*(ANYCOLOR|にじさんじ|NIJISANJI)[^©ⓒ]*$/i.test(l));
  return {name, evidence, slug};
}

function classify(title, ch, desc = '') {
  const raw = [...title.matchAll(/【([^】]*)】/g)].map(m => m[1]);
  const creditRaw = [...raw].reverse().find(t => CREDIT.test(t));
  const credit = creditRaw === undefined ? '' : creditRaw.trim();
  const members = credit
    ? credit.split(/[\/／｜|、,&＆×]/).map(s => s.trim()).filter(s => s && !/にじさんじ|NIJISANJI|佐伯イッテツ|^Oriens$/i.test(s))
    : [];
  let clean = creditRaw === undefined ? title : title.replace('【' + creditRaw + '】', '');
  clean = clean.replace(/[\s　]+/g, ' ').trim() || title;
  // 先頭の【】がゲーム名の候補（#ハッシュタグ企画は除く）
  const first = raw.map(t => t.trim()).find(t => t !== credit) || '';
  let type = 'zatsudan', game = '';
  const tagOk = first && !/^[#＃]/.test(first);
  const strip = s => s.replace(SERIES, '').replace(/\S*視点|ほぼ初見|完全初見|初見|番外編|前編|後編|最終回/g, '')
    .replace(/[\s　・\-:：]+$/, '').replace(/^[\s　・#＃]+/, '').replace(/[\s　]+/g, ' ').trim();
  if (tagOk && !NOT_GAME.test(first) && GAMEISH.test(first)) {
    game = strip(first);
    type = SERIES.test(first) ? 'game_series' : 'game_single';
  } else if (EVENT.test(title)) {
    type = 'event';
  }
  const d = descGame(desc, title);
  // 概要欄にストアリンク・©・許諾があればゲーム配信（タイトルだけでは分からない時）
  if (d.evidence && type === 'zatsudan') {
    type = SERIES.test(title) ? 'game_series' : 'game_single';
    if (!game && tagOk && !NOT_GAME.test(first)) game = strip(first);
  }
  game = d.name || game || d.slug;
  const collab = [ch.collab, ...members].filter(Boolean).join(' / ');
  if (collab || /コラボ/.test(title)) type = 'collab';
  // シリーズの目印（同じ企画の part 違いで共通）：ゲーム名の引き継ぎに使う
  const sk = tagOk && SERIES.test(first) ? first.replace(SERIES, '').replace(/前編|後編|番外編|最終回/g, '').replace(/[\s　・]+/g, ' ').trim() : '';
  return {title: clean, type, game, collab, sk};
}

function toItem(v) {
  const ls = v.liveStreamingDetails;
  if (!ls) return null;   // 配信・プレミアのみ（通常の動画・ショートは除く）
  const start = ls.actualStartTime || ls.scheduledStartTime;
  if (!start) return null;
  const status = v.snippet.liveBroadcastContent;   // upcoming / live / none
  // フリーチャット枠（何か月も先の予定）は除く
  if (status === 'upcoming' && (Date.parse(start) > Date.now() + 45 * 864e5 || /フリーチャット|free\s*chat/i.test(v.snippet.title))) return null;
  let end = ls.actualEndTime || '';
  const dur = seconds(v.contentDetails && v.contentDetails.duration);
  if (!end && status === 'none' && dur) end = new Date(Date.parse(start) + dur * 1000).toISOString();
  return {id: v.id, start, end, status, ...classify(v.snippet.title, v._ch, v.snippet.description), ch: v._ch.collab || ''};
}

// ---- iCalendar ----
const esc = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
function fold(line) {
  const b = Buffer.from(line, 'utf8');
  if (b.length <= 75) return line;
  const parts = [];
  let cur = '', size = 0, limit = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (size + n > limit) { parts.push(cur); cur = ''; size = 0; limit = 74; }
    cur += ch; size += n;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}
const EMOJI = {zatsudan: '💬', game_single: '🎮', game_series: '🕹️', collab: '🤝', event: '🐈‍⬛'};
function ics(items) {
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ittetsu-diary//streams//JA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:佐伯イッテツ 配信', 'X-WR-TIMEZONE:Asia/Tokyo', 'X-APPLE-CALENDAR-COLOR:#8C4664',
    'REFRESH-INTERVAL;VALUE=DURATION:PT30M', 'X-PUBLISHED-TTL:PT30M'];
  const since = Date.now() - ICS_DAYS * 864e5;
  for (const it of items) {
    const s = Date.parse(it.start);
    if (s < since) continue;
    const e = it.end ? Date.parse(it.end) : s + 2 * 3600e3;
    const url = 'https://www.youtube.com/watch?v=' + it.id;
    const summary = (it.status === 'live' ? '🔴 ' : (EMOJI[it.type] || '💬') + ' ') + it.title + (it.collab ? ' / ' + it.collab : '');
    L.push('BEGIN:VEVENT', 'UID:' + it.id + '@ittetsu-diary', 'DTSTAMP:' + stamp(s), 'DTSTART:' + stamp(s), 'DTEND:' + stamp(Math.max(e, s + 600e3)),
      'SUMMARY:' + esc(summary), 'URL:' + url, 'DESCRIPTION:' + esc((it.game ? '🎮 ' + it.game + '\n' : '') + url));
    if (it.status === 'upcoming') L.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'DESCRIPTION:' + esc(summary), 'END:VALARM');
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}

function writeIfChanged(file, text) {
  const old = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (old === text) return false;
  writeFileSync(file, text);
  return true;
}

async function main() {
  if (!KEY) { console.log('YT_API_KEY が未設定なのでスキップ'); return; }
  const prev = existsSync(JSON_FILE) ? JSON.parse(readFileSync(JSON_FILE, 'utf8')) : {items: []};
  const got = new Map();
  for (const ch of CHANNELS) {
    for (const v of await channelVideos(ch)) { const it = toItem(v); if (it) got.set(it.id, it); }
  }
  // 前回「予定／配信中」だったのに今回の一覧に無い → 個別に確認（無ければ枠が消された）
  const recheck = (prev.items || []).filter(it => it.status !== 'none' && !got.has(it.id));
  for (const ch of CHANNELS) {
    const ids = recheck.filter(it => (it.ch || '') === (ch.collab || '')).map(it => it.id);
    if (ids.length) for (const v of await videos(ids, ch)) { const it = toItem(v); if (it) got.set(it.id, it); }
  }
  const keepFrom = Date.now() - KEEP_DAYS * 864e5;
  for (const it of prev.items || []) {
    if (!got.has(it.id) && it.status === 'none' && Date.parse(it.start) >= keepFrom) got.set(it.id, it);
  }
  // 同じシリーズの中でゲーム名が分かった回があれば、分からない回にも付ける
  const bySk = {};
  for (const it of got.values()) if (it.sk && it.game) bySk[it.sk] = bySk[it.sk] || it.game;
  for (const it of got.values()) if (it.sk && !it.game && bySk[it.sk]) it.game = bySk[it.sk];
  // 同じゲームを2回以上やっていたらシリーズ扱い
  const count = {};
  for (const it of got.values()) if (it.game) count[it.game] = (count[it.game] || 0) + 1;
  for (const it of got.values()) if (it.type === 'game_single' && count[it.game] > 1) it.type = 'game_series';

  const items = [...got.values()].filter(it => Date.parse(it.start) >= keepFrom).sort((a, b) => b.start.localeCompare(a.start));
  const same = JSON.stringify(items) === JSON.stringify(prev.items || []);
  const out = {updated: same && prev.updated ? prev.updated : new Date().toISOString(), items};
  const body = '{"updated":' + JSON.stringify(out.updated) + ',"items":[\n' + items.map(it => JSON.stringify(it)).join(',\n') + '\n]}\n';
  const a = writeIfChanged(JSON_FILE, body);
  const b = writeIfChanged(ICS_FILE, ics(items));
  console.log(`${items.length} 件（upcoming ${items.filter(i => i.status === 'upcoming').length}）`, a || b ? '更新あり' : '変更なし');
}

export {classify, toItem, ics, seconds, main};
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
