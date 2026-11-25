(() => {
  const cfgKeys = { url: 'profitSupabaseUrl', anon: 'profitSupabaseAnonKey' };
  // Supabase URL and publishable key are public client-side values; data access
  // is protected by RLS and by the signed-in user's token. Baked in so sign-in
  // works on any device without copying settings from the computer.
  const DEFAULT_URL = 'https://qsqwjpcfluxtlbmmojkv.supabase.co';
  const DEFAULT_ANON = 'sb_publishable_lB_oSwd4Q_W1dAOJU1QnNQ_Pmf4vTyr';
  const sessionKey = 'profitSupabaseSession';
  const lastSyncedKey = 'profitLastSyncedAt';
  const dirtyKey = 'profitLocalDirty';
  let session = null;
  let lastRemoteUpdatedAt = '';
  let saveTimer = 0;
  let pollTimer = 0;
  let busy = false;
  let pendingPush = false;
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
  // On the first sign-in an account can already have data in the cloud while
  // this device has its own records. Unite them by id instead of letting one
  // side overwrite the other — that is what used to erase entries.
  const mergeById = (local, remote) => {
    const byId = new Map();
    (Array.isArray(remote) ? remote : []).forEach(x => { if (x && x.id) byId.set(x.id, x); });
    (Array.isArray(local) ? local : []).forEach(x => { if (x && x.id && !byId.has(x.id)) byId.set(x.id, x); });
    return [...byId.values()];
  };
  const mergeSnapshots = (local, remote) => ({
    entries: mergeById(local?.entries, remote?.entries),
    recurring: mergeById(local?.recurring, remote?.recurring),
    expenses: mergeById(local?.expenses, remote?.expenses),
    paymentReminders: mergeById(local?.paymentReminders, remote?.paymentReminders),
    budgets: { ...(remote?.budgets || {}), ...(local?.budgets || {}) },
    autoSavePercent: Number(local?.autoSavePercent) || Number(remote?.autoSavePercent) || 0,
    savings: Math.max(Number(local?.savings) || 0, Number(remote?.savings) || 0),
    goal: Number(local?.goal) || Number(remote?.goal) || 50000
  });
  const config = () => ({
    url: (localStorage.getItem(cfgKeys.url) || DEFAULT_URL).replace(/\/$/, ''),
    anon: localStorage.getItem(cfgKeys.anon) || DEFAULT_ANON
  });
  const ready = () => { const c = config(); return /^https:\/\//i.test(c.url) && Boolean(c.anon); };
  const readSession = () => { try { return JSON.parse(localStorage.getItem(sessionKey) || 'null'); } catch { return null; } };
  const writeSession = value => {
    session = value;
    if (value) localStorage.setItem(sessionKey, JSON.stringify(value));
    else localStorage.removeItem(sessionKey);
  };
  // Publishable keys are API keys, not JWTs. Send them only as `apikey`;
  // Authorization is reserved for the user's access token after sign-in.
  const headers = token => ({
    apikey: config().anon,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'Content-Type': 'application/json'
  });
  async function request(path, options = {}, token) {
    const response = await fetch(config().url + path, { ...options, headers: { ...headers(token), ...(options.headers || {}) } });
    if (!response.ok) {
      let detail = '';
      try {
        const body = await response.json();
        detail = body.msg || body.message || body.error_description || body.error || '';
      } catch {}
      const error = new Error(detail || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
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
    if (Number(session.expires_at || 0) < Math.floor(Date.now() / 1000) + 60 && !(await refreshSession())) { writeSession(null); updateControls(); return null; }
    try { return await request('/auth/v1/user', {}, session.access_token); }
    catch { if (await refreshSession()) return request('/auth/v1/user', {}, session.access_token); writeSession(null); updateControls(); return null; }
  }
  function updateControls() {
    const s = readSession();
    const signOut = $('#welcomeSignOut');
    if (signOut) signOut.hidden = !s?.access_token;
    const account = $('#welcomeAccount');
    if (account) {
      account.hidden = !s?.user?.email;
      account.textContent = s?.user?.email ? 'Вы вошли как ' + s.user.email : '';
    }
    window.dispatchEvent(new Event('profit-session-changed'));
  }
  function notifySignedIn() {
    window.dispatchEvent(new Event('profit-auth-success'));
    try { window.profitCloudSync?.onSignedIn?.(); } catch {}
  }
  function enablePolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (document.visibilityState === 'visible') pullRemote(); }, 12000);
  }
  async function pushRemote(snapshot) {
    if (!session || !ready()) return;
    if (busy) { pendingPush = true; return; }
    busy = true;
    try {
      const result = await request('/rest/v1/profit_sync?on_conflict=user_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({ user_id: session.user.id, payload: snapshot || window.profitSyncBridge.snapshot() })
      }, session.access_token);
      // Use the timestamp returned by the server, never the device clock:
      // clocks on phones and computers differ, and comparing them made
      // updates on one device invisible on the other.
      const serverAt = Array.isArray(result) ? result[0]?.updated_at : result?.updated_at;
      if (serverAt) {
        lastRemoteUpdatedAt = serverAt;
        localStorage.setItem(lastSyncedKey, serverAt);
      }
      localStorage.setItem('profitLocalUpdatedAt', String(Date.now()));
      localStorage.setItem(dirtyKey, '0');
      status('Синхронизировано. Изменения появятся на других устройствах в течение нескольких секунд.');
    } catch (error) {
      status(error?.status === 403
        ? 'Нет прав на запись в облако: выполните SUPABASE-SETUP.sql в SQL Editor Supabase.'
        : 'Не удалось сохранить в облако. Проверю соединение и попробую ещё раз.');
    } finally {
      busy = false;
      if (pendingPush) { pendingPush = false; setTimeout(() => pushRemote(), 80); }
    }
  }
  async function pullRemote() {
    if (!session || !ready()) return;
    if (busy) { pendingPush = true; return; }
    busy = true;
    try {
      const rows = await request(`/rest/v1/profit_sync?select=payload,updated_at&user_id=eq.${encodeURIComponent(session.user.id)}`, {}, session.access_token);
      const row = Array.isArray(rows) ? rows[0] : null;
      const localSnapshot = window.profitSyncBridge.snapshot();
      const localHasData = hasFinanceData(localSnapshot);
      const lastSynced = localStorage.getItem(lastSyncedKey) || '';
      if (!row) {
        if (localHasData) { busy = false; await pushRemote(localSnapshot); }
        else status('Подключено. В облаке пока нет записей. Добавьте доход или трату — они появятся на всех устройствах.');
        enablePolling();
        return;
      }
      const remoteUpdatedAt = row.updated_at || '';
      const remoteHasData = hasFinanceData(row.payload || {});
      if (!lastSynced && localHasData && remoteHasData) {
        const merged = mergeSnapshots(localSnapshot, row.payload || {});
        window.profitSyncBridge.applySnapshot(merged);
        localStorage.setItem(lastSyncedKey, remoteUpdatedAt || new Date().toISOString());
        localStorage.setItem(dirtyKey, '0');
        busy = false;
        await pushRemote(merged);
        status('Данные с двух устройств объединены и сохранены в облаке.');
        enablePolling();
        return;
      }
      if (localStorage.getItem(dirtyKey) === '1') {
        busy = false;
        await pushRemote(localSnapshot);
        enablePolling();
        return;
      }
      if (localHasData && !remoteHasData) {
        busy = false;
        await pushRemote(localSnapshot);
        enablePolling();
        return;
      }
      if (remoteUpdatedAt && remoteUpdatedAt !== lastSynced) {
        if (remoteHasData || !localHasData) {
          window.profitSyncBridge.applySnapshot(row.payload || {});
          status('Данные обновлены из облака.');
        }
        localStorage.setItem(lastSyncedKey, remoteUpdatedAt);
        localStorage.setItem('profitLocalUpdatedAt', String(Date.parse(remoteUpdatedAt) || Date.now()));
      }
      lastRemoteUpdatedAt = remoteUpdatedAt;
      status('Синхронизация включена. Проверяю изменения каждые 12 секунд.');
      enablePolling();
    } catch (error) {
      status(error?.status === 403
        ? 'Нет доступа к облаку: откройте Supabase → SQL Editor и выполните SUPABASE-SETUP.sql.'
        : 'Пока не удаётся связаться с Supabase. Проверьте подключение и настройки.');
      enablePolling();
    } finally {
      busy = false;
      if (pendingPush) { pendingPush = false; setTimeout(() => pushRemote(), 80); }
    }
  }
  function queueSave(snapshot) {
    if (!session || !ready()) return;
    localStorage.setItem(dirtyKey, '1');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => pushRemote(snapshot), 650);
  }
  async function startSync() {
    const user = await authenticatedUser();
    if (!user) { updateControls(); status('Войдите по почте и паролю, чтобы открыть свои данные.'); return; }
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
    const recovery = hash.get('type') === 'recovery';
    const expiresIn = Number(hash.get('expires_in') || 3600);
    writeSession({ access_token: accessToken, refresh_token: refreshToken, expires_at: Math.floor(Date.now() / 1000) + expiresIn });
    history.replaceState(null, '', location.pathname + location.search);
    status(recovery ? 'Ссылка подтверждена. Задайте новый пароль.' : 'Вход подтверждён. Подключаю облако…');
    await startSync();
    if (recovery) $('#passwordModal')?.classList.add('open');
    else notifySignedIn();
    return true;
  }
  function saveConfig() {
    const urlInput = $('#supabaseUrl'), keyInput = $('#supabaseAnonKey');
    const url = (urlInput?.value || '').trim().replace(/\/$/, '');
    const anon = (keyInput?.value || '').trim();
    try { if (new URL(url).protocol !== 'https:') throw new Error(); } catch { status('Введите корректный HTTPS-адрес проекта Supabase.'); return; }
    if (!anon) { status('Вставьте публичный ключ anon/publishable из настроек проекта.'); return; }
    localStorage.setItem(cfgKeys.url, url);
    localStorage.setItem(cfgKeys.anon, anon);
    localStorage.removeItem(lastSyncedKey);
    writeSession(null);
    updateControls();
    status('Настройки сохранены на этом устройстве. Теперь войдите по почте и паролю.');
  }
  async function passwordAuth(signUp) {
    if (!ready()) { status('Сначала сохраните адрес проекта Supabase и публичный ключ в настройках подключения.'); return; }
    const email = ($('#syncEmail')?.value || '').trim();
    const password = $('#syncPassword')?.value || '';
    if (!email || !email.includes('@')) { status('Введите корректный e-mail.'); return; }
    if (password.length < 8) { status('Введите пароль длиной не менее 8 символов.'); return; }
    status(signUp ? 'Создаю аккаунт…' : 'Выполняю вход…');
    try {
      const body = await request(signUp ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password', {
        method: 'POST', body: JSON.stringify({ email, password })
      });
      $('#syncPassword').value = '';
      if (body?.access_token && body?.refresh_token) {
        writeSession({ ...body, expires_at: Math.floor(Date.now() / 1000) + Number(body.expires_in || 3600) });
        updateControls();
        status('Вход выполнен. Подключаю данные…');
        await startSync();
        notifySignedIn();
      } else if (signUp) {
        status('Аккаунт создан. Подтвердите e-mail по ссылке из письма, затем войдите с паролем.');
      } else {
        status('Аккаунт создан без сессии. Проверьте подтверждение e-mail или повторите вход.');
      }
    } catch (error) {
      $('#syncPassword').value = '';
      status(`Не удалось ${signUp ? 'создать аккаунт' : 'войти'} (${error?.status || 'сетевая ошибка'}): ${error?.message || 'ошибка Supabase'}`);
    }
  }
  async function recoverPassword() {
    if (!ready()) { status('Подключение к Supabase ещё не настроено.'); return; }
    const email = ($('#syncEmail')?.value || '').trim();
    if (!email || !email.includes('@')) { status('Введите почту, на которую придёт ссылка для смены пароля.'); return; }
    status('Отправляю ссылку для смены пароля…');
    try {
      const redirect = encodeURIComponent(location.origin + location.pathname);
      await request(`/auth/v1/recover?redirect_to=${redirect}`, { method: 'POST', body: JSON.stringify({ email }) });
      status('Ссылка отправлена. Откройте её в почте и задайте новый пароль.');
    } catch (error) {
      status(`Не удалось отправить ссылку (${error?.status || 'сетевая ошибка'}): ${error?.message || 'ошибка Supabase'}`);
    }
  }
  async function saveNewPassword() {
    const password = ($('#newPassword')?.value || '').trim();
    if (password.length < 8) { status('Введите пароль длиной не менее 8 символов.'); return; }
    status('Сохраняю новый пароль…');
    try {
      await request('/auth/v1/user', { method: 'PUT', body: JSON.stringify({ password }) }, session.access_token);
      $('#passwordModal')?.classList.remove('open');
      $('#newPassword').value = '';
      notifySignedIn();
      status('Пароль обновлён. Теперь можно входить с ним на всех устройствах.');
    } catch (error) {
      status(`Не удалось сменить пароль (${error?.status || 'сетевая ошибка'}): ${error?.message || 'ошибка Supabase'}`);
    }
  }
  function signOut() {
    clearInterval(pollTimer);
    clearTimeout(saveTimer);
    localStorage.removeItem(lastSyncedKey);
    writeSession(null);
    updateControls();
    status('Вы вышли из аккаунта. Локальные записи на этом устройстве сохранены.');
  }
  document.addEventListener('DOMContentLoaded', async () => {
    const c = config();
    if ($('#supabaseUrl')) $('#supabaseUrl').value = c.url;
    if ($('#supabaseAnonKey')) $('#supabaseAnonKey').value = c.anon;
    $('#saveSupabaseConfig')?.addEventListener('click', saveConfig);
    $('#welcomeRecover')?.addEventListener('click', recoverPassword);
    $('#saveNewPassword')?.addEventListener('click', saveNewPassword);
    $('#cancelPassword')?.addEventListener('click', () => $('#passwordModal')?.classList.remove('open'));
    updateControls();
    if (!ready()) {
      status('Чтобы входить на всех устройствах, откройте «Настройки подключения» и укажите адрес проекта Supabase и публичный ключ.');
      window.dispatchEvent(new Event('profit-auth-checked'));
      return;
    }
    if (await handleMagicLink()) { window.dispatchEvent(new Event('profit-auth-checked')); return; }
    session = readSession();
    if (session) await startSync();
    else status('Введите почту и пароль, чтобы открыть свои данные.');
    // Tells the welcome screen that the saved session was validated, so it can
    // enter the app automatically without asking for credentials again.
    window.dispatchEvent(new Event('profit-auth-checked'));
  });
  window.addEventListener('focus', () => { if (session) pullRemote(); });
  window.addEventListener('online', () => { if (session) pullRemote(); });
  window.profitCloudSync = {
    queueSave,
    refresh: pullRemote,
    signOut,
    passwordSignIn: passwordAuth,
    isSignedIn: () => Boolean(readSession()?.access_token),
    onSignedIn: null
  };
})();
