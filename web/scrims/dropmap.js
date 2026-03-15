const lobbyInput = document.getElementById('lobbyInput');
const spotInput = document.getElementById('spotInput');
const saveBtn = document.getElementById('saveBtn');
const clearBtn = document.getElementById('clearBtn');
const mapBox = document.getElementById('mapBox');
const markersLayer = document.getElementById('markersLayer');
const marksList = document.getElementById('marksList');
const authText = document.getElementById('authText');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const API_BASE = String(window.SCRIMS_API_BASE || '').trim().replace(/\/+$/, '');

function apiUrl(path) {
  return API_BASE ? `${API_BASE}${path}` : path;
}

if (loginBtn) loginBtn.href = apiUrl('/auth/discord');
if (logoutBtn) logoutBtn.href = apiUrl('/auth/logout');

const loginNavLink = document.querySelector('a[href="/auth/discord"]');
if (loginNavLink) loginNavLink.href = apiUrl('/auth/discord');

let selectedPos = { x: 50, y: 50 };
let previewDot = null;
let marks = [];
let currentUser = null;

function lobbyValue() {
  const n = Number(lobbyInput.value || 1);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function setPreview(x, y) {
  selectedPos = { x, y };
  if (!previewDot) {
    previewDot = document.createElement('div');
    previewDot.className = 'preview-dot';
    markersLayer.appendChild(previewDot);
  }
  previewDot.style.left = `${x}%`;
  previewDot.style.top = `${y}%`;
}

function mapClickToPercent(event) {
  const rect = mapBox.getBoundingClientRect();
  const relX = ((event.clientX - rect.left) / rect.width) * 100;
  const relY = ((event.clientY - rect.top) / rect.height) * 100;
  return {
    x: Math.max(0, Math.min(100, Number(relX.toFixed(3)))),
    y: Math.max(0, Math.min(100, Number(relY.toFixed(3)))),
  };
}

function renderMarks() {
  markersLayer.querySelectorAll('.marker').forEach(el => el.remove());

  for (const mark of marks) {
    const marker = document.createElement('div');
    marker.className = 'marker';
    marker.style.left = `${mark.x}%`;
    marker.style.top = `${mark.y}%`;
    const avatar = String(mark.avatarUrl || '').trim();
    marker.innerHTML = `<div class="marker-row">${avatar ? `<img src="${avatar}" alt="" />` : ''}<b>${mark.player || 'User'}</b></div><div>${mark.label}</div>`;
    markersLayer.appendChild(marker);
  }

  marksList.innerHTML = '';
  if (!marks.length) {
    const li = document.createElement('li');
    li.textContent = 'Noch keine Markierungen.';
    marksList.appendChild(li);
    return;
  }

  for (const mark of marks) {
    const li = document.createElement('li');
    const txt = document.createElement('span');
    txt.textContent = `${mark.player} – ${mark.label} (${mark.x.toFixed(1)}%, ${mark.y.toFixed(1)}%)`;
    const del = document.createElement('button');
    del.textContent = 'Löschen';
    del.addEventListener('click', () => deleteMark(mark.id));
    li.appendChild(txt);
    li.appendChild(del);
    marksList.appendChild(li);
  }
}

async function loadMarks() {
  const lobby = lobbyValue();
  const res = await fetch(apiUrl(`/api/dropmap/state?lobby=${encodeURIComponent(lobby)}`), {
    credentials: 'include',
  });
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || 'Konnte Markierungen nicht laden.');
  marks = Array.isArray(payload.marks) ? payload.marks : [];
  renderMarks();
}

async function saveMark() {
  if (!currentUser) throw new Error('Bitte zuerst Discord verbinden.');
  const label = String(spotInput.value || '').trim();
  if (!label) throw new Error('Bitte Spot-Namen eintragen.');

  const body = {
    lobby: lobbyValue(),
    label,
    x: selectedPos.x,
    y: selectedPos.y,
  };

  const res = await fetch(apiUrl('/api/dropmap/mark'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || 'Speichern fehlgeschlagen.');
  marks = Array.isArray(payload.marks) ? payload.marks : [];
  renderMarks();
}

async function deleteMark(id) {
  const res = await fetch(apiUrl('/api/dropmap/delete'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lobby: lobbyValue(), id }),
  });
  const payload = await res.json();
  if (!res.ok || !payload.ok) {
    alert(payload.error || 'Löschen fehlgeschlagen.');
    return;
  }
  marks = Array.isArray(payload.marks) ? payload.marks : [];
  renderMarks();
}

async function loadMe() {
  const res = await fetch(apiUrl('/api/me'), { credentials: 'include' });
  const payload = await res.json().catch(() => ({}));
  currentUser = payload && payload.user ? payload.user : null;

  if (!currentUser) {
    authText.textContent = 'Nicht verbunden';
    loginBtn.hidden = false;
    logoutBtn.hidden = true;
    saveBtn.disabled = true;
    return;
  }

  authText.innerHTML = `<span class="auth-user">${currentUser.avatarUrl ? `<img src="${currentUser.avatarUrl}" alt="" />` : ''}<strong>${currentUser.username}</strong></span>`;
  loginBtn.hidden = true;
  logoutBtn.hidden = false;
  saveBtn.disabled = false;
}

async function clearLobby() {
  if (!confirm(`Lobby ${lobbyValue()} wirklich leeren?`)) return;
  const res = await fetch(apiUrl('/api/dropmap/clear'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lobby: lobbyValue() }),
  });
  const payload = await res.json();
  if (!res.ok || !payload.ok) {
    alert(payload.error || 'Clear fehlgeschlagen.');
    return;
  }
  marks = [];
  renderMarks();
}

mapBox.addEventListener('click', (event) => {
  const pos = mapClickToPercent(event);
  setPreview(pos.x, pos.y);
});

saveBtn.addEventListener('click', async () => {
  try {
    saveBtn.disabled = true;
    await saveMark();
  } catch (e) {
    alert(e.message || 'Fehler beim Speichern.');
  } finally {
    saveBtn.disabled = false;
  }
});

clearBtn.addEventListener('click', async () => {
  try {
    clearBtn.disabled = true;
    await clearLobby();
  } finally {
    clearBtn.disabled = false;
  }
});

lobbyInput.addEventListener('change', () => {
  loadMarks().catch((e) => alert(e.message || 'Laden fehlgeschlagen.'));
});

setPreview(50, 50);
Promise.resolve()
  .then(() => loadMe())
  .then(() => loadMarks())
  .catch((e) => alert(e.message || 'Laden fehlgeschlagen.'));
