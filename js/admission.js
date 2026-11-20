/* Билеты премии: без аналитики и контактов гостей. QR обрабатывается на устройстве. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var role = null, canApprove = false, paymentTarget = null, event = null, tickets = [], stream = null, busy = false, scanGeneration = 0;
  var tgApp = window.Telegram && window.Telegram.WebApp;
  if (tgApp && tgApp.initData) { tgApp.ready(); tgApp.expand(); }
  sessionStorage.removeItem('admission-host-key');
  var ticketToken = new URLSearchParams(location.hash.slice(1)).get('t');
  var guestTicket = null, qrImage = null;
  function show(id, visible) { var el = $(id); if (!el) return; el.hidden = !visible; }
  function notice(text) { $('notice').textContent = text || ''; show('notice', !!text); }
  function element(tag, text, className) { var e = document.createElement(tag); if (text) e.textContent = text; if (className) e.className = className; return e; }
  function time(value) { return new Date(value).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  function ticketUrl(token) { return location.origin + '/admission?view=ticket#t=' + token; }
  function ticketPackage(category) {
    var packages = { 'Гость':'Премия', 'Гость + игра':'Премия + игра', 'Гость + подкаст':'Премия + подкаст', 'Гость + игра + подкаст':'Премия + игра + подкаст' };
    return packages[category] || 'Премия · ' + category;
  }
  async function api(path, body) {
    var headers = {};
    var tg = window.Telegram && window.Telegram.WebApp;
    if (tg && tg.initData) headers.authorization = 'tma ' + tg.initData;
    if (new URLSearchParams(location.search).get('viewRole') === 'manager') headers['x-admission-view'] = 'manager';
    if (body !== undefined) headers['content-type'] = 'application/json';
    var response = await fetch('/api/admission/' + path, { method: body === undefined ? 'GET' : 'POST', headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    var data;
    try { data = await response.json(); } catch (_) { throw new Error('Сервер не ответил. Проверь связь и обратись к организатору.'); }
    if (!response.ok) { var err = new Error(data.error || 'Не удалось проверить билет'); err.status = response.status; throw err; }
    return data;
  }
  function setEvent(value) { event = value; show('demo-banner', event.demo); }
  function selectTab(scanner) {
    show('scan-panel', scanner); show('guest-panel', !scanner);
    $('tab-guests').setAttribute('aria-selected', String(!scanner));
    $('tab-scan').setAttribute('aria-selected', String(scanner));
    $('workspace-title').textContent = scanner ? 'Встречаем гостей' : 'Гости и приглашения';
    if (!scanner) stopCamera();
  }
  async function enter() {
    var data = await api('me'); role = data.role; canApprove = !!data.canApprove; setEvent(data.event);
    $('workspace').setAttribute('data-role',canApprove ? 'organizer' : 'manager');
    show('manager-preview',!!data.managerPreview);
    show('login', false); show('workspace', true); show('ticket-view', false);
    show('tab-guests', true); show('show-create', true);
    show('staff-panel', canApprove); show('requests-panel', canApprove);
    $('list-title').textContent = 'Все гости';
    $('list-help').textContent = 'Добавь гостя и сообщи об оплате. Михаил подтвердит её — после этого появится билет для отправки.';
    selectTab(new URLSearchParams(location.search).get('mode') === 'hostess'); notice(''); await refresh();
  }
  async function refresh() {
    var data = await api('tickets'); tickets = data.tickets;
    $('stat-total').textContent = data.stats.total;
    $('stat-admitted').textContent = data.stats.admitted;
    $('stat-expected').textContent = data.stats.expected;
    renderGuests();
    if (canApprove) { await refreshStaff(); await refreshRequests(); }
  }
  async function refreshRequests() {
    var data = await api('requests'), root = $('requests-list'); root.replaceChildren();
    if (!data.requests.length) root.append(element('p', 'Все заявки обработаны', 'muted'));
    data.requests.forEach(function (r) {
      var row = element('article', '', 'guest-row'), info = element('div');
      info.append(element('h3', r.kind === 'access' ? 'Авторизация: ' + r.manager : 'Оплата: ' + r.guest));
      info.append(element('p', r.kind === 'access' ? 'Telegram ID ' + r.telegramId + ' · Сверь аккаунт перед подтверждением.' : ticketPackage(r.category) + ' · ' + (r.amountKopeks/100).toLocaleString('ru-RU') + ' ₽ · ' + r.manager));
      if (r.comment) info.append(element('p',r.comment));
      var buttons = element('div','','row-actions');
      [true,false].forEach(function (approve) { buttons.append(action(approve ? r.kind === 'access' ? 'Да' : 'Оплата прошла' : 'Нет', async function () {
        if (!window.confirm((approve ? 'Подтвердить' : 'Отклонить') + ' заявку ' + (r.guest || r.manager) + '?')) return;
        await api('requests',{id:r.id,approve:approve}); await refresh();
      })); });
      row.append(info,buttons); root.append(row);
    });
  }
  async function refreshStaff() {
    var data = await api('staff'), root = $('staff-list'); root.replaceChildren();
    var pending = data.staff.filter(function (s) { return s.state === 'pending'; }).length;
    $('staff-count').textContent = pending ? '(' + pending + ' ждут подтверждения)' : '';
    if (!data.staff.length) root.append(element('p', 'Заявок пока нет', 'muted'));
    data.staff.forEach(function (s) {
      var row = element('article', '', 'guest-row'), info = element('div');
      info.append(element('h3', s.name), element('p', (s.username ? '@' + s.username + ' · ' : '') + 'Telegram ID ' + s.telegramId), element('p', s.state === 'approved' ? 'Доступ разрешён' : s.state === 'revoked' ? 'Доступ закрыт' : 'Ожидает подтверждения'));
      var buttons = element('div', '', 'row-actions');
      buttons.append(action(s.state === 'approved' ? 'Отозвать доступ' : 'Разрешить доступ', async function () {
        if (!window.confirm((s.state === 'approved' ? 'Закрыть' : 'Разрешить') + ' доступ к проверке билетов для ' + s.name + '?')) return;
        await api('staff', {telegramId:s.telegramId,state:s.state === 'approved' ? 'revoked' : 'approved'}); await refreshStaff();
      }));
      if (s.state === 'pending') buttons.append(action('Отклонить', async function () { await api('staff', {telegramId:s.telegramId,state:'revoked'}); await refreshStaff(); }));
      row.append(info,buttons); root.append(row);
    });
  }
  async function showAccess(request) {
    var data = await api('access', request ? {} : undefined);
    show('login', true); show('telegram-login', false); show('access-panel', true);
    show('request-access', data.state === 'none' || data.state === 'revoked' || data.notificationPending);
    $('request-access').textContent = data.state === 'revoked' ? 'Подать заявку ещё раз' : data.notificationPending ? 'Повторить отправку заявки' : 'Запросить доступ';
    $('access-message').textContent = data.state === 'none' ? 'Запроси доступ. Михаил получит сообщение с кнопками «Да» и «Нет».' : data.state === 'pending' ? data.notificationPending ? 'Заявка сохранена, но уведомление не доставлено. Повтори отправку.' : 'Заявка отправлена Михаилу в Telegram. После подтверждения нажми «Проверить доступ».' : data.state === 'revoked' ? 'Доступ не подтверждён. Можно подать заявку ещё раз.' : 'Доступ подтверждён. Нажми «Проверить доступ».';
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
      info.append(element('h3', t.name), element('p', (t.company || 'Компания не указана') + ' · ' + ticketPackage(t.category)));
      var state = element('div');
      state.append(element('span', t.status === 'cancelled' ? 'Отменён' : t.status === 'pending' ? t.paymentState === 'pending' ? 'Ждём подтверждения оплаты' : 'Ожидает оплаты' : t.checkedInAt ? 'Уже в зале' : 'Оплачен · вход разрешён', 'badge ' + t.status));
      if (t.checkedInAt) state.append(element('p', 'Проход: ' + time(t.checkedInAt) + ' МСК'));
      var buttons = element('div', '', 'row-actions');
      if (t.status === 'active') {
        buttons.append(action('Отправить билет', async function () {
          var shared = await api('share',{id:t.id});
          $('share-message').value = shared.message + '\n\n' + shared.url;
          $('share-telegram').href = 'https://t.me/share/url?url=' + encodeURIComponent(shared.url) + '&text=' + encodeURIComponent(shared.message);
          $('open-shared-ticket').href = shared.url; show('share-panel',true); $('share-panel').scrollIntoView({behavior:'smooth',block:'center'});
        }));
      }
      if (t.status === 'pending' && t.expectedRub && (t.paymentState !== 'pending' || t.notificationPending)) {
        buttons.append(action(t.notificationPending ? 'Повторить отправку оплаты' : 'Сообщить об оплате', async function () {
          paymentTarget = t.id; $('payment-guest').textContent = t.name + ' · ' + ticketPackage(t.category);
          $('payment-amount').value = t.expectedRub; $('payment-amount').min = t.expectedRub; $('payment-comment').value = '';
          show('payment-form',true); $('payment-form').scrollIntoView({behavior:'smooth',block:'center'});
        }));
      }
      if (t.paymentState === 'rejected' && t.status === 'pending') info.append(element('p','Михаил не подтвердил оплату. Уточни поступление и отправь заявку повторно.','muted'));
      if (canApprove && t.status !== 'cancelled') buttons.append(action('Отменить', async function () {
          if (!window.confirm('Отменить билет гостя «' + t.name + '»?')) return;
          await api('status', { id: t.id, status: 'cancelled' }); await refresh();
      }));
      if (t.status === 'active' && !t.checkedInAt) {
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
    if (tgApp && tgApp.initData && tgApp.isVersionAtLeast('6.4')) { try { tgApp.closeScanQrPopup(); } catch (_) {} }
    if (stream) stream.getTracks().forEach(function (track) { track.stop(); });
    stream = null; $('camera').srcObject = null; show('camera-placeholder', true); show('stop-camera', false);
    $('start-camera').disabled = false;
  }
  async function startCamera() {
    stopCamera(); var generation = scanGeneration;
    if (tgApp && tgApp.initData && tgApp.isVersionAtLeast('6.4') && ['android','ios'].includes(tgApp.platform)) {
      try {
        tgApp.showScanQrPopup({text:'Наведи камеру на QR-код приглашения'}, function (raw) {
          if (generation !== scanGeneration || busy) return true;
          var token = parseCode(raw);
          if (!token) { notice('Это не билет премии. Покажи QR-код приглашения.'); return false; }
          checkIn({token:token}); return true;
        }); return;
      } catch (_) { /* В старом клиенте остаётся камера браузера. */ }
    }
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
    $('ticket-category').textContent = ticketPackage(guestTicket.category);
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
    var canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 1640;
    var ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 960, 1640);
    ctx.fillStyle = '#001b7d'; ctx.fillRect(0, 0, 960, 470);
    ctx.fillStyle = '#8af1ac'; ctx.font = 'bold 25px Arial'; ctx.fillText('КОД РОСТА · ТРЁХЛЕТИЕ СООБЩЕСТВА', 60, 55);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 112px Arial'; ctx.fillText('ЖИВОЙ', 60, 180);
    ctx.fillStyle = '#14b9ff'; ctx.fillText('КОД', 60, 285);
    ctx.fillStyle = '#fff'; ctx.font = '32px Arial'; ctx.fillText('Премия «Предприниматель года»', 60, 345);
    ctx.font = 'bold 30px Arial'; ctx.fillText('27 ноября 2026 · Начало в 18:30', 60, 400);
    ctx.font = '28px Arial'; ctx.fillText('ЦУМ · ул. Московская, 2', 60, 444);
    ctx.textAlign = 'center'; ctx.fillStyle = '#536080'; ctx.font = '24px Arial'; ctx.fillText('ТВОЙ БИЛЕТ', 480, 524);
    function fit(text, size, y) { ctx.font = 'bold ' + size + 'px Arial'; while (ctx.measureText(text).width > 840 && size > 15) { size--; ctx.font = 'bold ' + size + 'px Arial'; } ctx.fillText(text, 480, y); }
    ctx.fillStyle = '#8af1ac'; ctx.fillRect(60, 548, 840, 64);
    ctx.fillStyle = '#001b7d'; fit(ticketPackage(guestTicket.category), 34, 590);
    fit(guestTicket.name, 46, 684); fit(guestTicket.company, 28, 734);
    var img = new Image(); img.src = qrImage; await img.decode(); ctx.imageSmoothingEnabled = false; ctx.drawImage(img, 225, 770, 510, 510);
    ctx.font = '26px Arial'; ctx.fillText('Покажи QR-код хостес на входе · Один билет — один гость', 480, 1316);
    ctx.fillStyle = '#edf0f8'; ctx.fillRect(60, 1350, 840, 210);
    ctx.fillStyle = '#001b7d'; ctx.font = 'bold 30px Arial'; ctx.fillText('Дресс-код — коктейльный', 480, 1402);
    ctx.fillStyle = '#536080'; ctx.font = '26px Arial'; ctx.fillText('Вопросы по мероприятию', 480, 1456);
    ctx.fillStyle = '#001b7d'; ctx.font = 'bold 30px Arial'; ctx.fillText('Telegram: @Kodrosta · t.me/Kodrosta', 480, 1508);
    if (event.demo) { ctx.fillStyle = '#ff3624'; ctx.font = 'bold 28px Arial'; ctx.fillText('ТЕСТОВЫЙ БИЛЕТ · НЕ ДЛЯ ВХОДА НА ПРЕМИЮ', 480, 1610); }
    var a = document.createElement('a'); a.download = 'Priglashenie-' + guestTicket.id + '.png'; a.href = canvas.toDataURL('image/png'); a.click();
  }
  $('tab-guests').onclick = function () { selectTab(false); }; $('tab-scan').onclick = function () { selectTab(true); };
  $('search').oninput = renderGuests; $('start-camera').onclick = startCamera; $('stop-camera').onclick = stopCamera;
  $('refresh-guests').onclick = function () { refresh().catch(function(err){notice(err.message);}); };
  $('payment-form').onsubmit = async function(ev) {
    ev.preventDefault(); var button = this.querySelector('button'); button.disabled = true;
    try { await api('payment-request',{id:paymentTarget,amountRub:Number($('payment-amount').value),comment:$('payment-comment').value}); show('payment-form',false); await refresh(); notice('Заявка на подтверждение оплаты отправлена Михаилу в Telegram.'); }
    catch(err) { notice(err.message); await refresh().catch(function(){}); } finally { button.disabled = false; }
  };
  $('cancel-payment').onclick = function(){show('payment-form',false);};
  $('close-share').onclick = function(){show('share-panel',false);};
  $('copy-invitation').onclick = async function(){try{await navigator.clipboard.writeText($('share-message').value);notice('Приглашение скопировано. Отправь его гостю.');}catch(_){$('share-message').select();notice('Скопируй выделенное приглашение.');}};
  $('refresh-staff').onclick = function () { refreshStaff().catch(function (err) { notice(err.message); }); };
  $('request-access').onclick = async function () { this.disabled = true; try { await showAccess(true); } catch (err) { notice(err.message); } finally { this.disabled = false; } };
  $('retry-access').onclick = async function () { this.disabled = true; try { await enter(); } catch (err) { if (err.status === 401 || err.status === 403) await showAccess(false).catch(function (e) { notice(e.message); }); else notice(err.message); } finally { this.disabled = false; } };
  $('show-create').onclick = function () { show('create-form', $('create-form').hidden); };
  $('create-form').onsubmit = async function (ev) {
    ev.preventDefault(); var b = this.querySelector('button'); b.disabled = true;
    try { await api('create', Object.fromEntries(new FormData(this))); this.reset(); show('create-form', false); await refresh(); notice('Гость добавлен. Когда поступят деньги, нажми у гостя «Сообщить об оплате».'); }
    catch (err) { notice(err.message); } finally { b.disabled = false; }
  };
  $('manual-code').onsubmit = function (ev) { ev.preventDefault(); var token = parseCode($('scan-code').value); if (!token) { decision('red', 'Это не билет премии'); return; } checkIn({ token: token }); };
  $('logout').onclick = async function () { stopCamera(); if (tgApp && tgApp.initData) { tgApp.close(); return; } await fetch('/api/admission-demo/logout', { method: 'POST' }).catch(function () {}); location.href = '/admission'; };
  $('save-ticket').onclick = function () { saveTicket().catch(function () { notice('Не получилось сохранить картинку. Сделай скриншот приглашения.'); }); };
  ['admin', 'host'].forEach(function (which) { var el = $('demo-' + which); if (!el) return; el.onclick = async function () { try { var response = await fetch('/api/admission-demo/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: which }) }); if (!response.ok) throw new Error('Не удалось открыть тестовую роль'); await enter(); } catch (err) { notice(err.message); } }; });
  document.addEventListener('visibilitychange', function () { if (document.hidden) stopCamera(); });
  window.addEventListener('pagehide', stopCamera);
  (async function () {
    try {
      if (ticketToken) { await renderTicket(); return; }
      try { await enter(); return; } catch (err) {
        if (tgApp && tgApp.initData) { if (err.status === 401 || err.status === 403) await showAccess(false); else { show('login',true); notice(err.message); } return; }
      }
      show('login', true);
      try { var demo = await fetch('/api/admission-demo/info', { cache: 'no-store' }); if (demo.ok && (await demo.json()).demo) { show('demo-login', true); show('demo-banner', true); show('telegram-login', false); } } catch (_) {}
    } catch (err) { notice(err.message); }
  })();
  setInterval(function () { if (role && !document.hidden) refresh().catch(function (err) { if (err.status === 401 || err.status === 403) { role = null; stopCamera(); show('workspace',false); show('login',true); showAccess(false).catch(function (e) { notice(e.message); }); } else notice('Нет связи с базой. Новые проходы нужно проверять после восстановления связи.'); }); }, 5000);
})();
