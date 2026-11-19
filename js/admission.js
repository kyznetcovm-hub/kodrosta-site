/* Билеты премии: без аналитики и контактов гостей. QR обрабатывается на устройстве. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var role = null, event = null, tickets = [], stream = null, busy = false, scanGeneration = 0;
  var hostKey = sessionStorage.getItem('admission-host-key') || '';
  var ticketToken = new URLSearchParams(location.hash.slice(1)).get('t');
  var guestTicket = null, qrImage = null;
  function show(id, visible) { $(id).hidden = !visible; }
  function notice(text) { $('notice').textContent = text || ''; show('notice', !!text); }
  function element(tag, text, className) { var e = document.createElement(tag); if (text) e.textContent = text; if (className) e.className = className; return e; }
  function time(value) { return new Date(value).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  function ticketUrl(token) { return location.origin + '/admission?view=ticket#t=' + token; }
  async function api(path, body) {
    var headers = {};
    if (hostKey) headers['x-admission-key'] = hostKey;
    var tg = window.Telegram && window.Telegram.WebApp;
    if (tg && tg.initData) headers.authorization = 'tma ' + tg.initData;
    if (body !== undefined) headers['content-type'] = 'application/json';
    var response = await fetch('/api/admission/' + path, { method: body === undefined ? 'GET' : 'POST', headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    var data;
    try { data = await response.json(); } catch (_) { throw new Error('Сервер не ответил. Проверь связь и обратись к организатору.'); }
    if (!response.ok) throw new Error(data.error || 'Не удалось проверить билет');
    return data;
  }
  function setEvent(value) { event = value; show('demo-banner', event.demo); }
  function selectTab(scanner) {
    show('scan-panel', scanner); show('guest-panel', !scanner || role === 'host');
    $('tab-guests').setAttribute('aria-selected', String(!scanner));
    $('tab-scan').setAttribute('aria-selected', String(scanner));
    $('workspace-title').textContent = scanner ? 'Встречаем гостей' : 'Гости и приглашения';
    if (!scanner) stopCamera();
  }
  async function enter() {
    var data = await api('me'); role = data.role; setEvent(data.event);
    show('login', false); show('workspace', true); show('ticket-view', false);
    show('tab-guests', role === 'admin'); show('show-create', role === 'admin');
    show('sheet-sync', role === 'admin');
    $('sync-help').textContent = data.syncSource + '. Изменения оплат применяются после обновления списка.';
    $('sync-payments').textContent = data.syncSource.indexOf('Тестовый снимок') === 0 ? 'Загрузить тестовый снимок' : 'Обновить из таблицы';
    $('list-title').textContent = role === 'host' ? 'Поиск без QR-кода' : 'Список гостей';
    $('list-help').textContent = role === 'host' ? 'Сверь имя гостя перед ручной регистрацией прохода.' : 'Приглашение становится действительным после подтверждения участия.';
    selectTab(role === 'host'); notice(''); await refresh();
  }
  async function refresh() {
    var data = await api('tickets'); tickets = data.tickets;
    $('stat-total').textContent = data.stats.total;
    $('stat-admitted').textContent = data.stats.admitted;
    $('stat-expected').textContent = data.stats.expected;
    renderGuests();
  }
  function action(label, handler, className) {
    var b = element('button', label, className || 'outline'); b.type = 'button';
    b.onclick = async function () { b.disabled = true; try { notice(''); await handler(); } catch (err) { notice(err.message); } finally { b.disabled = false; } }; return b;
  }
  function renderGuests() {
    var query = $('search').value.trim().toLocaleLowerCase('ru');
    var filtered = tickets.filter(function (t) { return (t.name + ' ' + t.company).toLocaleLowerCase('ru').includes(query); });
    var root = $('guest-list'); root.replaceChildren();
    if (!filtered.length) { root.append(element('p', 'Гости не найдены', 'empty')); return; }
    filtered.forEach(function (t) {
      var row = element('article', '', 'guest-row'), info = element('div');
      info.append(element('h3', t.name), element('p', (t.company || 'Компания не указана') + ' · ' + t.category));
      var state = element('div');
      state.append(element('span', t.status === 'cancelled' ? 'Отменён' : t.status === 'pending' ? 'Ожидает подтверждения' : t.checkedInAt ? 'Уже в зале' : 'Вход разрешён', 'badge ' + t.status));
      if (t.checkedInAt) state.append(element('p', 'Проход: ' + time(t.checkedInAt) + ' МСК'));
      var buttons = element('div', '', 'row-actions');
      if (role === 'admin') {
        var link = element('a', 'Билет'); link.href = ticketUrl(t.token); link.target = '_blank'; link.rel = 'noopener noreferrer'; buttons.append(link);
        buttons.append(action('Скопировать ссылку', async function () {
          try { await navigator.clipboard.writeText(ticketUrl(t.token)); notice('Ссылка на приглашение скопирована.'); }
          catch (_) { notice('Открой билет и скопируй адрес из адресной строки.'); }
        }));
        if (t.sourceId) info.append(element('p', t.sourceId + ' · Оплата из таблицы', 'muted'));
        if (!t.sourceId && t.status !== 'active') buttons.append(action('Подтвердить', async function () { await api('status', { id: t.id, status: 'active' }); await refresh(); }));
        if (!t.sourceId && t.status !== 'cancelled') buttons.append(action('Отменить', async function () {
          if (!window.confirm('Отменить билет гостя «' + t.name + '»?')) return;
          await api('status', { id: t.id, status: 'cancelled' }); await refresh();
        }));
      } else {
        buttons.append(action('Зарегистрировать', async function () {
          if (!window.confirm('Гость «' + t.name + '» перед тобой? Зарегистрировать проход?')) return;
          await checkIn({ id: t.id }); $('decision').scrollIntoView({ behavior: 'smooth', block: 'center' });
        }));
      }
      row.append(info, state, buttons); root.append(row);
    });
  }
  function decision(color, title, t) {
    var root = $('decision'); root.className = 'decision ' + color; root.replaceChildren();
    root.append(element('span', color === 'green' ? '✓' : color === 'red' ? '×' : '!', 'decision-symbol'), element('h2', title));
    if (t) {
      root.append(element('p', t.name), element('p', [t.company, t.category].filter(Boolean).join(' · ')));
      if (t.checkedInAt) root.append(element('p', 'Вход: ' + time(t.checkedInAt) + ' МСК'));
    }
    if (color === 'yellow') root.append(element('p', 'Проход не подтверждён. Обратись к организатору; при восстановлении связи проверь билет снова.'));
  }
  async function checkIn(payload) {
    if (busy) return; busy = true; stopCamera();
    decision('neutral', 'Проверяем по базе…');
    try {
      var result = await api('check-in', payload);
      decision(result.decision, result.reason, result.ticket);
      // Ошибка обновления счётчика не меняет уже подтверждённый результат прохода.
      try { await refresh(); } catch (_) { notice('Результат прохода сохранён. Счётчик обновится после восстановления связи.'); }
    } catch (err) { decision('yellow', err.message); }
    finally { busy = false; $('start-camera').textContent = 'Следующий гость'; }
  }
  function parseCode(raw) {
    var text = String(raw || '').trim();
    if (/^[a-f0-9]{64}$/.test(text)) return text;
    try {
      var u = new URL(text);
      if (![location.origin, 'https://codrosta.club'].includes(u.origin) || !/^\/admission(?:\.html)?$/.test(u.pathname)) return null;
      var token = new URLSearchParams(u.hash.slice(1)).get('t'); return /^[a-f0-9]{64}$/.test(token || '') ? token : null;
    } catch (_) { return null; }
  }
  function stopCamera() {
    scanGeneration++;
    if (stream) stream.getTracks().forEach(function (track) { track.stop(); });
    stream = null; $('camera').srcObject = null; show('camera-placeholder', true); show('stop-camera', false);
    $('start-camera').disabled = false;
  }
  async function startCamera() {
    stopCamera(); var generation = scanGeneration;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { notice('Камера недоступна. Открой страницу по HTTPS или найди гостя по имени.'); return; }
    var detector = null;
    if (window.BarcodeDetector) { try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch (_) {} }
    if (!detector && !window.jsQR) { notice('Сканер ещё не загрузился. Проверь интернет или воспользуйся поиском по имени.'); return; }
    $('start-camera').disabled = true;
    try {
      var acquired = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      if (generation !== scanGeneration) { acquired.getTracks().forEach(function (t) { t.stop(); }); return; }
      stream = acquired; $('camera').srcObject = stream; await $('camera').play();
      show('camera-placeholder', false); show('stop-camera', true); notice('');
      $('camera-hint').textContent = 'Наведи камеру на QR. Успешная проверка сразу зарегистрирует проход.';
      var canvas = document.createElement('canvas'), context = canvas.getContext('2d', { willReadFrequently: true });
      async function frame() {
        if (!stream || generation !== scanGeneration) return;
        try {
          var raw = null, video = $('camera');
          if (video.readyState >= 2 && video.videoWidth) {
            if (detector) { var codes = await detector.detect(video); if (codes.length) raw = codes[0].rawValue; }
            else {
              canvas.width = Math.min(video.videoWidth, 800); canvas.height = Math.round(video.videoHeight * canvas.width / video.videoWidth);
              context.drawImage(video, 0, 0, canvas.width, canvas.height);
              var pixels = context.getImageData(0, 0, canvas.width, canvas.height);
              var code = window.jsQR(pixels.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
              if (code) raw = code.data;
            }
          }
          if (generation !== scanGeneration) return;
          if (raw) {
            var token = parseCode(raw);
            if (token) { await checkIn({ token: token }); return; }
            $('camera-hint').textContent = 'Это не билет премии. Покажи персональный QR-код приглашения.';
          }
        } catch (_) {
          // Если встроенный детектор не работает, используем общий декодер.
          if (detector && window.jsQR) detector = null;
          else { stopCamera(); notice('Камера не смогла прочитать код. Найди гостя по имени.'); return; }
        }
        if (generation === scanGeneration) setTimeout(frame, 160);
      }
      frame();
    } catch (_) { stopCamera(); notice('Не удалось открыть камеру. Разреши доступ в настройках браузера или найди гостя по имени.'); }
  }
  async function renderTicket() {
    show('login', false); show('workspace', false); show('ticket-view', false);
    var data = await api('ticket', { token: ticketToken }); setEvent(data.event); guestTicket = data.ticket;
    $('ticket-name').textContent = guestTicket.name; $('ticket-company').textContent = guestTicket.company;
    $('ticket-category').textContent = guestTicket.category;
    $('ticket-state').textContent = guestTicket.status === 'cancelled' ? 'Билет отменён. Свяжись с организатором.' : guestTicket.status === 'pending'
      ? 'Участие ожидает подтверждения организатором.' : guestTicket.checkedInAt ? 'По этому билету уже зарегистрирован вход.' : 'Персональное приглашение';
    show('ticket-view', true);
    if (!window.qrcode) { $('ticket-qr').textContent = 'Не удалось загрузить QR-код. Проверь интернет и обнови страницу.'; $('save-ticket').disabled = true; return; }
    var qr = window.qrcode(0, 'M'); qr.addData(ticketUrl(ticketToken)); qr.make();
    qrImage = qr.createDataURL(6, 24);
    var image = document.createElement('img'); image.src = qrImage; image.alt = 'Персональный QR-код приглашения'; $('ticket-qr').replaceChildren(image);
  }
  async function saveTicket() {
    if (!qrImage || !guestTicket) return;
    var canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 1440;
    var ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 960, 1440);
    ctx.fillStyle = '#001b7d'; ctx.fillRect(0, 0, 960, 520);
    ctx.fillStyle = '#8af1ac'; ctx.font = 'bold 25px Arial'; ctx.fillText('КОД РОСТА · ТРЁХЛЕТИЕ СООБЩЕСТВА', 60, 65);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 128px Arial'; ctx.fillText('ЖИВОЙ', 60, 210);
    ctx.fillStyle = '#14b9ff'; ctx.fillText('КОД', 60, 330);
    ctx.fillStyle = '#fff'; ctx.font = '32px Arial'; ctx.fillText('Премия «Предприниматель года»', 60, 400);
    ctx.font = '26px Arial'; ctx.fillText('27 ноября 2026 · Казань · ЦУМ', 60, 460);
    ctx.textAlign = 'center'; ctx.fillStyle = '#001b7d'; ctx.font = 'bold 28px Arial'; ctx.fillText(guestTicket.category, 480, 575);
    function fit(text, size, y) { ctx.font = 'bold ' + size + 'px Arial'; while (ctx.measureText(text).width > 840 && size > 15) { size--; ctx.font = 'bold ' + size + 'px Arial'; } ctx.fillText(text, 480, y); }
    fit(guestTicket.name, 46, 655); fit(guestTicket.company, 28, 710);
    var img = new Image(); img.src = qrImage; await img.decode(); ctx.imageSmoothingEnabled = false; ctx.drawImage(img, 225, 760, 510, 510);
    ctx.font = '26px Arial'; ctx.fillText('Покажи QR-код хостес на входе', 480, 1310);
    if (event.demo) { ctx.fillStyle = '#ff3624'; ctx.font = 'bold 28px Arial'; ctx.fillText('ТЕСТОВЫЙ БИЛЕТ · НЕ ДЛЯ ВХОДА НА ПРЕМИЮ', 480, 1385); }
    var a = document.createElement('a'); a.download = 'Priglashenie-' + guestTicket.id + '.png'; a.href = canvas.toDataURL('image/png'); a.click();
  }
  $('tab-guests').onclick = function () { selectTab(false); }; $('tab-scan').onclick = function () { selectTab(true); };
  $('search').oninput = renderGuests; $('start-camera').onclick = startCamera; $('stop-camera').onclick = stopCamera;
  $('sync-payments').onclick = async function () {
    var button = this; button.disabled = true;
    try {
      var result = await api('sync', {}), r = result.report;
      await refresh();
      notice(r.source + '. Новых билетов: ' + r.created + '. Готовы к входу: ' + r.eligible + '. Ожидают оплаты или уточнения: ' + r.waiting + '.'
        + (r.revoked ? ' Приостановлено билетов: ' + r.revoked + '.' : '')
        + (r.issues.length ? ' ' + r.issues.slice(0,5).map(function (x) { return x.id + ': ' + x.reason; }).join('; ') : ''));
    } catch (err) { notice(err.message); } finally { button.disabled = false; }
  };
  $('show-create').onclick = function () { show('create-form', $('create-form').hidden); };
  $('create-form').onsubmit = async function (ev) {
    ev.preventDefault(); var b = this.querySelector('button'); b.disabled = true;
    try { await api('create', Object.fromEntries(new FormData(this))); this.reset(); show('create-form', false); await refresh(); notice('Гость добавлен. Подтверди участие, чтобы разрешить вход.'); }
    catch (err) { notice(err.message); } finally { b.disabled = false; }
  };
  $('manual-code').onsubmit = function (ev) { ev.preventDefault(); var token = parseCode($('scan-code').value); if (!token) { decision('red', 'Это не билет премии'); return; } checkIn({ token: token }); };
  $('host-login').onsubmit = async function (ev) { ev.preventDefault(); hostKey = $('host-key').value.trim(); try { await enter(); sessionStorage.setItem('admission-host-key', hostKey); $('host-key').value = ''; } catch (err) { hostKey = ''; notice(err.message); } };
  $('logout').onclick = async function () { stopCamera(); hostKey = ''; sessionStorage.removeItem('admission-host-key'); await fetch('/api/admission-demo/logout', { method: 'POST' }).catch(function () {}); location.href = '/admission'; };
  $('save-ticket').onclick = function () { saveTicket().catch(function () { notice('Не получилось сохранить картинку. Сделай скриншот приглашения.'); }); };
  ['admin', 'host'].forEach(function (which) { $('demo-' + which).onclick = async function () { try { var response = await fetch('/api/admission-demo/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: which }) }); if (!response.ok) throw new Error('Не удалось открыть тестовую роль'); await enter(); } catch (err) { notice(err.message); } }; });
  document.addEventListener('visibilitychange', function () { if (document.hidden) stopCamera(); });
  window.addEventListener('pagehide', stopCamera);
  (async function () {
    try {
      if (ticketToken) { await renderTicket(); return; }
      try { await enter(); return; } catch (_) {}
      show('login', true);
      try { var demo = await fetch('/api/admission-demo/info', { cache: 'no-store' }); if (demo.ok && (await demo.json()).demo) { show('demo-login', true); show('demo-banner', true); show('host-login', false); show('admin-hint', false); } } catch (_) {}
    } catch (err) { notice(err.message); }
  })();
  setInterval(function () { if (role && !document.hidden) refresh().catch(function () { notice('Нет связи с базой. Новые проходы нужно проверять после восстановления связи.'); }); }, 15000);
})();
