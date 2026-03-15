const form = document.getElementById('createLobbyForm');
const registrationInput = document.getElementById('registrationOpens');
const supporterTimeEl = document.getElementById('supporterTime');
const boosterTimeEl = document.getElementById('boosterTime');
const verifiedTimeEl = document.getElementById('verifiedTime');
const resultBox = document.getElementById('result');
const resultText = document.getElementById('resultText');
const cancelBtn = document.getElementById('cancelBtn');
const submitBtn = form.querySelector('button[type="submit"]');
const API_BASE = String(window.SCRIMS_API_BASE || '').trim().replace(/\/+$/, '');

function apiUrl(path) {
  return API_BASE ? `${API_BASE}${path}` : path;
}

const quickLogin = document.querySelector('a[href="/auth/discord"]');
if (quickLogin) quickLogin.href = apiUrl('/auth/discord');

function addMinutes(hhmm, minutes) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  const base = new Date();
  base.setHours(Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0, 0, 0);
  base.setMinutes(base.getMinutes() + minutes);
  const hh = String(base.getHours()).padStart(2, '0');
  const mm = String(base.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function refreshPriorityTimes() {
  const opens = registrationInput.value || '00:00';
  supporterTimeEl.textContent = addMinutes(opens, 1);
  boosterTimeEl.textContent = addMinutes(opens, 2);
  verifiedTimeEl.textContent = addMinutes(opens, 3);
}

registrationInput.addEventListener('input', refreshPriorityTimes);

cancelBtn.addEventListener('click', () => {
  form.reset();
  document.getElementById('session').value = '1';
  document.getElementById('lobby').value = '1';
  registrationInput.value = '00:48';
  document.getElementById('lobbyTemplate').value = 'duo-default';
  resultBox.hidden = true;
  refreshPriorityTimes();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const session = document.getElementById('session').value;
  const lobby = document.getElementById('lobby').value;
  const opens = registrationInput.value;
  const template = document.getElementById('lobbyTemplate').value;

  const supporter = addMinutes(opens, 1);
  const booster = addMinutes(opens, 2);
  const verified = addMinutes(opens, 3);

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating...';
  }

  try {
    const response = await fetch(apiUrl('/api/create-lobby'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: Number(session),
        lobby: Number(lobby),
        registrationOpens: opens,
        lobbyTemplate: template,
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload || payload.ok !== true) {
      throw new Error(payload && payload.error ? payload.error : 'Failed to create lobby.');
    }

    resultText.textContent = `Created ${payload.categoryName}. Priority fixed: Supporter ${supporter}, Booster+CC ${booster}, Verified ${verified}.`;
    resultBox.hidden = false;
  } catch (error) {
    resultText.textContent = `Create failed: ${error && error.message ? error.message : 'Unknown error'}`;
    resultBox.hidden = false;
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create Lobby';
    }
  }
});

refreshPriorityTimes();
