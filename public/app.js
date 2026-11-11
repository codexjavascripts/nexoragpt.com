const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const state = {
  user: null, settings: { theme: 'light', model: '' }, page: 'chat', chatId: null,
  chats: [], files: [], plugins: [], images: [], pendingFiles: [], sending: false,
  activeSettings: 'profile', exploreCategory: 'All',
  exploreItems: [
    { name: 'Writing partner', category: 'Writing', icon: '✎', tone: 'violet', description: 'Find a clear first draft, smooth out a paragraph, or adjust your tone.', prompt: 'Help me write something clearly. I’ll share what I’m working on: ' },
    { name: 'Code companion', category: 'Coding', icon: '</>', tone: 'blue', description: 'Work through code, understand an error, or explore a better approach.', prompt: 'Help me with this coding problem. Explain your approach and show code where useful: ' },
    { name: 'Study guide', category: 'Education', icon: '▤', tone: 'mint', description: 'Break a topic down, make practice questions, or study one step at a time.', prompt: 'Help me study this topic in small steps, with clear examples: ' },
    { name: 'Research starter', category: 'Research', icon: '⌕', tone: 'gold', description: 'Frame a question, organize what you know, and identify useful next steps.', prompt: 'Help me explore this question. Separate established facts from things I should verify: ' },
    { name: 'Idea workshop', category: 'Creative ideas', icon: '✧', tone: 'pink', description: 'Explore different directions and build one into something more concrete.', prompt: 'Help me brainstorm a range of ideas for this: ' },
    { name: 'Business planner', category: 'Business', icon: '◫', tone: 'blue', description: 'Structure a plan, clarify tradeoffs, or prepare for a decision.', prompt: 'Help me think through this business problem. Ask clarifying questions where useful: ' },
    { name: 'Science explainer', category: 'Science', icon: '⚛', tone: 'mint', description: 'Explore scientific concepts with plain-language explanations and caveats.', prompt: 'Explain this science topic clearly, including what is well established and what is uncertain: ' },
    { name: 'Image creator', category: 'Image creation', icon: '▧', tone: 'peach', description: 'Write a detailed prompt and generate an image with AI Horde.', action: 'images' },
    { name: 'Daily organizer', category: 'Productivity', icon: '☼', tone: 'gold', description: 'Turn an open-ended task into a manageable plan for your day.', prompt: 'Help me turn this into a practical plan with clear next steps: ' },
    { name: 'Story room', category: 'Entertainment', icon: '✴', tone: 'pink', description: 'Shape a character, build a scene, or try out a playful story direction.', prompt: 'Let’s develop a fun story idea together. Start by helping me build this premise: ' },
  ],
  imagePollTimer: null, toastTimer: null,
};

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
  const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : {};
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function toast(message) {
  const node = $('#toast'); node.textContent = message; node.classList.add('show');
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => node.classList.remove('show'), 3100);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
function safeHttpUrl(value) {
  try { const url = new URL(String(value)); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
}
function renderText(text) {
  let html = esc(text);
  html = html.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>');
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return html;
}
function humanDate(timestamp) {
  const date = new Date(Number(timestamp));
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function showStartupError(message) {
  $('#authScreen').hidden = false; $('#appShell').hidden = true;
  $('#startupMessage').textContent = message;
}
$('#retryStartup').addEventListener('click', boot);
async function enterApp(user, settings = {}) {
  state.user = user; state.settings = { theme: 'light', model: '', ...(settings || {}) };
  $('#authScreen').hidden = true; $('#appShell').hidden = false;
  $('#userName').textContent = user.username || 'Guest'; $('#userContext').textContent = 'Private guest workspace';
  $('#userAvatar').textContent = (user.username || 'Guest')[0].toUpperCase();
  applyTheme(state.settings.theme || 'light');
  bindMainEvents();
  await loadChats();
  await Promise.all([loadPlugins(), loadImages()]);
  if (state.chats.length) await openChat(state.chats[0].id, false);
  else showWelcome();
  goPage('chat');
}

let mainEventsBound = false;
function bindMainEvents() {
  if (mainEventsBound) return; mainEventsBound = true;
  $('#newChat').addEventListener('click', createNewChat);
  $$('.nav-item[data-page]').forEach(button => button.addEventListener('click', () => goPage(button.dataset.page)));
  $('#themeToggle').addEventListener('click', toggleTheme);
  $('#topSettings').addEventListener('click', () => goPage('settings'));
  $('#userMenu').addEventListener('click', () => goPage('settings'));
  $('#composer').addEventListener('submit', sendMessage);
  $('#messageInput').addEventListener('input', autoresize);
  $('#messageInput').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#composer').requestSubmit(); } });
  $('#attachButton').addEventListener('click', () => $('#filePicker').click());
  $('#filePicker').addEventListener('change', addFile);
  $$('.prompt-card').forEach(button => button.addEventListener('click', () => { $('#messageInput').value = button.dataset.prompt; autoresize(); $('#messageInput').focus(); }));
  $('#searchToggle').addEventListener('click', () => { $('#chatSearchBox').hidden = !$('#chatSearchBox').hidden; if (!$('#chatSearchBox').hidden) $('#chatSearch').focus(); });
  $('#chatSearch').addEventListener('input', debounce(() => loadChats($('#chatSearch').value), 240));
  $('#clearSearch').addEventListener('click', () => { $('#chatSearch').value = ''; loadChats(); });
  $('#mobileMenu').addEventListener('click', openMobileNav); $('#mobileClose').addEventListener('click', closeMobileNav); $('#sidebarScrim').addEventListener('click', closeMobileNav);
  $('#imagePrompt').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') generateImage(); });
  $('#generateImage').addEventListener('click', generateImage);
  $('#exploreSearch').addEventListener('input', renderExplore);
  $('#categoryFilters').addEventListener('click', event => { const target = event.target.closest('[data-category]'); if (target) { state.exploreCategory = target.dataset.category; renderExplore(); } });
  $('#pluginGrid').addEventListener('click', pluginGridClick);
  $$('.settings-tab').forEach(button => button.addEventListener('click', () => { state.activeSettings = button.dataset.settings; renderSettings(); }));
  $('#settingsContent').addEventListener('submit', settingsSubmit);
  $('#settingsContent').addEventListener('click', settingsClick);
  window.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); createNewChat(); } if (event.key === 'Escape') closeMobileNav(); });
}

function applyTheme(theme) {
  const value = theme === 'dark' ? 'dark' : 'light'; state.settings.theme = value;
  document.body.classList.toggle('dark', value === 'dark');
  $('#themeToggle .theme-control span:nth-child(2)')?.replaceChildren(document.createTextNode(value === 'dark' ? 'Light appearance' : 'Dark appearance'));
}
async function toggleTheme() {
  const next = state.settings.theme === 'dark' ? 'light' : 'dark'; applyTheme(next);
  try { state.settings = { ...state.settings, ...await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ theme: next }) }) }; }
  catch (err) { toast(err.message); }
}
function openMobileNav() { $('#sidebar').classList.add('open'); $('#sidebarScrim').classList.add('show'); }
function closeMobileNav() { $('#sidebar').classList.remove('open'); $('#sidebarScrim').classList.remove('show'); }
function debounce(fn, delay) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); }; }
function autoresize() { const node = $('#messageInput'); node.style.height = 'auto'; node.style.height = `${Math.min(node.scrollHeight, 150)}px`; }

function goPage(page) {
  state.page = page; closeMobileNav();
  const pages = { chat: '#chatPage', images: '#imagesPage', explore: '#explorePage', plugins: '#pluginsPage', settings: '#settingsPage' };
  Object.entries(pages).forEach(([name, selector]) => { $(selector).hidden = name !== page; });
  $$('.nav-item[data-page]').forEach(node => node.classList.toggle('active', node.dataset.page === page));
  $('#topTitle').textContent = ({ chat: 'Chat', images: 'Image studio', explore: 'Explore', plugins: 'Plugins', settings: 'Settings' })[page] || 'Chat';
  if (page === 'images') { loadImages(); pollImages(); }
  if (page === 'explore') renderExplore();
  if (page === 'plugins') loadPlugins();
  if (page === 'settings') renderSettings();
}

async function loadChats(query = '') {
  if (!state.user) return;
  try {
    const data = await api(`/api/chats${query ? `?q=${encodeURIComponent(query)}` : ''}`); state.chats = data.chats;
    renderChatList();
  } catch (err) { if (err.message !== 'Guest workspace is unavailable. Reload the page to start one.') toast(err.message); }
}
function renderChatList() {
  const box = $('#chatHistory');
  if (!state.chats.length) { box.innerHTML = '<div class="empty-state" style="padding:16px 8px;font-size:10px">Your conversations will appear here.</div>'; return; }
  box.innerHTML = state.chats.map(chat => `<div class="history-item ${state.chatId === chat.id ? 'active' : ''}" data-chat="${esc(chat.id)}"><span class="history-dot">◦</span><span class="history-name" title="${esc(chat.title)}">${esc(chat.title)}</span><span class="history-actions"><button data-rename="${esc(chat.id)}" title="Rename">✎</button><button data-delete="${esc(chat.id)}" title="Delete">×</button></span></div>`).join('');
  box.querySelectorAll('.history-item').forEach(item => item.addEventListener('click', event => {
    const rename = event.target.closest('[data-rename]'); const remove = event.target.closest('[data-delete]');
    if (rename) { event.stopPropagation(); renameChat(rename.dataset.rename); return; }
    if (remove) { event.stopPropagation(); deleteChat(remove.dataset.delete); return; }
    openChat(item.dataset.chat);
  }));
}
async function createNewChat() {
  try {
    const result = await api('/api/chats', { method: 'POST', body: '{}' });
    state.chats.unshift(result);
    state.chatId = result.id; state.files = []; state.pendingFiles = []; renderAttachments();
    showWelcome(); renderChatList(); goPage('chat'); $('#messageInput').focus();
  } catch (err) { toast(err.message); }
}
async function openChat(id, refreshList = true) {
  try {
    const data = await api(`/api/chats/${encodeURIComponent(id)}`); state.chatId = id; state.files = data.files || []; state.pendingFiles = [];
    renderAttachments(); renderMessages(data.messages || []); if (refreshList) await loadChats();
  } catch (err) { toast(err.message); }
}
function showWelcome() {
  $('#chatMessages').innerHTML = ''; $('#welcome').hidden = false; $('#topTitle').textContent = 'Chat';
}
function renderMessages(messages) {
  $('#welcome').hidden = messages.length > 0; $('#chatMessages').innerHTML = '';
  for (const message of messages) addMessage(message.role, message.content, message.id);
  scrollChat();
}
function addMessage(role, content, id = '', options = {}) {
  const row = document.createElement('article'); row.className = `message-row ${role === 'user' ? 'user' : 'assistant'}`;
  const isAssistant = role === 'assistant';
  row.innerHTML = `<div class="message-avatar">${isAssistant ? 'N' : esc((state.user?.username || 'Y')[0].toUpperCase())}</div><div class="message-content"><div class="message-role">${isAssistant ? 'NEXORAGPT' : 'You'}</div><div class="message-text">${options.typing ? '<div class="typing"><i></i><i></i><i></i></div>' : renderText(content)}</div><div class="message-actions">${isAssistant && !options.typing ? `<button data-copy>Copy</button><button data-regenerate>Regenerate</button>` : ''}</div></div>`;
  if (options.error) row.querySelector('.message-text').innerHTML = `<div class="message-error">${esc(content)}</div>`;
  if (isAssistant && !options.typing) {
    row.querySelector('[data-copy]')?.addEventListener('click', async () => { try { await navigator.clipboard.writeText(content); toast('Copied to clipboard.'); } catch { toast('Could not access the clipboard.'); } });
    row.querySelector('[data-regenerate]')?.addEventListener('click', () => regenerateReply());
  }
  $('#chatMessages').append(row); if (!isAssistant) $('#welcome').hidden = true; scrollChat(); return row;
}
function scrollChat() { const box = $('#chatMessages'); requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; }); }

async function addFile() {
  const file = $('#filePicker').files[0]; if (!file) return;
  if (file.size > 8 * 1024 * 1024) { toast('Choose a file smaller than 8 MB.'); $('#filePicker').value = ''; return; }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = await api('/api/files', { method: 'POST', body: JSON.stringify({ name: file.name, mime: file.type || 'application/octet-stream', data: reader.result }) });
      state.pendingFiles.push(data.file); renderAttachments(); toast(`${file.name} is ready to attach.`);
    } catch (err) { toast(err.message); }
    $('#filePicker').value = '';
  };
  reader.onerror = () => toast('Could not read that file.'); reader.readAsDataURL(file);
}
function renderAttachments() {
  $('#attachmentChips').innerHTML = state.pendingFiles.map(file => `<span class="attachment-chip">${file.mime.startsWith('image/') ? '▧' : '▤'} ${esc(file.name)} <button type="button" data-remove-file="${esc(file.id)}" aria-label="Remove ${esc(file.name)}">×</button></span>`).join('');
  $('#attachmentChips').querySelectorAll('[data-remove-file]').forEach(button => button.addEventListener('click', async () => {
    try { await api(`/api/files/${encodeURIComponent(button.dataset.removeFile)}`, { method: 'DELETE' }); state.pendingFiles = state.pendingFiles.filter(file => file.id !== button.dataset.removeFile); renderAttachments(); }
    catch (err) { toast(err.message); }
  }));
}

async function sendMessage(event) {
  event?.preventDefault(); if (state.sending) return;
  const input = $('#messageInput'); const message = input.value.trim();
  if (!message) { if (state.pendingFiles.length) toast('Add a question about the attached file.'); return; }
  state.sending = true; $('#sendButton').disabled = true;
  try {
    if (!state.chatId) { const created = await api('/api/chats', { method: 'POST', body: '{}' }); state.chatId = created.id; }
    $('#welcome').hidden = true; addMessage('user', message);
    input.value = ''; autoresize(); const typing = addMessage('assistant', '', '', { typing: true });
    const result = await api(`/api/chats/${encodeURIComponent(state.chatId)}/messages`, { method: 'POST', body: JSON.stringify({ message, fileIds: state.pendingFiles.map(file => file.id) }), signal: AbortSignal.timeout(180000) });
    typing.remove(); state.pendingFiles = []; renderAttachments(); renderMessages(result.messages); await loadChats();
  } catch (err) {
    $('#chatMessages .message-row.assistant:last-child')?.remove();
    addMessage('assistant', `${err.message} You can try again.`, '', { error: true });
    await loadChats();
  } finally { state.sending = false; $('#sendButton').disabled = false; input.focus(); }
}
async function regenerateReply() {
  if (!state.chatId || state.sending) return;
  state.sending = true; $('#sendButton').disabled = true;
  const messages = [...$('#chatMessages').querySelectorAll('.message-row')];
  messages.at(-1)?.remove(); const typing = addMessage('assistant', '', '', { typing: true });
  try {
    const result = await api(`/api/chats/${encodeURIComponent(state.chatId)}/regenerate`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(180000) });
    typing.remove(); renderMessages(result.messages); toast('A fresh response is ready.');
  } catch (err) { typing.remove(); addMessage('assistant', err.message, '', { error: true }); }
  finally { state.sending = false; $('#sendButton').disabled = false; }
}
async function renameChat(id) {
  const chat = state.chats.find(item => item.id === id); const title = prompt('Rename this conversation', chat?.title || '');
  if (title === null) return;
  try { await api(`/api/chats/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title }) }); await loadChats($('#chatSearch').value); if (state.chatId === id) $('#topTitle').textContent = title; }
  catch (err) { toast(err.message); }
}
async function deleteChat(id) {
  const chat = state.chats.find(item => item.id === id); if (!confirm(`Delete “${chat?.title || 'this conversation'}”?`)) return;
  try { await api(`/api/chats/${encodeURIComponent(id)}`, { method: 'DELETE' }); if (state.chatId === id) { state.chatId = null; showWelcome(); } await loadChats($('#chatSearch').value); toast('Conversation deleted.'); }
  catch (err) { toast(err.message); }
}

async function loadImages() {
  try { const data = await api('/api/images'); state.images = data.images; renderImages(); if (state.images.some(image => image.status !== 'done' && image.status !== 'faulted')) pollImages(); }
  catch (err) { if (state.user) toast(err.message); }
}
function renderImages() {
  $('#imageCount').textContent = state.images.length ? `${state.images.length} saved` : '';
  if (!state.images.length) { $('#imageGallery').innerHTML = '<div class="empty-state">Your generated images will be saved here.</div>'; return; }
  $('#imageGallery').innerHTML = state.images.map(image => {
    const view = image.status === 'done' ? `<img src="${esc(image.url)}" alt="Generated image: ${esc(image.prompt)}">` : `<div class="image-pending">${image.status === 'faulted' ? 'The worker could not complete this request.' : `<div class="spinner"></div>${image.status === 'processing' ? 'A worker is creating your image…' : 'Waiting in the community queue…'}<br>${image.wait_time ? `About ${Math.ceil(image.wait_time / 60)} min estimated` : 'Queue time varies'}`}</div>`;
    const styleName = ({ none: 'Natural', watercolor: 'Watercolor', photo: 'Photo', anime: 'Anime', pixel: 'Pixel art', digital: 'Digital art' })[image.style] || 'Natural';
    return `<article class="image-card"><div class="image-preview">${view}</div><div class="image-info"><div class="image-prompt" title="${esc(image.prompt)}">${esc(image.prompt)}</div><div class="image-meta"><span>${esc(image.width)} × ${esc(image.height)} · ${esc(styleName)}</span>${image.status === 'done' ? `<a href="${esc(image.url)}" download="nexoragpt-image">Download ↓</a>` : ''}</div></div></article>`;
  }).join('');
}
let imagePollLock = false;
async function pollImages() {
  if (imagePollLock || !state.user || !state.images.some(image => image.status !== 'done' && image.status !== 'faulted')) return;
  imagePollLock = true;
  try {
    for (const image of state.images.filter(item => item.status !== 'done' && item.status !== 'faulted')) {
      const result = await api(`/api/images/${encodeURIComponent(image.id)}`);
      Object.assign(image, result);
    }
    renderImages();
  } catch (err) { if (state.page === 'images') toast(err.message); }
  finally { imagePollLock = false; clearTimeout(state.imagePollTimer); if (state.images.some(image => image.status !== 'done' && image.status !== 'faulted')) state.imagePollTimer = setTimeout(pollImages, 2500); }
}
async function generateImage() {
  const prompt = $('#imagePrompt').value.trim(); if (!prompt) { toast('Describe the image you want to create.'); $('#imagePrompt').focus(); return; }
  const button = $('#generateImage'); button.disabled = true; button.innerHTML = '<span class="spinner"></span> Sending to AI Horde';
  try {
    const [width, height] = $('#imageSize').value.split('x').map(Number); const style = $('#imageStyle').value;
    const result = await api('/api/images', { method: 'POST', body: JSON.stringify({ prompt, width, height, style }) });
    state.images.unshift({ id: result.id, prompt, style, width, height, status: result.status, wait_time: result.wait_time, created_at: Date.now() }); renderImages(); pollImages(); toast('Image request joined the AI Horde queue.');
  } catch (err) { toast(err.message); }
  finally { button.disabled = false; button.innerHTML = '<span>✧</span> Generate image'; }
}

function renderExplore() {
  const categories = ['All', ...new Set(state.exploreItems.map(item => item.category))];
  $('#categoryFilters').innerHTML = categories.map(category => `<button class="category-pill ${state.exploreCategory === category ? 'active' : ''}" data-category="${esc(category)}">${esc(category)}</button>`).join('');
  const query = $('#exploreSearch').value.trim().toLowerCase();
  const items = state.exploreItems.filter(item => (state.exploreCategory === 'All' || item.category === state.exploreCategory) && `${item.name} ${item.category} ${item.description}`.toLowerCase().includes(query));
  $('#exploreGrid').innerHTML = items.length ? items.map(item => `<article class="explore-card"><div class="card-top"><span class="tool-icon ${esc(item.tone)}">${esc(item.icon)}</span><span><h3>${esc(item.name)}</h3><span class="card-category">${esc(item.category)}</span></span></div><p>${esc(item.description)}</p><button class="card-action" data-explore="${esc(item.name)}">${item.action ? 'Open image studio ↗' : 'Start with this ↗'}</button></article>`).join('') : '<div class="empty-state">No matching starting points. Try another search.</div>';
  $('#exploreGrid').querySelectorAll('[data-explore]').forEach(button => button.addEventListener('click', async () => {
    const item = state.exploreItems.find(value => value.name === button.dataset.explore);
    if (item.action) { goPage(item.action); return; }
    await createNewChat(); $('#messageInput').value = item.prompt; autoresize(); $('#messageInput').focus();
  }));
}

async function loadPlugins() {
  try { const result = await api('/api/plugins'); state.plugins = result.plugins; renderPlugins(); }
  catch (err) { if (state.user) toast(err.message); }
}
function renderPlugins() {
  const enabled = state.plugins.filter(plugin => plugin.enabled).length; $('#pluginCount').textContent = enabled;
  const tones = ['violet', 'peach', 'blue', 'mint', 'gold', 'pink'];
  $('#pluginGrid').innerHTML = state.plugins.map((plugin, index) => `<article class="plugin-card"><div class="card-top"><span class="tool-icon ${tones[index % tones.length]}">${esc(plugin.icon)}</span><span><h3>${esc(plugin.name)}</h3><span class="card-category">${esc(plugin.category)}${plugin.configured === false ? ' · Setup required' : ''}</span></span></div><p>${esc(plugin.description)}</p><div class="plugin-perms">${esc(plugin.permissions)}</div><div class="plugin-bottom"><span class="plugin-category">${plugin.enabled ? 'Enabled' : 'Not enabled'}</span><div style="display:flex;gap:8px"><button class="card-action" data-open-plugin="${esc(plugin.id)}">Open</button><button class="plugin-toggle ${plugin.enabled ? 'enabled' : ''}" data-toggle-plugin="${esc(plugin.id)}" ${plugin.configured === false ? 'disabled title="Configure LibreTranslate in .env"' : ''}>${plugin.enabled ? 'On' : 'Enable'}</button></div></div></article>`).join('');
}
async function pluginGridClick(event) {
  const toggle = event.target.closest('[data-toggle-plugin]'); const open = event.target.closest('[data-open-plugin]');
  if (toggle) {
    const plugin = state.plugins.find(item => item.id === toggle.dataset.togglePlugin); if (!plugin) return;
    try { await api('/api/plugins', { method: 'PATCH', body: JSON.stringify({ id: plugin.id, enabled: !plugin.enabled }) }); await loadPlugins(); toast(`${plugin.name} ${plugin.enabled ? 'disabled' : 'enabled'}.`); }
    catch (err) { toast(err.message); }
  }
  if (open) openPlugin(open.dataset.openPlugin);
}
function openPlugin(id) {
  const plugin = state.plugins.find(item => item.id === id); if (!plugin) return;
  if (['image_tools'].includes(id)) { goPage('images'); return; }
  if (['file_analysis', 'code_helper'].includes(id)) {
    goPage('chat'); if (id === 'file_analysis') $('#filePicker').click(); else $('#messageInput').value = 'Help me with this code. Explain your reasoning and suggest improvements:\n';
    if (id === 'code_helper') { autoresize(); $('#messageInput').focus(); } return;
  }
  if (!plugin.enabled) { toast('Enable this plugin first.'); return; }
  const inputLabel = ({ calculator: 'Arithmetic expression', weather: 'City or postal code', web_search: 'Search query', summarizer: 'Text to summarize', translator: 'Source|target|text (for example en|fr|Hello)' })[id] || 'Input';
  $('#pluginDialogContent').innerHTML = `<span class="eyebrow">${esc(plugin.category.toUpperCase())}</span><h2>${esc(plugin.name)}</h2><p>${esc(plugin.description)}</p><p><strong>Permissions:</strong> ${esc(plugin.permissions)}</p><form id="pluginRunForm"><label class="form-field"><span style="font-size:10px;color:#777284;font-weight:600;margin-bottom:6px">${esc(inputLabel)}</span><textarea name="input" rows="3" required placeholder="Enter ${esc(inputLabel.toLowerCase())}…"></textarea></label><div style="display:flex;justify-content:flex-end;margin-top:10px"><button class="small-button primary" type="submit">Run ${esc(plugin.name)}</button></div><div id="pluginResult" style="margin-top:14px"></div></form>`;
  const dialog = $('#pluginDialog'); dialog.showModal();
  $('#pluginRunForm').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button[type="submit"]'); button.disabled = true;
    const output = $('#pluginResult'); output.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>';
    try {
      const result = await api('/api/plugins/run', { method: 'POST', body: JSON.stringify({ id, input: form.elements.input.value }) });
      if (result.results) output.innerHTML = `<div class="modal-results">${result.results.map(item => { const href = safeHttpUrl(item.url); return `<p>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(item.title || item.url)}</a>` : esc(item.title || 'Result')}<br>${esc(item.text)}</p>`; }).join('')}</div>`;
      else output.innerHTML = `<div class="modal-results">${esc(result.result)}</div>`;
    } catch (err) { output.innerHTML = `<div class="auth-error">${esc(err.message)}</div>`; }
    finally { button.disabled = false; }
  });
}

function renderSettings() {
  $$('.settings-tab').forEach(button => button.classList.toggle('active', button.dataset.settings === state.activeSettings));
  const container = $('#settingsContent');
  if (state.activeSettings === 'profile') {
    container.innerHTML = `<h2>Profile</h2><p>This private guest workspace does not use an email address or password.</p><form id="profileForm"><div class="settings-field"><label for="profileUsername">Display name</label><input id="profileUsername" name="username" required minlength="2" maxlength="40" value="${esc(state.user.username)}"></div><div class="settings-actions"><button class="small-button primary" type="submit">Save name</button></div><div id="settingsNotice"></div></form>`;
  } else if (state.activeSettings === 'ai') {
    container.innerHTML = `<h2>AI model</h2><p>Choose a currently available AI Horde chat model.</p><div id="modelChoices" class="model-list"><div class="empty-state">Loading currently available models…</div></div><p class="setting-help">AI Horde is a community-run worker network. Model availability and queue times change over time. Messages are sent to the selected worker to generate replies.</p><div class="settings-actions"><button class="small-button" id="refreshModels">Refresh models</button></div>`;
    loadModelChoices();
  } else {
    container.innerHTML = `<h2>Privacy</h2><p>How this guest workspace handles your information.</p><div class="settings-value" style="line-height:1.7">No email or password is collected. Your chats, uploaded files, and generated images are saved on this server and tied to this browser’s private guest session. Clearing this browser’s site data starts a new workspace; the old workspace remains on the server until cleared. When you ask for an AI response or image, your prompt and relevant conversation or file content are sent to AI Horde community workers. Avoid sharing sensitive information.</div><div class="settings-actions"><button class="small-button danger" id="deleteAccountButton">Clear this guest workspace</button></div><p class="setting-help">This permanently removes the guest workspace, saved conversations, uploaded files, generated images, and its session.</p><div class="settings-actions"><button class="small-button" id="openPluginSettings">Manage plugins</button><button class="small-button" id="openImageSettings">Image studio</button></div>`;
  }
}
async function loadModelChoices() {
  const list = $('#modelChoices'); if (!list) return;
  try {
    const { models } = await api('/api/models');
    if (!models.length) { list.innerHTML = '<div class="empty-state">No AI Horde chat models are online right now.</div>'; return; }
    list.innerHTML = models.map(model => `<label class="model-option"><input type="radio" name="aiModel" value="${esc(model.id)}" ${state.settings.model === model.id ? 'checked' : ''}><span>${esc(model.name)}</span><small>${esc(model.workers)} worker${model.workers === 1 ? '' : 's'}${model.queued ? ` · ${esc(model.queued)} queued` : ''}</small></label>`).join('');
    list.querySelectorAll('input').forEach(input => input.addEventListener('change', async () => {
      state.settings.model = input.value;
      try { await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ model: input.value }) }); toast('Model preference saved.'); }
      catch (err) { toast(err.message); }
    }));
  } catch (err) { list.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`; }
}
async function settingsSubmit(event) {
  event.preventDefault(); const form = event.target;
  if (form.id === 'profileForm') {
    const username = $('#profileUsername').value.trim();
    try { await api('/api/profile', { method: 'PATCH', body: JSON.stringify({ username }) }); state.user.username = username; $('#userName').textContent = username; $('#userAvatar').textContent = username[0].toUpperCase(); toast('Profile saved.'); }
    catch (err) { $('#settingsNotice').innerHTML = `<div class="auth-error">${esc(err.message)}</div>`; }
  }
}
async function settingsClick(event) {
  if (event.target.closest('#refreshModels')) loadModelChoices();
  if (event.target.closest('#openPluginSettings')) goPage('plugins');
  if (event.target.closest('#openImageSettings')) goPage('images');
  if (event.target.closest('#deleteAccountButton')) deleteAccount();
}
async function deleteAccount() {
  if (!confirm('Clear this guest workspace and permanently delete its chats, files, and images?')) return;
  try { await api('/api/account', { method: 'DELETE', body: '{}' }); location.reload(); }
  catch (err) { toast(err.message); }
}

async function boot() {
  try {
    const data = await api('/api/session');
    await enterApp(data.user, data.settings || {});
  } catch (err) { showStartupError(`${err.message} Make sure NEXORAGPT is running, then try again.`); }
}
boot();
