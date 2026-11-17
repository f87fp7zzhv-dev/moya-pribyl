(() => {
  const cfgKeys = { url: 'profitSupabaseUrl', anon: 'profitSupabaseAnonKey' };
  const sessionKey = 'profitSupabaseSession';
  let session = null;
  let lastRemoteUpdatedAt = '';
  let saveTimer = 0;
  let pollTimer = 0;
  let busy = false;
  const $ = selector => document.querySelector(selector);
  const status = text => { const el = $('#syncStatus'); if (el) el.textContent = text; };
  const hasFinanceData = data => Boolean(
    (data?.entries?.length || 0) +
    (data?.recurring?.length || 0) +
    (data?.expenses?.length || 0) +
    (data?.paymentReminders?.length || 0) +
    Object.keys(data?.budgets || {}).length ||
    Number(data?.savings) > 0
  );
  const config = () => ({
    url: (localStorage.getItem(cfgKeys.url) || '').replace(/\/$/, ''),
    anon: localStorage.getItem(cfgKeys.anon) || ''
  });
  const ready = () => { const c = config(); return /^https:\/\//i.test(c.url) && Boolean(c.anon); };
  const readSession = () => { try { return JSON.parse(localStorage.getItem(sessionKey) || 'null'); } catch { return null; } };
  const writeSession = value => { session = value; if (value) localStorage.setItem(sessionKey, JSON.stringify(value)); else localStorage.removeItem(sessionKey); };
  const headers = token => ({ apikey: config().anon, Authorization: `Bearer ${token || config().anon}`, 'Content-Type': 'application/json' });
  async function request(path, options = {}, token) {
    const response = await fetch(config().url + path, { ...options, headers: { ...headers(token), ...(options.headers || {}) } });
    if (!response.ok) throw new Error(`Supabase ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  async function refreshSession() {
    if (!session?.refresh_token) return false;
    const body = await request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: session.refresh_token }) });
    if (!body?.access_token) return false;
    writeSession({ ...body, expires_at: Math.floor(Date.now() / 1000) + Number(body.expires_in || 3600) });
    return true;
  }
  async function authenticatedUser() {
    if (!session?.access_token) return null;
    if (Number(session.expires_at || 0) < Math.floor(Date.now() / 1000) + 60 && !(await refreshSession())) { writeSession(null); return null; }
    try { return await request('/auth/v1/user', {}, session.access_token); }
    catch { if (await refreshSession()) return request('/auth/v1/user', {}, session.access_token); writeSession(null); return null; }
  }
  function updateControls() {
    const signOut = $('#syncSignOut');
    if (signOut) signOut.hidden = !session;
  }
  function enablePolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (document.visibilityState === 'visible') pullRemote(); }, 12000);
  }
  async function pushRemote(snapshot) {
    if (!session || !ready() || busy) return;
    busy = true;
    try {
      await request('/rest/v1/profit_sync?on_conflict=user_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({ user_id: session.user.id, payload: snapshot || window.profitSyncBridge.snapshot() })
      }, session.access_token);
      const now = new Date().toISOString();
      lastRemoteUpdatedAt = now;
      localStorage.setItem('profitLocalUpdatedAt', String(Date.now()));
      status('Синхронизировано. Изменения появятся на других устройствах в течение нескольких секунд.');
    } catch {
      status('Не удалось сохранить в облако. Проверю соединение и попробую ещё раз.');
    } finally { busy = false; }
  }
  async function pullRemote() {
    if (!session || !ready() || busy) return;
    busy = true;
    try {
      const rows = await request(`/rest/v1/profit_sync?select=payload,updated_at&user_id=eq.${encodeURIComponent(session.user.id)}`, {}, session.access_token);
      const row = Array.isArray(rows) ? rows[0] : null;
      const localSnapshot = window.profitSyncBridge.snapshot();
      const localHasData = hasFinanceData(localSnapshot);
      if (!row) {
        if (localHasData) {
          busy = false;
          await pushRemote(localSnapshot);
        } else {
          status('Подключено. В облаке пока нет записей. Откройте приложение на устройстве с вашими доходами или тратами, чтобы загрузить их.');
        }
        enablePolling();
        return;
      }
      if (row.updated_at && row.updated_at !== lastRemoteUpdatedAt) {
        const remoteHasData = hasFinanceData(row.payload || {});
        const localAt = Number(localStorage.getItem('profitLocalUpdatedAt') || 0);
        const remoteAt = Date.parse(row.updated_at) || 0;
        if (remoteHasData && !localHasData) {
          lastRemoteUpdatedAt = row.updated_at;
          window.profitSyncBridge.applySnapshot(row.payload || {});
          localStorage.setItem('profitLocalUpdatedAt', String(remoteAt));
          status('Данные обновлены из облака.');
        } else if (localHasData && !remoteHasData) {
          busy = false;
          await pushRemote(localSnapshot);
          enablePolling();
          return;
        } else if (remoteAt > localAt + 1200) {
          lastRemoteUpdatedAt = row.updated_at;
          window.profitSyncBridge.applySnapshot(row.payload || {});
          localStorage.setItem('profitLocalUpdatedAt', String(remoteAt));
          status('Данные обновлены из облака.');
        } else if (localAt > remoteAt + 1200) {
          busy = false;
          await pushRemote(localSnapshot);
          enablePolling();
          return;
        }
        lastRemoteUpdatedAt = row.updated_at;
      }
      status('Синхронизация включена. Проверяю изменения каждые 12 секунд.');
      enablePolling();
    } catch {
      status('Пока не удаётся связаться с Supabase. Проверьте настройки проекта и подключение.');
      enablePolling();
    } finally { busy = false; }
  }
  function queueSave(snapshot) {
    if (!session || !ready()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => pushRemote(snapshot), 650);
  }
  async function startSync() {
    const user = await authenticatedUser();
    if (!user) { updateControls(); status('Сохраните настройки Supabase и войдите по ссылке из письма.'); return; }
    session = { ...session, user };
    writeSession(session);
    updateControls();
    status('Подключено. Загружаю данные…');
    await pullRemote();
  }
  async function handleMagicLink() {
    if (!location.hash.includes('access_token=')) return false;
    const hash = new URLSearchParams(location.hash.slice(1));
    const accessToken = hash.get('access_token');
    const refreshToken = hash.get('refresh_token');
    if (!accessToken || !refreshToken) return false;
    const expiresIn = Number(hash.get('expires_in') || 3600);
    writeSession({ access_token: accessToken, refresh_token: refreshToken, expires_at: Math.floor(Date.now() / 1000) + expiresIn });
    history.replaceState(null, '', location.pathname + location.search);
    status('Вход подтверждён. Подключаю облако…');
    await startSync();
    return true;
  }
  async function saveConfig() {
    const urlInput = $('#supabaseUrl'), keyInput = $('#supabaseAnonKey');
    const url = (urlInput?.value || '').trim().replace(/\/$/, '');
    const anon = (keyInput?.value || '').trim();
    try { if (new URL(url).protocol !== 'https:') throw new Error(); } catch { status('Введите корректный HTTPS-адрес проекта Supabase.'); return; }
    if (!anon) { status('Вставьте публичный ключ anon/publishable из настроек проекта.'); return; }
    localStorage.setItem(cfgKeys.url, url);
    localStorage.setItem(cfgKeys.anon, anon);
    writeSession(null);
    updateControls();
    status('Настройки сохранены на этом устройстве. Теперь войдите по ссылке из письма.');
  }
  async function sendMagicLink() {
    if (!ready()) { status('Сначала сохраните адрес проекта и публичный ключ Supabase.'); return; }
    const email = ($('#syncEmail')?.value || '').trim();
    if (!email || !email.includes('@')) { status('Введите вашу почту, чтобы получить ссылку для входа.'); return; }
    status('Отправляю ссылку для входа…');
    try {
      const redirect = encodeURIComponent(location.origin + location.pathname);
      await request(`/auth/v1/otp?redirect_to=${redirect}`, { method: 'POST', body: JSON.stringify({ email, create_user: true }) });
      status('Ссылка отправлена. Откройте письмо на этом устройстве и нажмите её для входа.');
    } catch { status('Не удалось отправить письмо. Проверьте URL, публичный ключ и настройки Auth в Supabase.'); }
  }
  function signOut() {
    clearInterval(pollTimer);
    clearTimeout(saveTimer);
    writeSession(null);
    updateControls();
    status('Синхронизация отключена на этом устройстве. Локальные записи сохранены.');
  }
  document.addEventListener('DOMContentLoaded', async () => {
    const c = config();
    if ($('#supabaseUrl')) $('#supabaseUrl').value = c.url;
    if ($('#supabaseAnonKey')) $('#supabaseAnonKey').value = c.anon;
    $('#saveSupabaseConfig')?.addEventListener('click', saveConfig);
    $('#syncSignIn')?.addEventListener('click', sendMagicLink);
    $('#syncSignOut')?.addEventListener('click', signOut);
    updateControls();
    if (!ready()) { status('Облачное подключение Supabase ещё не настроено. Создайте проект, затем введите его URL и публичный ключ.'); return; }
    if (await handleMagicLink()) return;
    session = readSession();
    if (session) await startSync();
    else status('Supabase настроен. Введите почту и отправьте ссылку для входа.');
  });
  window.addEventListener('focus', () => { if (session) pullRemote(); });
  window.addEventListener('online', () => { if (session) pullRemote(); });
  window.profitCloudSync = { queueSave };
})();
