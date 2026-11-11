import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const UPLOADS = path.join(DATA, 'uploads');
const IMAGES = path.join(DATA, 'images');
for (const dir of [DATA, UPLOADS, IMAGES]) fs.mkdirSync(dir, { recursive: true });

const PORT = Number(process.env.PORT || 3000);
const ORIGIN = process.env.APP_ORIGIN || `http://localhost:${PORT}`;
const HORDE_KEY = process.env.AI_HORDE_API_KEY || '0000000000';
const HORDE_CHAT = (process.env.AI_HORDE_CHAT_URL || 'https://oai.aihorde.net/v1').replace(/\/$/, '');
const HORDE_API = (process.env.AI_HORDE_API_URL || 'https://aihorde.net/api').replace(/\/$/, '');
const CHAT_URL = (process.env.AI_CHAT_BASE_URL || HORDE_CHAT).replace(/\/$/, '');
const CHAT_KEY = process.env.AI_CHAT_API_KEY || HORDE_KEY;
const CHAT_IS_HORDE = CHAT_URL === HORDE_CHAT;
const CLIENT_AGENT = `NEXORAGPT:1.0.0:${process.env.AI_HORDE_CLIENT_CONTACT || 'self-hosted'}`;
const db = new DatabaseSync(path.join(DATA, 'nexoragpt.sqlite'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    username TEXT NOT NULL, password_hash TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
    settings TEXT NOT NULL DEFAULT '{}', is_guest INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL, name TEXT NOT NULL,
    mime TEXT NOT NULL, disk_path TEXT NOT NULL, extracted_text TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    horde_id TEXT NOT NULL, prompt TEXT NOT NULL, style TEXT NOT NULL DEFAULT 'none', width INTEGER NOT NULL, height INTEGER NOT NULL,
    status TEXT NOT NULL, disk_path TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL DEFAULT '',
    wait_time INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS plugin_prefs (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, plugin_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, plugin_id)
  );
  CREATE TABLE IF NOT EXISTS rate_limits (
    bucket TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL
  );
`);
if (!db.prepare('PRAGMA table_info(images)').all().some(column => column.name === 'style')) {
  db.exec("ALTER TABLE images ADD COLUMN style TEXT NOT NULL DEFAULT 'none'");
}
if (!db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'is_guest')) {
  db.exec('ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0');
}
db.prepare("UPDATE users SET email='guest-' || id || '@guest.invalid', password_hash='disabled', verified=1, is_guest=1 WHERE is_guest=0").run();
db.exec('DROP TABLE IF EXISTS pending; DROP TABLE IF EXISTS resets; DROP TABLE IF EXISTS pending_email;');

const now = () => Date.now();
const uuid = () => crypto.randomUUID();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const json = (res, status, value, headers = {}) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
};
const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, extra });
const cleanModelText = text => String(text || '')
  .replace(/<\|(?:think|thinking|analysis|reasoning)[^|]*\|>[\s\S]*?<\|\/(?:think|thinking|analysis|reasoning)\|>/gi, '')
  .replace(/<(?:think|thinking|analysis|reasoning)>[\s\S]*?<\/(?:think|thinking|analysis|reasoning)>/gi, '')
  .replace(/<\|(?:im_start|im_end|endoftext|fim_suffix|gh[a-z_]+)\|>/gi, '')
  .replace(/<\/?(?:think|thinking|analysis|reasoning)>/gi, '')
  .replace(/\[(?:INST|\/INST)\]|<\/?s>/gi, '')
  .replace(/^\s*(?:assistant|final)\s*:\s*/i, '')
  .trim();
function cookieValue(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function enforceRate(req, bucket, max, windowMs) {
  const key = `${bucket}:${req.socket.remoteAddress || 'unknown'}`;
  const row = db.prepare('SELECT window_start, count FROM rate_limits WHERE bucket=?').get(key);
  const stamp = now();
  if (!row || stamp - row.window_start >= windowMs) {
    db.prepare('INSERT INTO rate_limits(bucket,window_start,count) VALUES(?,?,1) ON CONFLICT(bucket) DO UPDATE SET window_start=excluded.window_start,count=1').run(key, stamp);
    return;
  }
  if (row.count >= max) throw fail(429, 'Too many attempts. Please wait a little and try again.');
  db.prepare('UPDATE rate_limits SET count=count+1 WHERE bucket=?').run(key);
}

async function readBody(req, limit = 12 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw fail(413, 'That upload is too large. The limit is 12 MB.');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { throw fail(400, 'Request must contain valid JSON.'); }
}

function getSession(req) {
  const token = cookieValue(req, 'nexora_session');
  if (!token || token.length > 200) return null;
  const row = db.prepare(`SELECT users.id, users.email, users.username, users.settings, users.is_guest, sessions.token_hash
    FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?`).get(sha(token), now());
  if (!row) return null;
  return { id: row.id, email: row.is_guest ? '' : row.email, guest: Boolean(row.is_guest), username: row.username, settings: JSON.parse(row.settings || '{}'), tokenHash: row.token_hash };
}

function setSession(res, token) {
  const secure = ORIGIN.startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `nexora_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=315360000${secure}`);
}

function createGuestSession(res) {
  const id = uuid(); const token = crypto.randomBytes(32).toString('base64url'); const stamp = now();
  db.prepare('INSERT INTO users(id,email,username,password_hash,verified,settings,is_guest,created_at) VALUES(?,?,?,?,1,?,?,?)')
    .run(id, `guest-${id}@guest.invalid`, 'Guest', crypto.randomBytes(32).toString('hex'), JSON.stringify({ theme: 'light', model: '' }), 1, stamp);
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(sha(token), id, stamp + 10 * 365 * 24 * 60 * 60_000, stamp);
  setSession(res, token);
  return { id, username: 'Guest', guest: true, settings: { theme: 'light', model: '' } };
}

function checkOrigin(req) {
  const origin = req.headers.origin;
  if (origin && origin !== ORIGIN) throw fail(403, 'Request origin was rejected.');
}

async function hordeFetch(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeout || 120000) });
  } catch (err) {
    throw fail(502, `Could not reach AI Horde: ${err.name === 'TimeoutError' ? 'the request timed out' : 'check the internet connection and try again'}.`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || data?.message || `AI Horde returned HTTP ${response.status}.`;
    throw fail(response.status === 429 ? 429 : 502, message);
  }
  return data;
}

let modelCache = { time: 0, data: [] };
async function listModels() {
  if (Date.now() - modelCache.time < 30000 && modelCache.data.length) return modelCache.data;
  const data = await hordeFetch(`${CHAT_URL}/models`, {
    headers: { Authorization: `Bearer ${CHAT_KEY}`, 'X-Title': 'NEXORAGPT', 'User-Agent': 'NEXORAGPT/1.0.0' }, timeout: 20000,
  });
  modelCache = { time: Date.now(), data: Array.isArray(data.data) ? data.data : [] };
  return modelCache.data;
}

function dbChat(userId, chatId) {
  const chat = db.prepare('SELECT * FROM chats WHERE id=? AND user_id=?').get(chatId, userId);
  if (!chat) throw fail(404, 'Conversation not found.');
  return chat;
}

async function createAssistantReply(user, chatId, fileIds = []) {
  const chat = dbChat(user.id, chatId);
  const messages = db.prepare('SELECT role, content FROM messages WHERE chat_id=? ORDER BY created_at, rowid').all(chatId);
  const selectedModel = chat.model || process.env.AI_HORDE_DEFAULT_MODEL || user.settings.model || '';
  const liveModels = await listModels();
  const model = selectedModel || liveModels[0]?.id;
  if (!model || !liveModels.some(item => item.id === model)) throw fail(503, 'No AI Horde chat model is available right now. Try again later or choose another model in Settings.');
  const lastUserIndex = messages.map(m => m.role).lastIndexOf('user');
  if (lastUserIndex < 0) throw fail(400, 'Send a message before requesting a reply.');
  const fileRows = fileIds.length
    ? fileIds.map(id => db.prepare('SELECT * FROM files WHERE id=? AND user_id=? AND chat_id=?').get(id, user.id, chatId)).filter(Boolean)
    : db.prepare('SELECT * FROM files WHERE user_id=? AND chat_id=? ORDER BY created_at DESC LIMIT 8').all(user.id, chatId);
  const context = messages.slice(-32).map(m => ({ role: m.role, content: m.content }));
  if (fileRows.length) {
    const textFiles = fileRows.filter(file => file.extracted_text).map(file => `\n\n[Uploaded file: ${file.name}]\n${file.extracted_text.slice(0, 30000)}`).join('');
    if (textFiles) context[context.length - 1].content += textFiles;
    const imageFiles = fileRows.filter(file => file.mime.startsWith('image/'));
    for (const file of imageFiles.slice(0, 4)) {
      const bytes = fs.readFileSync(file.disk_path);
      if (bytes.length <= 5 * 1024 * 1024) {
        const part = { type: 'image_url', image_url: { url: `data:${file.mime};base64,${bytes.toString('base64')}`, detail: 'auto' } };
        const last = context[context.length - 1];
        if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
        last.content.push(part);
      }
    }
  }
  let reply;
  try {
    reply = await hordeFetch(`${CHAT_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CHAT_KEY}`, 'X-Title': 'NEXORAGPT',
        'Content-Type': 'application/json', 'User-Agent': 'NEXORAGPT/1.0.0',
      },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: 'You are NEXORAGPT, a helpful and clear assistant. Be accurate, concise, and supportive. Never reveal private reasoning or internal control tokens.' }, ...context], max_tokens: 512, temperature: 0.7, ...(CHAT_IS_HORDE ? { horde: { include_reasoning: false, context_fit: 'truncate_oldest' } } : {}) }),
    });
  } catch (err) { throw err; }
  const answer = cleanModelText(reply?.choices?.[0]?.message?.content);
  if (!answer) throw fail(502, 'AI Horde returned an empty answer. You can try generating again.');
  db.prepare('INSERT INTO messages(id,chat_id,role,content,created_at) VALUES(?,?,?,?,?)').run(uuid(), chatId, 'assistant', answer, now());
  db.prepare('UPDATE chats SET model=?,updated_at=? WHERE id=?').run(reply.model || model, now(), chatId);
  return { answer, model: reply.model || model };
}

const PLUGINS = [
  { id: 'calculator', name: 'Calculator', category: 'Productivity', icon: '∑', description: 'Evaluate arithmetic expressions locally in your browser. No external service or account is needed.', permissions: 'Runs calculations you submit.' },
  { id: 'weather', name: 'Weather', category: 'Research', icon: '☼', description: 'Get current conditions from Open-Meteo for a city or postal code.', permissions: 'Sends the location you enter to Open-Meteo.' },
  { id: 'web_search', name: 'Web search', category: 'Research', icon: '⌕', description: 'Search the web using DuckDuckGo Instant Answers.', permissions: 'Sends your search query to DuckDuckGo.' },
  { id: 'summarizer', name: 'Text summarizer', category: 'Writing', icon: '≡', description: 'Summarize text with the selected AI Horde chat model.', permissions: 'Sends the text you submit to AI Horde workers.' },
  { id: 'translator', name: 'Translator', category: 'Writing', icon: '文', description: 'Translate text with a configured LibreTranslate server.', permissions: 'Sends text and language choices to the LibreTranslate URL in .env.', configured: Boolean(process.env.LIBRETRANSLATE_URL) },
  { id: 'file_analysis', name: 'File analysis', category: 'Productivity', icon: '↥', description: 'Attach text, PDF, Word, or image files to a conversation for analysis.', permissions: 'Uploads are stored locally and relevant content is sent to AI Horde when you ask about a file.' },
  { id: 'image_tools', name: 'Image studio', category: 'Image creation', icon: '▧', description: 'Generate and save images using the AI Horde worker network.', permissions: 'Your prompt is sent to AI Horde image workers.' },
  { id: 'code_helper', name: 'Code helper', category: 'Coding', icon: '</>', description: 'Get code help through NEXORAGPT chat.', permissions: 'Sends conversation messages to AI Horde workers.' },
];

function safeFilename(name) { return path.basename(String(name || 'upload')).replace(/[^\w.() -]/g, '_').slice(0, 120) || 'upload'; }
async function extractDocument(filename, mime, bytes) {
  const ext = path.extname(filename).toLowerCase();
  if (['.txt', '.md', '.csv', '.json', '.html', '.xml'].includes(ext) || mime.startsWith('text/')) return bytes.toString('utf8').slice(0, 60000);
  if (ext === '.pdf' || mime === 'application/pdf') {
    try {
      const mod = await import('pdf-parse');
      const parse = mod.default || mod;
      const result = await parse(bytes);
      return String(result.text || '').slice(0, 60000);
    } catch (err) { if (err.status) throw err; throw fail(422, 'Could not read this PDF. Please check the file or try a text version.'); }
  }
  if (ext === '.docx' || mime.includes('wordprocessingml')) {
    try { const mod = await import('mammoth'); const result = await mod.extractRawText({ buffer: bytes }); return String(result.value || '').slice(0, 60000); }
    catch (err) { if (err.status) throw err; throw fail(422, 'Could not read this Word document.'); }
  }
  if (mime.startsWith('image/')) return '';
  throw fail(415, 'Supported files are images, PDF, Word, text, Markdown, CSV, and JSON.');
}

async function routeApi(req, res, url) {
  const method = req.method;
  const pathname = url.pathname;
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (method !== 'GET' && method !== 'HEAD') checkOrigin(req);
  const session = getSession(req);
  const user = session;
  const requireUser = () => { if (!user) throw fail(401, 'Guest workspace is unavailable. Reload the page to start one.'); return user; };

  if (pathname === '/api/health' && method === 'GET') return json(res, 200, { ok: true, provider: 'AI Horde' });
  if (pathname === '/api/session' && method === 'GET') {
    const guest = user || createGuestSession(res);
    return json(res, 200, { guest: true, user: { username: guest.username, guest: true }, settings: guest.settings });
  }
  if (pathname === '/api/profile' && method === 'GET') {
    requireUser();
    const row = db.prepare('SELECT username,settings,is_guest FROM users WHERE id=?').get(user.id);
    return json(res, 200, { username: row.username, guest: Boolean(row.is_guest), settings: JSON.parse(row.settings || '{}') });
  }
  if (pathname === '/api/profile' && method === 'PATCH') {
    requireUser(); const body = await readBody(req, 12000); const username = String(body.username || '').trim();
    if (username.length < 2 || username.length > 40) throw fail(400, 'Username must be 2 to 40 characters.');
    db.prepare('UPDATE users SET username=? WHERE id=?').run(username, user.id);
    return json(res, 200, { username });
  }
  if (pathname === '/api/settings' && method === 'PATCH') {
    requireUser(); const body = await readBody(req, 12000); const current = user.settings || {};
    const next = { ...current, theme: ['light', 'dark', 'system'].includes(body.theme) ? body.theme : current.theme || 'light', model: typeof body.model === 'string' ? body.model.slice(0, 200) : current.model || '' };
    db.prepare('UPDATE users SET settings=? WHERE id=?').run(JSON.stringify(next), user.id);
    return json(res, 200, next);
  }
  if (pathname === '/api/account' && method === 'DELETE') {
    requireUser();
    if (!user.guest) throw fail(403, 'This workspace belongs to an older account session and cannot be cleared here.');
    for (const base of [path.join(UPLOADS, user.id), path.join(IMAGES, user.id)]) if (fs.existsSync(base)) fs.rmSync(base, { recursive: true, force: true });
    db.prepare('DELETE FROM users WHERE id=?').run(user.id);
    res.setHeader('Set-Cookie', 'nexora_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return json(res, 200, { message: 'Guest workspace cleared.' });
  }

  if (pathname === '/api/models' && method === 'GET') {
    requireUser(); const models = await listModels();
    return json(res, 200, { models: models.map(m => ({ id: m.id, name: m.name || m.id, workers: m.x_horde?.workers || 0, queued: m.x_horde?.queued || 0, context: m.context_length || 0 })) });
  }

  if (pathname === '/api/chats' && method === 'GET') {
    requireUser(); const term = String(url.searchParams.get('q') || '').trim().slice(0, 100);
    const query = term ? `%${term.replace(/[\\%_]/g, '\\$&')}%` : '%';
    const rows = db.prepare(`SELECT c.id,c.title,c.model,c.created_at,c.updated_at,
      (SELECT content FROM messages WHERE chat_id=c.id ORDER BY created_at DESC,rowid DESC LIMIT 1) AS preview
      FROM chats c WHERE c.user_id=? AND (c.title LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM messages m WHERE m.chat_id=c.id AND m.content LIKE ? ESCAPE '\\'))
      ORDER BY c.updated_at DESC LIMIT 100`).all(user?.id || '', query, query);
    if (!user) throw fail(401, 'Guest workspace is unavailable. Reload the page to start one.');
    return json(res, 200, { chats: rows });
  }
  if (pathname === '/api/chats' && method === 'POST') {
    requireUser(); const id = uuid(); const title = 'New chat'; const stamp = now();
    db.prepare('INSERT INTO chats(id,user_id,title,model,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, user.id, title, user.settings.model || '', stamp, stamp);
    return json(res, 201, { id, title, created_at: stamp });
  }
  if (parts[0] === 'api' && parts[1] === 'chats' && parts[2] && parts.length === 3 && method === 'GET') {
    requireUser(); const chat = dbChat(user.id, parts[2]);
    const messages = db.prepare('SELECT id,role,content,created_at FROM messages WHERE chat_id=? ORDER BY created_at,rowid').all(chat.id);
    const files = db.prepare('SELECT id,name,mime,created_at FROM files WHERE user_id=? AND chat_id=? ORDER BY created_at').all(user.id, chat.id);
    return json(res, 200, { chat, messages, files });
  }
  if (parts[0] === 'api' && parts[1] === 'chats' && parts[2] && parts.length === 3 && method === 'PATCH') {
    requireUser(); dbChat(user.id, parts[2]); const body = await readBody(req, 12000); const title = String(body.title || '').trim();
    if (!title || title.length > 100) throw fail(400, 'Chat title must be 1 to 100 characters.');
    db.prepare('UPDATE chats SET title=?,updated_at=? WHERE id=?').run(title, now(), parts[2]);
    return json(res, 200, { title });
  }
  if (parts[0] === 'api' && parts[1] === 'chats' && parts[2] && parts.length === 3 && method === 'DELETE') {
    requireUser(); dbChat(user.id, parts[2]);
    const attachments = db.prepare('SELECT disk_path FROM files WHERE user_id=? AND chat_id=?').all(user.id, parts[2]);
    for (const file of attachments) if (fs.existsSync(file.disk_path)) fs.rmSync(file.disk_path, { force: true });
    db.prepare('DELETE FROM files WHERE user_id=? AND chat_id=?').run(user.id, parts[2]);
    db.prepare('DELETE FROM chats WHERE id=?').run(parts[2]);
    return json(res, 200, { message: 'Conversation deleted.' });
  }
  if (parts[0] === 'api' && parts[1] === 'chats' && parts[2] && parts[3] === 'messages' && method === 'POST') {
    requireUser(); const chat = dbChat(user.id, parts[2]); const body = await readBody(req, 30000);
    const content = String(body.message || '').trim().slice(0, 20000);
    if (!content) throw fail(400, 'Write a message first.');
    const fileIds = Array.isArray(body.fileIds) ? body.fileIds.slice(0, 8).map(String) : [];
    if (fileIds.length) {
      const owned = fileIds.map(id => db.prepare('SELECT id FROM files WHERE id=? AND user_id=? AND (chat_id=? OR chat_id IS NULL)').get(id, user.id, chat.id)).filter(Boolean);
      if (owned.length !== fileIds.length) throw fail(403, 'One of those files is not available in this conversation.');
      db.prepare(`UPDATE files SET chat_id=? WHERE id IN (${fileIds.map(() => '?').join(',')}) AND user_id=?`).run(chat.id, ...fileIds, user.id);
    }
    const first = db.prepare('SELECT COUNT(*) AS total FROM messages WHERE chat_id=?').get(chat.id).total === 0;
    db.prepare('INSERT INTO messages(id,chat_id,role,content,created_at) VALUES(?,?,?,?,?)').run(uuid(), chat.id, 'user', content, now());
    if (first) db.prepare('UPDATE chats SET title=?,updated_at=? WHERE id=?').run(content.slice(0, 48) + (content.length > 48 ? '…' : ''), now(), chat.id);
    try {
      const result = await createAssistantReply(user, chat.id, fileIds);
      const messages = db.prepare('SELECT id,role,content,created_at FROM messages WHERE chat_id=? ORDER BY created_at,rowid').all(chat.id);
      return json(res, 200, { ...result, chatId: chat.id, title: dbChat(user.id, chat.id).title, messages });
    } catch (err) { throw err; }
  }
  if (parts[0] === 'api' && parts[1] === 'chats' && parts[2] && parts[3] === 'regenerate' && method === 'POST') {
    requireUser(); const chat = dbChat(user.id, parts[2]);
    const last = db.prepare('SELECT * FROM messages WHERE chat_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(chat.id);
    if (!last || !['assistant', 'user'].includes(last.role)) throw fail(400, 'There is no answer to generate yet.');
    if (last.role === 'assistant') db.prepare('DELETE FROM messages WHERE id=?').run(last.id);
    const result = await createAssistantReply(user, chat.id);
    const messages = db.prepare('SELECT id,role,content,created_at FROM messages WHERE chat_id=? ORDER BY created_at,rowid').all(chat.id);
    return json(res, 200, { ...result, messages });
  }

  if (pathname === '/api/files' && method === 'POST') {
    requireUser(); const body = await readBody(req, 12 * 1024 * 1024);
    const name = safeFilename(body.name); const mime = String(body.mime || 'application/octet-stream').slice(0, 120);
    const encoded = String(body.data || '').replace(/^data:[^,]*;base64,/, '');
    if (!encoded || encoded.length > 11 * 1024 * 1024) throw fail(400, 'Choose a file smaller than 8 MB.');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw fail(400, 'Choose a non-empty file smaller than 8 MB.');
    if (mime.startsWith('image/') && bytes.length > 5 * 1024 * 1024) throw fail(400, 'AI Horde accepts source images up to 5 MB. Choose a smaller image.');
    const extracted = await extractDocument(name, mime, bytes);
    const ext = path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10) || '.bin';
    const id = uuid(); const diskPath = path.join(UPLOADS, user.id, `${id}${ext}`);
    fs.mkdirSync(path.dirname(diskPath), { recursive: true }); fs.writeFileSync(diskPath, bytes, { flag: 'wx' });
    db.prepare('INSERT INTO files(id,user_id,chat_id,name,mime,disk_path,extracted_text,created_at) VALUES(?,?,NULL,?,?,?,?,?)')
      .run(id, user.id, name, mime, diskPath, extracted, now());
    return json(res, 201, { file: { id, name, mime, extracted: Boolean(extracted) } });
  }
  if (parts[0] === 'api' && parts[1] === 'files' && parts[2] && parts.length === 3 && method === 'DELETE') {
    requireUser(); const file = db.prepare('SELECT disk_path FROM files WHERE id=? AND user_id=?').get(parts[2], user.id);
    if (!file) throw fail(404, 'Uploaded file not found.');
    if (fs.existsSync(file.disk_path)) fs.rmSync(file.disk_path, { force: true });
    db.prepare('DELETE FROM files WHERE id=? AND user_id=?').run(parts[2], user.id);
    return json(res, 200, { message: 'Uploaded file deleted.' });
  }

  if (pathname === '/api/plugins' && method === 'GET') {
    requireUser();
    const prefs = db.prepare('SELECT plugin_id,enabled FROM plugin_prefs WHERE user_id=?').all(user.id);
    const enabled = new Map(prefs.map(p => [p.plugin_id, Boolean(p.enabled)]));
    return json(res, 200, { plugins: PLUGINS.map(plugin => ({ ...plugin, enabled: enabled.get(plugin.id) || false })) });
  }
  if (pathname === '/api/plugins' && method === 'PATCH') {
    requireUser(); const body = await readBody(req, 12000); const plugin = PLUGINS.find(item => item.id === body.id);
    if (!plugin) throw fail(404, 'Plugin not found.');
    if (plugin.id === 'translator' && !process.env.LIBRETRANSLATE_URL) throw fail(503, 'Translator is not configured. Add LIBRETRANSLATE_URL to .env first.');
    db.prepare(`INSERT INTO plugin_prefs(user_id,plugin_id,enabled) VALUES(?,?,?) ON CONFLICT(user_id,plugin_id) DO UPDATE SET enabled=excluded.enabled`).run(user.id, plugin.id, body.enabled ? 1 : 0);
    return json(res, 200, { id: plugin.id, enabled: Boolean(body.enabled) });
  }
  if (pathname === '/api/plugins/run' && method === 'POST') {
    requireUser(); const body = await readBody(req, 30000); const id = String(body.id || ''); const input = String(body.input || '').trim();
    const pref = db.prepare('SELECT enabled FROM plugin_prefs WHERE user_id=? AND plugin_id=?').get(user.id, id);
    if (!pref?.enabled) throw fail(403, 'Enable this plugin first.');
    if (!input) throw fail(400, 'Enter something for the plugin to work on.');
    if (id === 'calculator') {
      if (!/^[\d\s()+\-*/%.^,]+$/.test(input) || input.length > 120) throw fail(400, 'Use numbers and arithmetic operators only.');
      const expression = input.replace(/\^/g, '**').replace(/,/g, '.');
      const result = Function(`"use strict"; return (${expression});`)();
      if (!Number.isFinite(result)) throw fail(400, 'That expression did not produce a finite number.');
      return json(res, 200, { result: String(result) });
    }
    if (id === 'weather') {
      const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(input)}&count=1&language=en&format=json`, { signal: AbortSignal.timeout(15000) });
      const location = (await geo.json()).results?.[0];
      if (!location) throw fail(404, `No location found for “${input}”.`);
      const forecastResponse = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m&timezone=auto`, { signal: AbortSignal.timeout(15000) });
      const forecast = await forecastResponse.json(); const c = forecast.current;
      return json(res, 200, { result: `${location.name}${location.admin1 ? `, ${location.admin1}` : ''}: ${c.temperature_2m}°C, feels like ${c.apparent_temperature}°C, humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} km/h. Updated ${c.time}.` });
    }
    if (id === 'web_search') {
      const response = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(input)}&format=json&no_html=1&skip_disambig=1`, { headers: { 'User-Agent': 'NEXORAGPT/1.0.0' }, signal: AbortSignal.timeout(15000) });
      const data = await response.json(); const results = [];
      if (data.AbstractText) results.push({ title: data.Heading || 'Overview', text: data.AbstractText, url: data.AbstractURL });
      for (const item of data.RelatedTopics || []) {
        if (item.Text && item.FirstURL) results.push({ title: item.Text.split(' - ')[0], text: item.Text, url: item.FirstURL });
        for (const child of item.Topics || []) if (child.Text && child.FirstURL) results.push({ title: child.Text.split(' - ')[0], text: child.Text, url: child.FirstURL });
      }
      if (!results.length) throw fail(404, 'DuckDuckGo did not return an instant-answer result for that query.');
      return json(res, 200, { results: results.slice(0, 8) });
    }
    if (id === 'translator') {
      if (!process.env.LIBRETRANSLATE_URL) throw fail(503, 'Translator is not configured. Add LIBRETRANSLATE_URL to .env first.');
      const [source, target, ...textParts] = input.split('|');
      if (!source || !target || !textParts.length) throw fail(400, 'Use the format: source|target|text (for example: en|fr|Hello).');
      const payload = { q: textParts.join('|'), source: source.trim(), target: target.trim(), format: 'text' };
      if (process.env.LIBRETRANSLATE_API_KEY) payload.api_key = process.env.LIBRETRANSLATE_API_KEY;
      const result = await fetch(`${process.env.LIBRETRANSLATE_URL.replace(/\/$/, '')}/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
      const data = await result.json(); if (!result.ok) throw fail(502, data.error || 'Translation service returned an error.');
      return json(res, 200, { result: data.translatedText });
    }
    if (id === 'summarizer') {
      const models = await listModels(); const model = user.settings.model || process.env.AI_HORDE_DEFAULT_MODEL || models[0]?.id;
      if (!model) throw fail(503, 'No AI Horde chat model is available right now.');
      const result = await hordeFetch(`${CHAT_URL}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${CHAT_KEY}`, 'X-Title': 'NEXORAGPT', 'Content-Type': 'application/json', 'User-Agent': 'NEXORAGPT/1.0.0' }, body: JSON.stringify({ model, messages: [{ role: 'system', content: 'Summarize the provided text accurately and clearly. Do not invent details.' }, { role: 'user', content: input.slice(0, 20000) }], max_tokens: 512, ...(CHAT_IS_HORDE ? { horde: { include_reasoning: false } } : {}) }) });
      return json(res, 200, { result: cleanModelText(result.choices?.[0]?.message?.content || '') });
    }
    throw fail(400, 'This plugin opens from the main chat or image studio.');
  }

  if (pathname === '/api/images' && method === 'GET') {
    requireUser(); const images = db.prepare('SELECT id,prompt,style,width,height,status,mime,created_at,wait_time FROM images WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(user.id);
    return json(res, 200, { images: images.map(image => ({ ...image, url: image.status === 'done' ? `/api/images/${image.id}/file` : '' })) });
  }
  if (pathname === '/api/images' && method === 'POST') {
    requireUser(); enforceRate(req, 'image', 10, 60 * 60_000); const body = await readBody(req, 20000);
    const prompt = String(body.prompt || '').trim().slice(0, 1000);
    const width = Math.round(Number(body.width || 512)); const height = Math.round(Number(body.height || 512));
    const style = String(body.style || 'none');
    if (!prompt) throw fail(400, 'Write an image prompt first.');
    if (![width, height].every(value => Number.isInteger(value) && value >= 512 && value <= 1024 && value % 64 === 0)) throw fail(400, 'Choose supported image dimensions between 512 and 1024 pixels.');
    const stylePrompts = {
      none: '', watercolor: ', watercolor painting, soft transparent washes, subtle paper texture',
      photo: ', photorealistic photography, natural lighting, detailed image',
      anime: ', anime illustration, expressive linework, vibrant cel shading',
      pixel: ', pixel art, crisp pixels, limited color palette',
      digital: ', polished digital illustration, refined details, clear composition',
    };
    if (!Object.hasOwn(stylePrompts, style)) throw fail(400, 'Choose a supported image style.');
    const hordePrompt = `${prompt}${stylePrompts[style]}`;
    const response = await hordeFetch(`${HORDE_API}/v2/generate/async`, {
      method: 'POST', headers: { apikey: HORDE_KEY, 'Client-Agent': CLIENT_AGENT, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: hordePrompt, params: { width, height, n: 1, steps: 25, cfg_scale: 7, sampler_name: 'k_euler' }, r2: true }), timeout: 30000,
    });
    if (!response.id) throw fail(502, 'AI Horde did not accept the image request.');
    const id = uuid();
    db.prepare('INSERT INTO images(id,user_id,horde_id,prompt,style,width,height,status,created_at,wait_time) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, user.id, response.id, prompt, style, width, height, 'waiting', now(), response.wait_time || 0);
    return json(res, 202, { id, status: 'waiting', wait_time: response.wait_time || 0, message: 'Your image is in the AI Horde queue.' });
  }
  if (parts[0] === 'api' && parts[1] === 'images' && parts[2] && parts.length === 3 && method === 'GET') {
    requireUser(); const image = db.prepare('SELECT * FROM images WHERE id=? AND user_id=?').get(parts[2], user.id);
    if (!image) throw fail(404, 'Image request not found.');
    if (image.status === 'done') return json(res, 200, { id: image.id, status: 'done', prompt: image.prompt, style: image.style, url: `/api/images/${image.id}/file`, wait_time: image.wait_time });
    if (image.status === 'faulted') return json(res, 200, { id: image.id, status: 'faulted', message: 'AI Horde could not complete this image request. Try another prompt or retry later.' });
    const check = await hordeFetch(`${HORDE_API}/v2/generate/check/${encodeURIComponent(image.horde_id)}`, { headers: { 'Client-Agent': CLIENT_AGENT }, timeout: 20000 });
    const wait = check.wait_time || image.wait_time || 0;
    if (check.faulted) {
      db.prepare('UPDATE images SET status=?,wait_time=? WHERE id=?').run('faulted', wait, image.id);
      return json(res, 200, { id: image.id, status: 'faulted', message: 'AI Horde could not complete this image request.' });
    }
    if (!check.done) {
      db.prepare('UPDATE images SET status=?,wait_time=? WHERE id=?').run(check.processing ? 'processing' : 'waiting', wait, image.id);
      return json(res, 200, { id: image.id, status: check.processing ? 'processing' : 'waiting', wait_time: wait });
    }
    const full = await hordeFetch(`${HORDE_API}/v2/generate/status/${encodeURIComponent(image.horde_id)}`, { headers: { 'Client-Agent': CLIENT_AGENT }, timeout: 30000 });
    const generated = full.generations?.[0];
    if (!generated?.img) {
      db.prepare('UPDATE images SET status=? WHERE id=?').run('faulted', image.id);
      return json(res, 200, { id: image.id, status: 'faulted', message: 'AI Horde finished without returning an image.' });
    }
    const response = await fetch(generated.img, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw fail(502, 'Generated image could not be downloaded from AI Horde.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw fail(502, 'AI Horde returned an image outside the supported size.');
    const mime = response.headers.get('content-type')?.split(';')[0] || 'image/webp';
    const ext = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'webp';
    const diskPath = path.join(IMAGES, user.id, `${image.id}.${ext}`); fs.mkdirSync(path.dirname(diskPath), { recursive: true }); fs.writeFileSync(diskPath, bytes, { flag: 'w' });
    db.prepare('UPDATE images SET status=?,disk_path=?,mime=?,wait_time=? WHERE id=?').run('done', diskPath, mime, wait, image.id);
    return json(res, 200, { id: image.id, status: 'done', prompt: image.prompt, style: image.style, url: `/api/images/${image.id}/file`, wait_time: wait });
  }
  if (parts[0] === 'api' && parts[1] === 'images' && parts[2] && parts[3] === 'file' && method === 'GET') {
    requireUser(); const image = db.prepare('SELECT disk_path,mime FROM images WHERE id=? AND user_id=? AND status=?').get(parts[2], user.id, 'done');
    if (!image || !fs.existsSync(image.disk_path)) throw fail(404, 'Generated image is not available.');
    res.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': fs.statSync(image.disk_path).size, 'Cache-Control': 'private, max-age=3600', 'Content-Disposition': `inline; filename="nexoragpt-${parts[2]}.${image.mime.split('/')[1] || 'webp'}"` });
    return fs.createReadStream(image.disk_path).pipe(res);
  }

  throw fail(404, 'API route not found.');
}

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await routeApi(req, res, url);
    const requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const filePath = path.resolve(PUBLIC, `.${requested}`);
    if (!filePath.startsWith(PUBLIC + path.sep) && filePath !== path.join(PUBLIC, 'index.html')) throw fail(403, 'Forbidden.');
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat?.isFile()) throw fail(404, 'Page not found.');
    res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream', 'Content-Length': stat.size, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    if (res.headersSent) return res.destroy();
    const status = Number(err.status) || 500;
    if (status >= 500) console.error(`[${status}] ${req.method} ${url.pathname}: ${err.stack || err.message}`);
    json(res, status, { error: err.message || 'Something went wrong.', ...err.extra });
  }
});

server.listen(PORT, () => console.log(`NEXORAGPT is ready at ${ORIGIN}`));
process.on('SIGINT', () => { db.close(); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { db.close(); server.close(() => process.exit(0)); });
