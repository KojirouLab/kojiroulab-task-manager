// 社員一覧。ログイン後にDB(employees テーブル)から読み込む。
// メンバーの追加・改名・管理者の変更は Supabase 側で行う(SETUP.md 参照)。
let EMPLOYEES = [];

const STATUS_CLASS = {
  未確認: 'status-todo',
  確認済み: 'status-progress',
  完了: 'status-done',
};

const app = document.getElementById('app');

function findEmployee(slug) {
  return EMPLOYEES.find((e) => e.slug === slug) || null;
}

function employeeName(slug) {
  const e = findEmployee(slug);
  return e ? e.name : slug;
}

function statusClass(status) {
  return STATUS_CLASS[status] || 'status-todo';
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function todayStr() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

function formatDueJp(dateStr) {
  if (!dateStr) return '期限未定';
  const d = new Date(dateStr + 'T00:00:00');
  const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}(${w})`;
}

function formatDateTimeJp(isoString) {
  const d = new Date(isoString);
  const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}(${w}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function isOverdue(task) {
  return !!(task.due_date && task.due_date < todayStr() && task.status !== '完了');
}

// 重要度: A(高) / B(中) / C(低)
const PRIORITIES = ['A', 'B', 'C'];
const PRIORITY_LABEL = { A: '高', B: '中', C: '低' };

function priorityOf(task) {
  return PRIORITIES.includes(task.priority) ? task.priority : 'B';
}

// 期限が近い順(期限なしは最後)、同じ期限なら新しく依頼された順。
function byDueDate(a, b) {
  const aDue = a.due_date || '9999-12-31';
  const bDue = b.due_date || '9999-12-31';
  if (aDue !== bDue) return aDue < bDue ? -1 : 1;
  return new Date(b.created_at) - new Date(a.created_at);
}

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const aDone = a.status === '完了' ? 1 : 0;
    const bDone = b.status === '完了' ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;
    const pa = PRIORITIES.indexOf(priorityOf(a));
    const pb = PRIORITIES.indexOf(priorityOf(b));
    if (pa !== pb) return pa - pb;
    return byDueDate(a, b);
  });
}

function priorityBadgeHtml(task) {
  const pr = priorityOf(task);
  return `<span class="prio-badge prio-${pr}" title="重要度 ${PRIORITY_LABEL[pr]}">${pr}</span>`;
}

function priorityOptionsHtml(selected) {
  return PRIORITIES.map(
    (pr) => `<option value="${pr}"${pr === selected ? ' selected' : ''}>${pr}(重要度 ${PRIORITY_LABEL[pr]})</option>`
  ).join('');
}

// ---- 繰り返し(taskdeskと同じ選択肢・同じ考え方) ----
const WEEKDAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];
const NTH_NAMES = ['', '第1', '第2', '第3', '第4', '第5'];

// 期限日を基準に、選択肢の文言(第◯◯曜日など)を組み立てる。期限未入力なら今日を仮の基準にする。
function repeatOptionsHtml(dueDateStr, selected) {
  const base = dueDateStr ? new Date(`${dueDateStr}T00:00:00`) : new Date();
  const wdName = `${WEEKDAY_NAMES[base.getDay()]}曜日`;
  const nth = Math.floor((base.getDate() - 1) / 7) + 1;
  const options = [
    { v: '', label: 'なし' },
    { v: 'daily', label: '毎日' },
    { v: 'weekly', label: `毎週${wdName}` },
    { v: 'weeklyMulti', label: '毎週(曜日を選択)' },
    { v: 'monthlyDate', label: `毎月${base.getDate()}日` },
    { v: 'monthlyNth', label: `毎月${NTH_NAMES[nth] || `第${nth}`}${wdName}` },
    { v: 'monthlyLastWeekday', label: `毎月最終${wdName}` },
    { v: 'monthlyFirstDay', label: '毎月月初め(1日)' },
    { v: 'monthlyLastDay', label: '毎月月末' },
    { v: 'monthlyLastBusinessDay', label: '毎月最終平日' },
  ];
  return options.map((o) => `<option value="${o.v}"${o.v === (selected || '') ? ' selected' : ''}>${o.label}</option>`).join('');
}

// "weeklyMulti"の時だけ、選んだ曜日をトグルできるボタンを追加で出す。
function repeatPillLabel(freq) {
  if (freq === 'daily') return '毎日';
  if (freq === 'weekly' || freq === 'weeklyMulti') return '毎週';
  if (freq && freq.indexOf('monthly') === 0) return '毎月';
  return '';
}

function repeatWeekdaysHtml(idPrefix, repeat, weekdays) {
  if (repeat !== 'weeklyMulti') return '';
  const days = weekdays || [];
  const buttons = WEEKDAY_NAMES.map(
    (name, idx) =>
      `<button type="button" class="weekday-toggle${days.includes(idx) ? ' on' : ''}" data-${idPrefix}-weekday="${idx}">${name}</button>`
  ).join('');
  return `<div class="field" id="${idPrefix}-weekdays-field"><label>曜日</label><div class="weekday-toggle-group">${buttons}</div></div>`;
}

// その人専用のURL(?u=slug)。ブックマーク/ホーム画面に追加してもらうためのもの。
function personalUrl(slug) {
  return `${location.origin}${location.pathname}?u=${encodeURIComponent(slug)}`;
}

function urlSlug() {
  return new URLSearchParams(location.search).get('u');
}

async function copyText(text, inputEl) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    if (inputEl) {
      inputEl.select();
      try {
        return document.execCommand('copy');
      } catch (e2) {
        return false;
      }
    }
    return false;
  }
}

async function route() {
  try {
    const me = await fetchCurrentEmployee();
    if (!me) return renderLogin(urlSlug());
    if (me.mustChangePasscode) return renderChangePasscode(me, true);
    EMPLOYEES = await fetchEmployees();
    const want = urlSlug();
    if (want && want !== me.slug) return renderWrongPerson(me, want);
    const googleResult = new URLSearchParams(location.search).get('google'); // ok / error(Googleの許可画面から戻った時)
    // 専用URLをアドレスバーに反映(このままブックマーク/ホーム画面に追加できる)
    history.replaceState(null, '', personalUrl(me.slug));
    document.title = `${me.name}のタスク`;
    const meta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (meta) meta.content = `${me.name}のタスク`;
    renderPersonPage(me, { googleResult });
  } catch (e) {
    console.error(e);
    renderError('読み込みに失敗しました。通信状況を確認して、ページを再読み込みしてください。');
  }
}

// 他の人の専用URLを、別の人がログインした状態で開いた時
function renderWrongPerson(me, wantSlug) {
  const target = findEmployee(wantSlug);
  const targetName = target ? target.name : wantSlug;
  app.innerHTML = `
    <div class="page">
      <h1>社内タスク管理</h1>
      <div class="card">
        <p style="margin-top:0;">このURLは<b>${escapeHtml(targetName)}さん専用</b>のページです。<br>現在は<b>${escapeHtml(me.name)}さん</b>でログインしています。</p>
        <button class="primary" id="wp-mine">${escapeHtml(me.name)}さんのページを開く</button>
        <button class="secondary" id="wp-switch" style="margin-top:8px;">ログアウトして${escapeHtml(targetName)}さんとしてログインする</button>
      </div>
    </div>`;
  document.getElementById('wp-mine').addEventListener('click', () => {
    location.href = personalUrl(me.slug);
  });
  document.getElementById('wp-switch').addEventListener('click', async () => {
    await logout();
    route();
  });
}

// presetSlug がある(専用URLから来た)時は「○○さん専用」の画面で、パスコードだけを入力する。
async function renderLogin(presetSlug) {
  app.innerHTML = `<div class="page"><h1>社内タスク管理</h1><p class="hint">読み込み中…</p></div>`;

  let list = [];
  try {
    list = await fetchDirectory();
  } catch (e) {
    console.error(e);
    return renderError('名前の一覧を読み込めませんでした。通信状況を確認して再読み込みしてください。');
  }
  const preset = presetSlug ? list.find((e) => e.slug === presetSlug) : null;
  const unknownPreset = presetSlug && !preset;

  const userField = preset
    ? `<p style="margin:0 0 14px;font-size:17px;font-weight:700;">${escapeHtml(preset.name)}さん</p>`
    : `<div class="field">
         <label for="lg-user">名前</label>
         <select id="lg-user">
           <option value="">選択してください</option>
           ${list.map((e) => `<option value="${escapeHtml(e.slug)}">${escapeHtml(e.name)}</option>`).join('')}
         </select>
       </div>`;

  app.innerHTML = `
    <div class="page">
      <h1>${preset ? `${escapeHtml(preset.name)}さん専用ページ` : '社内タスク管理'}</h1>
      ${unknownPreset ? '<p class="msg msg-error">このURLは利用できません。下から名前を選んでログインするか、管理者にお問い合わせください。</p>' : ''}
      <div class="card">
        <h2>ログイン</h2>
        ${userField}
        <div class="field">
          <label for="lg-pass">パスコード</label>
          <input id="lg-pass" type="password" autocomplete="current-password">
        </div>
        <button class="primary" id="lg-submit">ログイン</button>
        <p class="msg" id="lg-msg"></p>
      </div>
      <p class="hint">${
        preset
          ? `${escapeHtml(preset.name)}さんのパスコードを入力してください。このページをブックマーク(ホーム画面に追加)しておくと、次回から自分のページがすぐ開けます。<br><a href="${location.pathname}" style="color:inherit;">別の人としてログインする</a>`
          : 'パスコードは管理者から伝えられたものを入力してください。一度ログインすると、この端末では次回から自動でログインされます。'
      }</p>
    </div>`;

  const userEl = document.getElementById('lg-user');
  const passEl = document.getElementById('lg-pass');
  const msgEl = document.getElementById('lg-msg');
  const btn = document.getElementById('lg-submit');
  const chosenSlug = () => (preset ? preset.slug : userEl.value);

  async function submit() {
    if (!chosenSlug() || !passEl.value) {
      msgEl.textContent = '名前とパスコードを入力してください。';
      msgEl.className = 'msg msg-error';
      return;
    }
    btn.disabled = true;
    msgEl.textContent = 'ログイン中…';
    msgEl.className = 'msg';
    try {
      await loginWithPasscode(chosenSlug(), passEl.value);
      // 名前を選んでログインした場合も、その人の専用URLに移す
      if (!preset && urlSlug() !== chosenSlug()) history.replaceState(null, '', personalUrl(chosenSlug()));
      route();
    } catch (e) {
      console.error(e);
      msgEl.textContent = 'ログインできませんでした。名前とパスコードを確認してください。';
      msgEl.className = 'msg msg-error';
      btn.disabled = false;
    }
  }
  btn.addEventListener('click', submit);
  passEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
}

const MIN_PASSCODE_LENGTH = 8;

// forced=true: 初回ログイン時。自分のパスコードを決めるまで先へ進めない。
function renderChangePasscode(me, forced) {
  app.innerHTML = `
    <div class="page">
      <h1>${forced ? 'パスコードを決めてください' : 'パスコードの変更'}</h1>
      <div class="card">
        <p class="hint" style="margin-top:0;">${
          forced
            ? `${escapeHtml(me.name)}さん、ようこそ。今のパスコードは仮のものです。次回からログインに使う、自分だけのパスコードを決めてください。`
            : '新しいパスコードを入力してください。'
        }(${MIN_PASSCODE_LENGTH}文字以上。他の人に推測されにくいものにしてください)</p>
        <div class="field">
          <label for="pc-new">新しいパスコード</label>
          <input id="pc-new" type="password" autocomplete="new-password">
        </div>
        <div class="field">
          <label for="pc-new2">もう一度入力</label>
          <input id="pc-new2" type="password" autocomplete="new-password">
        </div>
        <button class="primary" id="pc-submit">パスコードを設定する</button>
        ${forced ? '' : '<button class="secondary" id="pc-cancel" style="margin-top:8px;">やめる</button>'}
        <p class="msg" id="pc-msg"></p>
      </div>
      ${forced ? '<p class="hint"><a href="#" id="pc-logout" style="color:inherit;">ログアウト</a></p>' : ''}
    </div>`;

  const msgEl = document.getElementById('pc-msg');
  const btn = document.getElementById('pc-submit');
  const fail = (t) => {
    msgEl.textContent = t;
    msgEl.className = 'msg msg-error';
  };

  btn.addEventListener('click', async () => {
    const p1 = document.getElementById('pc-new').value;
    const p2 = document.getElementById('pc-new2').value;
    if (p1.length < MIN_PASSCODE_LENGTH) return fail(`パスコードは${MIN_PASSCODE_LENGTH}文字以上にしてください。`);
    if (p1 !== p2) return fail('2回の入力が一致しません。');
    btn.disabled = true;
    msgEl.textContent = '設定中…';
    msgEl.className = 'msg';
    try {
      await changePasscode(p1);
      route();
    } catch (e) {
      console.error(e);
      fail('設定できませんでした。今のパスコードと同じものは使えません。別のパスコードでお試しください。');
      btn.disabled = false;
    }
  });

  const cancel = document.getElementById('pc-cancel');
  if (cancel) cancel.addEventListener('click', () => route());
  const out = document.getElementById('pc-logout');
  if (out) {
    out.addEventListener('click', async (e) => {
      e.preventDefault();
      await logout();
      route();
    });
  }
}

function renderError(msg) {
  app.innerHTML = `<div class="page"><div class="card"><p class="msg-error">${escapeHtml(msg)}</p></div></div>`;
}

async function renderPersonPage(me, { googleResult } = {}) {
  const slug = me.slug;
  const isAdmin = !!me.is_admin;

  app.innerHTML = `
    <div class="page wide">
      <div class="page-header">
        <h1>${escapeHtml(me.name)}さんのページ${isAdmin ? '<span class="admin-badge">管理者</span>' : ''}</h1>
        <span class="header-links">
          <a class="switch-link" href="#" id="googleBtn">Googleカレンダー</a>
          <a class="switch-link" href="#" id="changePasscodeBtn">パスコード変更</a>
          <a class="switch-link" href="#" id="logoutBtn">ログアウト</a>
        </span>
      </div>
      ${
        googleResult === 'ok'
          ? '<p class="msg msg-success">Googleカレンダーと連携しました。期限のあるタスクが「社内タスク」カレンダーに入ります。</p>'
          : googleResult === 'error'
            ? '<p class="msg msg-error">Googleカレンダーと連携できませんでした。「Googleカレンダー」からもう一度お試しください。</p>'
            : ''
      }
      <p class="hint">上が自分が「受けたタスク」、下が自分が「依頼したタスク」です。それぞれ重要度A・B・Cを横に並べ、期限が近いものから上に表示します。${isAdmin ? '管理者は「全員のタスク」で全員分を確認できます。' : ''}</p>

      <button class="primary" id="newTaskBtn" style="margin:14px 0;">＋ タスクを依頼する</button>

      ${
        isAdmin
          ? `<div class="view-tabs many">
        <button class="view-tab sel" data-tab="mine">自分のタスク</button>
        <button class="view-tab" data-tab="all">全員のタスク</button>
        <button class="view-tab" data-tab="members">メンバー管理</button>
      </div>`
          : ''
      }

      <div class="filter-row" id="filterRow">
        <button class="filter-chip sel" data-filter="open">未完了</button>
        <button class="filter-chip" data-filter="all">すべて</button>
      </div>
      <div class="field" id="personFilterField" style="display:none;">
        <select id="personFilter">
          <option value="">全員</option>
          ${EMPLOYEES.map((e) => `<option value="${escapeHtml(e.slug)}">${escapeHtml(e.name)}さん関連</option>`).join('')}
        </select>
      </div>

      <div id="taskListArea"><p class="hint">読み込み中…</p></div>
    </div>`;

  let activeView = 'mine'; // mine | all | members
  let activeFilter = 'open';
  let receivedTasks = [];
  let requestedTasks = [];
  let allTasks = [];

  const pageEl = app.querySelector('.page');
  const listArea = document.getElementById('taskListArea');

  // mode: received(受けた) / requested(依頼した) / all(全員)。詳細画面での立場と、表示する相手の名前が変わる。
  function taskItemHtml(task, mode) {
    const overdueClass = isOverdue(task) ? ' overdue' : '';
    let who;
    if (mode === 'received') who = `依頼者: ${escapeHtml(employeeName(task.requester_slug))}`;
    else if (mode === 'requested') who = `担当者: ${escapeHtml(employeeName(task.assignee_slug))}`;
    else who = `${escapeHtml(employeeName(task.requester_slug))} → ${escapeHtml(employeeName(task.assignee_slug))}`;
    return `<li class="task-item${overdueClass}" data-id="${task.id}" data-mode="${mode}">
      <div class="task-title">${escapeHtml(task.title)}</div>
      <div class="task-meta">
        <span class="status-badge ${statusClass(task.status)}">${task.status}</span>
        ${who} ・ 期限: ${formatDueJp(task.due_date)}${task.repeat ? ` ・ ↻ ${repeatPillLabel(task.repeat)}` : ''}
      </div>
    </li>`;
  }

  // 重要度A・B・Cを横3列に並べ、各列は期限が近い順。完了済み(「すべて」表示時のみ)は下にまとめる。
  function boardHtml(tasks, mode) {
    const visible = activeFilter === 'open' ? tasks.filter((t) => t.status !== '完了') : tasks;
    const open = visible.filter((t) => t.status !== '完了');
    const done = visible.filter((t) => t.status === '完了');
    const cols = PRIORITIES.map((pr) => {
      const group = open.filter((t) => priorityOf(t) === pr).sort(byDueDate);
      return `<div class="abc-col prio-${pr}">
        <div class="prio-head"><span class="prio-badge prio-${pr}">${pr}</span>重要度 ${PRIORITY_LABEL[pr]}<span class="prio-count">${group.length}件</span></div>
        ${
          group.length
            ? `<ul class="task-list">${group.map((t) => taskItemHtml(t, mode)).join('')}</ul>`
            : '<p class="hint empty">なし</p>'
        }
      </div>`;
    }).join('');
    const doneHtml = done.length
      ? `<div class="done-block"><div class="prio-head prio-done">完了<span class="prio-count">${done.length}件</span></div>
          <ul class="task-list">${sortTasks(done).map((t) => taskItemHtml(t, mode)).join('')}</ul></div>`
      : '';
    return `<div class="abc-grid">${cols}</div>${doneHtml}`;
  }

  function findTask(id) {
    return [...receivedTasks, ...requestedTasks, ...allTasks].find((t) => String(t.id) === id);
  }

  function roleFor(task, mode) {
    if (mode === 'received') return 'assignee';
    if (mode === 'requested') return 'requester';
    if (task.assignee_slug === slug) return 'assignee';
    if (task.requester_slug === slug) return 'requester';
    return 'viewer';
  }

  function renderList() {
    if (activeView === 'mine') {
      listArea.innerHTML = `
        <section class="board"><h2>受けたタスク</h2>${boardHtml(receivedTasks, 'received')}</section>
        <section class="board"><h2>依頼したタスク</h2>${boardHtml(requestedTasks, 'requested')}</section>`;
    } else {
      let tasks = allTasks;
      const who = document.getElementById('personFilter').value;
      if (who) tasks = tasks.filter((t) => t.requester_slug === who || t.assignee_slug === who);
      listArea.innerHTML = `<section class="board">${boardHtml(tasks, 'all')}</section>`;
    }
    listArea.querySelectorAll('.task-item').forEach((li) => {
      li.addEventListener('click', () => {
        const task = findTask(li.dataset.id);
        if (task) openTaskDetail(task, roleFor(task, li.dataset.mode), me, { onChanged: refreshActive });
      });
    });
  }

  async function refreshActive() {
    listArea.innerHTML = '<p class="hint">読み込み中…</p>';
    try {
      if (activeView === 'members') {
        await renderMembers(listArea, me);
        return;
      }
      if (activeView === 'mine') {
        [receivedTasks, requestedTasks] = await Promise.all([fetchTasksByAssignee(slug), fetchTasksByRequester(slug)]);
      } else {
        allTasks = await fetchAllTasks();
      }
      renderList();
    } catch (e) {
      console.error(e);
      listArea.innerHTML = '<p class="msg-error">読み込みに失敗しました。通信状況を確認してください。</p>';
    }
  }

  document.querySelectorAll('.view-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.view-tab').forEach((b) => b.classList.remove('sel'));
      btn.classList.add('sel');
      activeView = btn.dataset.tab;
      pageEl.classList.toggle('wide', activeView === 'mine');
      document.getElementById('personFilterField').style.display = activeView === 'all' ? '' : 'none';
      document.getElementById('filterRow').style.display = activeView === 'members' ? 'none' : '';
      refreshActive();
    });
  });

  document.querySelectorAll('.filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach((b) => b.classList.remove('sel'));
      btn.classList.add('sel');
      activeFilter = btn.dataset.filter;
      renderList();
    });
  });

  document.getElementById('personFilter').addEventListener('change', renderList);

  document.getElementById('googleBtn').addEventListener('click', (e) => {
    e.preventDefault();
    openGoogleSheet();
  });

  document.getElementById('changePasscodeBtn').addEventListener('click', (e) => {
    e.preventDefault();
    renderChangePasscode(me, false);
  });

  document.getElementById('logoutBtn').addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      await logout();
    } catch (err) {
      console.error(err);
    }
    route();
  });

  document.getElementById('newTaskBtn').addEventListener('click', () => {
    openNewTaskSheet(me, { onCreated: refreshActive });
  });

  await refreshActive();
}

// ---- Googleカレンダー連携 ----

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';

function openGoogleSheet() {
  const overlay = openSheet(`
    <div class="sheet-header">
      <h2>Googleカレンダー連携</h2>
      <button class="sheet-close" id="gc-close">×</button>
    </div>
    <div id="gc-body"><p class="hint">読み込み中…</p></div>
  `);
  document.getElementById('gc-close').addEventListener('click', () => closeSheet(overlay));
  const body = document.getElementById('gc-body');

  async function render() {
    let st;
    try {
      st = await googleStatus();
    } catch (e) {
      console.error(e);
      body.innerHTML = '<p class="msg msg-error">状態を読み込めませんでした。通信状況を確認してください。</p>';
      return;
    }
    if (!st.configured) {
      body.innerHTML = '<p class="hint">Googleカレンダー連携は、まだ準備中です(管理者の設定が完了していません)。</p>';
      return;
    }
    if (st.connected) {
      body.innerHTML = `
        <p class="msg msg-success" style="margin-top:0;">連携中です。</p>
        <p class="hint">期限のあるタスクが、あなたのGoogleカレンダーの「社内タスク」カレンダーに、期限の日の終日の予定として入ります。
          受けたタスクは「【重要度】タスク名」、依頼したタスクは「【依頼中】タスク名(担当: ○○)」の形です。完了すると頭に✅が付きます。</p>
        ${st.last_synced_at ? `<p class="hint">最後の反映: ${formatDateTimeJp(st.last_synced_at)}</p>` : ''}
        ${st.last_error ? `<p class="msg msg-error">${escapeHtml(st.last_error)}</p><button class="primary" id="gc-connect">もう一度連携する</button>` : ''}
        <button class="secondary" id="gc-disconnect" style="margin-top:12px;">連携を解除する</button>
        <p class="msg" id="gc-msg"></p>`;
      document.getElementById('gc-disconnect').addEventListener('click', async () => {
        if (!confirm('連携を解除します。Googleカレンダーの「社内タスク」カレンダーも削除されます。よろしいですか？')) return;
        const msgEl = document.getElementById('gc-msg');
        showMsg(msgEl, '解除しています…', false);
        try {
          await googleDisconnect();
          for (let i = 0; i < 8; i++) {
            await new Promise((r) => setTimeout(r, 1500));
            if (!(await googleStatus()).connected) break;
          }
          await render();
        } catch (e) {
          console.error(e);
          showMsg(msgEl, e.message || '解除できませんでした。', true);
        }
      });
    } else {
      body.innerHTML = `
        <p class="hint" style="margin-top:0;">連携すると、期限のあるタスクが、あなたのGoogleカレンダーに終日の予定として入ります。
          <br>・受けたタスク: 「【重要度】タスク名」
          <br>・依頼したタスク: 「【依頼中】タスク名(担当: ○○)」
          <br>・期限や担当の変更、キャンセルも反映され、完了すると頭に✅が付きます。
          <br>・アプリが作る「社内タスク」カレンダーだけを操作します。他の予定は見ません。</p>
        <p class="hint">Googleの画面で「Googleでは、このアプリを確認していません」と出た場合は、「詳細」→「(アプリ名)に移動」を押して進んでください(社内で作ったアプリのためです)。</p>
        <button class="primary" id="gc-connect">Googleカレンダーと連携する</button>
        <p class="msg" id="gc-msg"></p>`;
    }
    const connectBtn = document.getElementById('gc-connect');
    if (connectBtn) {
      connectBtn.addEventListener('click', async () => {
        connectBtn.disabled = true;
        try {
          const c = await googleBeginConnect();
          const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
          u.search = new URLSearchParams({
            client_id: c.client_id,
            redirect_uri: c.redirect_uri,
            response_type: 'code',
            scope: GOOGLE_SCOPE,
            access_type: 'offline',
            prompt: 'consent', // refresh_token を確実に受け取るため
            state: c.state,
          }).toString();
          location.href = u.toString();
        } catch (e) {
          console.error(e);
          const msgEl = document.getElementById('gc-msg');
          if (msgEl) showMsg(msgEl, e.message || '連携を始められませんでした。', true);
          connectBtn.disabled = false;
        }
      });
    }
  }
  render();
}

// ---- 管理者用: メンバー管理 ----

const PASSCODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // 紛らわしい文字(0/o、1/l/i)を除く

function generatePasscode() {
  const bytes = new Uint32Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => PASSCODE_ALPHABET[b % PASSCODE_ALPHABET.length]).join('');
}

async function renderMembers(container, me) {
  EMPLOYEES = await fetchEmployees();
  const items = EMPLOYEES.map((e) => {
    const badges =
      (e.is_admin ? '<span class="admin-badge">管理者</span>' : '') +
      (e.active === false ? '<span class="admin-badge off">利用停止中</span>' : '');
    return `<li class="task-item${e.active === false ? ' inactive' : ''}" data-slug="${escapeHtml(e.slug)}">
      <div class="task-title">${escapeHtml(e.name)}${badges}</div>
      <div class="task-meta">ログインID: ${escapeHtml(e.slug)} ・ Discord通知: ${e.discord_user_id ? '登録済み' : '未登録'}</div>
    </li>`;
  }).join('');
  container.innerHTML = `
    <button class="ghost" id="addMemberBtn" style="width:100%;margin-bottom:12px;">＋ メンバーを追加する</button>
    <ul class="task-list">${items}</ul>
    <p class="hint" style="margin-top:14px;">名前をタップすると、名前の変更・管理者の切り替え・利用停止・パスコードのリセットができます。</p>`;

  const reload = () => renderMembers(container, me);
  document.getElementById('addMemberBtn').addEventListener('click', () => openAddMemberSheet({ onDone: reload }));
  container.querySelectorAll('.task-item').forEach((li) => {
    li.addEventListener('click', () => {
      const emp = EMPLOYEES.find((e) => e.slug === li.dataset.slug);
      if (emp) openEditMemberSheet(emp, me, { onDone: reload });
    });
  });
}

function showMsg(el, text, isError) {
  el.textContent = text;
  el.className = isError ? 'msg msg-error' : 'msg';
}

function openAddMemberSheet({ onDone }) {
  const overlay = openSheet(`
    <div class="sheet-header">
      <h2>メンバーを追加する</h2>
      <button class="sheet-close" id="am-close">×</button>
    </div>
    <div id="am-form">
      <div class="field">
        <label for="am-name">名前(画面に表示されます)</label>
        <input id="am-name" type="text" placeholder="例) 山田太郎">
      </div>
      <div class="field">
        <label for="am-slug">ログインID(半角の英小文字・数字・ハイフン)</label>
        <input id="am-slug" type="text" autocapitalize="none" autocorrect="off" placeholder="例) yamada">
      </div>
      <div class="field">
        <label for="am-pass">仮のパスコード(8文字以上。本人が初回ログイン時に自分で決め直します)</label>
        <input id="am-pass" type="text" autocapitalize="none" autocorrect="off" value="${generatePasscode()}">
        <button class="ghost" id="am-regen" style="margin-top:6px;">別のパスコードを作る</button>
      </div>
      <div class="field">
        <label><input id="am-admin" type="checkbox" style="width:auto;"> 管理者にする(全員のタスクとメンバー管理を使える)</label>
      </div>
      <button class="primary" id="am-submit">追加する</button>
      <p class="msg" id="am-msg"></p>
    </div>
  `);
  document.getElementById('am-close').addEventListener('click', () => {
    closeSheet(overlay);
    onDone();
  });
  document.getElementById('am-regen').addEventListener('click', () => {
    document.getElementById('am-pass').value = generatePasscode();
  });
  document.getElementById('am-submit').addEventListener('click', async () => {
    const name = document.getElementById('am-name').value.trim();
    const slug = document.getElementById('am-slug').value.trim().toLowerCase();
    const passcode = document.getElementById('am-pass').value;
    const isAdmin = document.getElementById('am-admin').checked;
    const msgEl = document.getElementById('am-msg');
    if (!name) return showMsg(msgEl, '名前を入力してください。', true);
    if (!/^[a-z0-9-]+$/.test(slug)) return showMsg(msgEl, 'ログインIDは半角の英小文字・数字・ハイフンだけにしてください。', true);
    if (passcode.length < MIN_PASSCODE_LENGTH) return showMsg(msgEl, `仮のパスコードは${MIN_PASSCODE_LENGTH}文字以上にしてください。`, true);
    const btn = document.getElementById('am-submit');
    btn.disabled = true;
    showMsg(msgEl, '追加中…', false);
    try {
      await adminAddEmployee({ slug, name, passcode, isAdmin });
      document.getElementById('am-form').innerHTML = `
        <p class="msg msg-success" style="margin-top:0;">${escapeHtml(name)}さんを追加しました。</p>
        <div class="card" style="margin:12px 0;">
          <div class="hint">名前</div><div style="font-weight:700;">${escapeHtml(name)}</div>
          <div class="hint" style="margin-top:8px;">仮のパスコード</div>
          <div style="font-weight:700;font-size:20px;letter-spacing:1px;">${escapeHtml(passcode)}</div>
          <div class="hint" style="margin-top:8px;">${escapeHtml(name)}さん専用のURL</div>
          <input id="am-url" type="text" readonly value="${escapeHtml(personalUrl(slug))}" style="margin-top:4px;">
          <button class="ghost" id="am-copy" style="margin-top:6px;">URLをコピー</button>
          <p class="msg" id="am-copymsg"></p>
        </div>
        <p class="hint">この画面を閉じると、仮のパスコードは二度と表示できません。本人にだけ伝えてください(初回ログイン時に、本人が自分のパスコードへ変更します)。</p>
        <button class="primary" id="am-done">閉じる</button>`;
      document.getElementById('am-copy').addEventListener('click', async () => {
        const ok = await copyText(personalUrl(slug), document.getElementById('am-url'));
        showMsg(document.getElementById('am-copymsg'), ok ? 'コピーしました。' : 'コピーできませんでした。URLを長押しでコピーしてください。', !ok);
      });
      document.getElementById('am-done').addEventListener('click', () => {
        closeSheet(overlay);
        onDone();
      });
    } catch (e) {
      console.error(e);
      showMsg(msgEl, e.message || '追加できませんでした。', true);
      btn.disabled = false;
    }
  });
}

function openEditMemberSheet(emp, me, { onDone }) {
  const isSelf = emp.slug === me.slug;
  const overlay = openSheet(`
    <div class="sheet-header">
      <h2>${escapeHtml(emp.name)}さん</h2>
      <button class="sheet-close" id="em-close">×</button>
    </div>
    <p class="sheet-sub">ログインID: ${escapeHtml(emp.slug)}${isSelf ? ' ／ ご自身' : ''}</p>
    <div class="field">
      <label for="em-url">${escapeHtml(emp.name)}さん専用のURL(本人にブックマーク/ホーム画面への追加をお願いしてください)</label>
      <input id="em-url" type="text" readonly value="${escapeHtml(personalUrl(emp.slug))}">
      <button class="ghost" id="em-copy" style="margin-top:6px;">URLをコピー</button>
      <p class="msg" id="em-copymsg"></p>
    </div>
    <div class="field">
      <label for="em-name">名前</label>
      <input id="em-name" type="text" value="${escapeHtml(emp.name)}">
    </div>
    <div class="field">
      <label><input id="em-admin" type="checkbox" style="width:auto;" ${emp.is_admin ? 'checked' : ''} ${isSelf ? 'disabled' : ''}> 管理者</label>
    </div>
    <div class="field">
      <label><input id="em-active" type="checkbox" style="width:auto;" ${emp.active === false ? '' : 'checked'} ${isSelf ? 'disabled' : ''}> 利用中(外すとログインできなくなり、担当者の選択肢からも消えます。過去のタスクは残ります)</label>
    </div>
    ${isSelf ? '<p class="hint">ご自身の管理者権限と利用状態は、ここでは変更できません(締め出し防止)。</p>' : ''}
    <button class="primary" id="em-save">変更を保存する</button>
    <p class="msg" id="em-msg"></p>
    <hr class="sep">
    <h2 style="font-size:14px;">Discord通知</h2>
    <p class="hint">依頼・確認済み・完了・コメント・期限を、本人のDiscordへDMで知らせます。本人のDiscordユーザーID(数字17〜19桁)を登録してください。Discordの「ユーザー設定 → 詳細設定」で「開発者モード」をオンにして、サーバーのメンバー一覧で本人の名前を右クリック →「ユーザーIDをコピー」で取得できます。</p>
    <div class="field">
      <input id="em-discord" type="text" inputmode="numeric" autocomplete="off" placeholder="例) 123456789012345678" value="${escapeHtml(emp.discord_user_id || '')}">
    </div>
    <button class="ghost" id="em-dsave" style="width:100%;">DiscordユーザーIDを保存する</button>
    <button class="secondary" id="em-dtest" style="margin-top:8px;">テスト通知を送る</button>
    <p class="msg" id="em-dmsg"></p>
    <hr class="sep">
    <h2 style="font-size:14px;">パスコードのリセット</h2>
    <p class="hint">忘れた場合などに、仮のパスコードを設定し直します。本人は次回ログイン時に、また自分のパスコードを決め直します。ログイン中の端末は、ログアウトされます。</p>
    <div class="field">
      <input id="em-pass" type="text" autocapitalize="none" autocorrect="off" value="${generatePasscode()}">
      <button class="ghost" id="em-regen" style="margin-top:6px;">別のパスコードを作る</button>
    </div>
    <button class="secondary" id="em-reset">この仮のパスコードにリセットする</button>
    <p class="msg" id="em-pmsg"></p>
  `);

  document.getElementById('em-close').addEventListener('click', () => {
    closeSheet(overlay);
    onDone();
  });
  async function runTestNotification(msgEl) {
    showMsg(msgEl, '送信を依頼しました。結果を確認しています…', false);
    const startedAt = Date.now();
    await adminSendTestNotification(emp.slug);
    // 通知は非同期で送られるので、記録が付くまで数秒待って結果を見る
    let log = null;
    for (let i = 0; i < 6 && !log; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const latest = await fetchLatestNotifyLog(emp.slug);
      if (latest && new Date(latest.created_at).getTime() >= startedAt - 5000) log = latest;
    }
    if (!log) {
      showMsg(msgEl, '結果をまだ確認できません。少し待ってからもう一度お試しください(Discordを直接見ても構いません)。', true);
    } else if (log.ok) {
      showMsg(msgEl, `${emp.name}さんのDiscordにDMを送りました。届いているか確認してください。`, false);
      msgEl.className = 'msg msg-success';
    } else {
      showMsg(msgEl, `送れませんでした: ${log.detail}`, true);
    }
  }

  document.getElementById('em-dsave').addEventListener('click', async () => {
    const msgEl = document.getElementById('em-dmsg');
    const btn = document.getElementById('em-dsave');
    btn.disabled = true;
    showMsg(msgEl, '保存中…', false);
    try {
      await adminSetDiscord(emp.slug, document.getElementById('em-discord').value);
      emp.discord_user_id = document.getElementById('em-discord').value.trim() || null;
      if (emp.discord_user_id) {
        showMsg(msgEl, '保存しました。テスト通知を送っています…', false);
        await runTestNotification(msgEl);
      } else {
        showMsg(msgEl, '登録を解除しました。', false);
        msgEl.className = 'msg msg-success';
      }
    } catch (e) {
      console.error(e);
      showMsg(msgEl, e.message || '保存できませんでした。', true);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('em-dtest').addEventListener('click', async () => {
    const msgEl = document.getElementById('em-dmsg');
    const btn = document.getElementById('em-dtest');
    btn.disabled = true;
    try {
      await runTestNotification(msgEl);
    } catch (e) {
      console.error(e);
      showMsg(msgEl, e.message || '送信できませんでした。', true);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('em-copy').addEventListener('click', async () => {
    const ok = await copyText(personalUrl(emp.slug), document.getElementById('em-url'));
    showMsg(document.getElementById('em-copymsg'), ok ? 'コピーしました。' : 'コピーできませんでした。URLを長押しでコピーしてください。', !ok);
  });
  document.getElementById('em-regen').addEventListener('click', () => {
    document.getElementById('em-pass').value = generatePasscode();
  });

  document.getElementById('em-save').addEventListener('click', async () => {
    const name = document.getElementById('em-name').value.trim();
    const msgEl = document.getElementById('em-msg');
    if (!name) return showMsg(msgEl, '名前を入力してください。', true);
    const btn = document.getElementById('em-save');
    btn.disabled = true;
    showMsg(msgEl, '保存中…', false);
    try {
      await adminUpdateEmployee({
        slug: emp.slug,
        name,
        isAdmin: document.getElementById('em-admin').checked,
        active: document.getElementById('em-active').checked,
      });
      closeSheet(overlay);
      onDone();
    } catch (e) {
      console.error(e);
      showMsg(msgEl, e.message || '保存できませんでした。', true);
      btn.disabled = false;
    }
  });

  document.getElementById('em-reset').addEventListener('click', async () => {
    const passcode = document.getElementById('em-pass').value;
    const msgEl = document.getElementById('em-pmsg');
    if (passcode.length < MIN_PASSCODE_LENGTH) return showMsg(msgEl, `仮のパスコードは${MIN_PASSCODE_LENGTH}文字以上にしてください。`, true);
    if (!confirm(`${emp.name}さんのパスコードを「${passcode}」にリセットします。よろしいですか？`)) return;
    const btn = document.getElementById('em-reset');
    btn.disabled = true;
    showMsg(msgEl, 'リセット中…', false);
    try {
      await adminResetPasscode(emp.slug, passcode);
      showMsg(msgEl, `リセットしました。仮のパスコード「${passcode}」を本人にお伝えください。`, false);
      msgEl.className = 'msg msg-success';
    } catch (e) {
      console.error(e);
      showMsg(msgEl, e.message || 'リセットできませんでした。', true);
    } finally {
      btn.disabled = false;
    }
  });
}

function openSheet(innerHtml) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="sheet">${innerHtml}</div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeSheet(overlay);
  });
  return overlay;
}

function closeSheet(overlay) {
  overlay.remove();
}

// 添付画像を、ダウンロードせずその場で大きく見るための簡易プレビュー。タップで閉じる。
function openImageLightbox(url) {
  const overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';
  overlay.innerHTML = `
    <button type="button" class="lightbox-close" aria-label="閉じる">×</button>
    <img src="${url}" class="lightbox-img" alt="添付画像のプレビュー">
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.classList.contains('lightbox-close')) close();
  });
}

function openNewTaskSheet(me, { onCreated }) {
  const assigneeOptions = EMPLOYEES.filter((e) => e.active !== false)
    .map((e) => `<option value="${e.slug}">${escapeHtml(e.name)}</option>`)
    .join('');
  const overlay = openSheet(`
    <div class="sheet-header">
      <h2>タスクを依頼する</h2>
      <button class="sheet-close" id="closeNewTask">×</button>
    </div>
    <div class="field">
      <label for="nt-title">タスク内容</label>
      <input id="nt-title" type="text" placeholder="例) 見積書の作成">
    </div>
    <div class="field">
      <label for="nt-assignee">担当者</label>
      <select id="nt-assignee">${assigneeOptions}</select>
    </div>
    <div class="field">
      <label for="nt-priority">重要度</label>
      <select id="nt-priority">${priorityOptionsHtml('B')}</select>
    </div>
    <div class="field">
      <label for="nt-due">期限(任意)</label>
      <input id="nt-due" type="date">
    </div>
    <div class="field">
      <label for="nt-repeat">繰り返し</label>
      <select id="nt-repeat">${repeatOptionsHtml('', '')}</select>
    </div>
    <div id="nt-repeat-weekdays"></div>
    <div class="field">
      <label for="nt-desc">メモ(任意)</label>
      <textarea id="nt-desc" rows="4" placeholder="補足事項があれば"></textarea>
    </div>
    <div class="field">
      <label for="nt-files">画像・添付ファイル(任意)</label>
      <input id="nt-files" type="file" multiple>
      <ul id="nt-file-list" class="attachment-stage"></ul>
    </div>
    <button class="primary" id="nt-submit">この内容で依頼する</button>
    <p class="msg" id="nt-msg"></p>
  `);

  let ntRepeatWeekdays = [];
  function renderNtRepeatWeekdays() {
    const repeatSel = document.getElementById('nt-repeat');
    const box = document.getElementById('nt-repeat-weekdays');
    if (repeatSel.value === 'weeklyMulti' && !ntRepeatWeekdays.length) {
      const base = document.getElementById('nt-due').value ? new Date(`${document.getElementById('nt-due').value}T00:00:00`) : new Date();
      ntRepeatWeekdays = [base.getDay()];
    }
    box.innerHTML = repeatWeekdaysHtml('nt', repeatSel.value, ntRepeatWeekdays);
    box.querySelectorAll('[data-nt-weekday]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.ntWeekday);
        const pos = ntRepeatWeekdays.indexOf(idx);
        if (pos === -1) ntRepeatWeekdays.push(idx);
        else ntRepeatWeekdays.splice(pos, 1);
        ntRepeatWeekdays.sort((a, b) => a - b);
        renderNtRepeatWeekdays();
      });
    });
  }
  function refreshNtRepeatOptions() {
    const repeatSel = document.getElementById('nt-repeat');
    const current = repeatSel.value;
    repeatSel.innerHTML = repeatOptionsHtml(document.getElementById('nt-due').value, current);
    renderNtRepeatWeekdays();
  }
  document.getElementById('nt-due').addEventListener('change', refreshNtRepeatOptions);
  document.getElementById('nt-repeat').addEventListener('change', () => {
    if (document.getElementById('nt-repeat').value !== 'weeklyMulti') ntRepeatWeekdays = [];
    renderNtRepeatWeekdays();
  });

  document.getElementById('closeNewTask').addEventListener('click', () => closeSheet(overlay));

  // 送信前は端末上に保持するだけ(タスクIDが決まってからアップロードする)
  let stagedFiles = [];
  const fileInput = document.getElementById('nt-files');
  const fileListEl = document.getElementById('nt-file-list');
  function renderStagedFiles() {
    fileListEl.innerHTML = stagedFiles
      .map((f, i) => `<li>${escapeHtml(f.name)} <button type="button" class="ghost" data-remove-staged="${i}" title="削除">×</button></li>`)
      .join('');
  }
  fileInput.addEventListener('change', () => {
    stagedFiles = stagedFiles.concat(Array.from(fileInput.files));
    fileInput.value = '';
    renderStagedFiles();
  });
  fileListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-staged]');
    if (!btn) return;
    stagedFiles.splice(Number(btn.dataset.removeStaged), 1);
    renderStagedFiles();
  });

  document.getElementById('nt-submit').addEventListener('click', async () => {
    const title = document.getElementById('nt-title').value.trim();
    const msgEl = document.getElementById('nt-msg');
    if (!title) {
      msgEl.textContent = 'タイトルを入力してください。';
      msgEl.className = 'msg msg-error';
      return;
    }
    const btn = document.getElementById('nt-submit');
    btn.disabled = true;
    msgEl.textContent = '送信中…';
    msgEl.className = 'msg';
    try {
      const task = await createTask({
        title,
        description: document.getElementById('nt-desc').value.trim(),
        requesterSlug: me.slug,
        assigneeSlug: document.getElementById('nt-assignee').value,
        priority: document.getElementById('nt-priority').value,
        dueDate: document.getElementById('nt-due').value,
        repeat: document.getElementById('nt-repeat').value || null,
        repeatWeekdays: ntRepeatWeekdays,
      });
      if (stagedFiles.length) {
        msgEl.textContent = 'ファイルをアップロード中…';
        const failed = [];
        for (const file of stagedFiles) {
          try {
            await uploadTaskAttachment(task.id, file, me.slug);
          } catch (e) {
            console.error(e);
            failed.push(file.name);
          }
        }
        if (failed.length) {
          alert(`タスクは依頼できましたが、次のファイルのアップロードに失敗しました:\n${failed.join('\n')}`);
        }
      }
      closeSheet(overlay);
      onCreated();
    } catch (e) {
      console.error(e);
      msgEl.textContent = '送信に失敗しました。通信状況を確認してもう一度お試しください。';
      msgEl.className = 'msg msg-error';
      btn.disabled = false;
    }
  });
}

async function openTaskDetail(task, role, me, { onChanged }) {
  const overlay = openSheet(`
    <div class="sheet-header">
      <h2>${escapeHtml(task.title)}</h2>
      <button class="sheet-close" id="closeDetail">×</button>
    </div>
    <p class="sheet-sub">
      <span class="status-badge ${statusClass(task.status)}">${task.status}</span>
      ${priorityBadgeHtml(task)} 重要度 ${PRIORITY_LABEL[priorityOf(task)]}
      ／ 依頼者: ${escapeHtml(employeeName(task.requester_slug))} ／ 担当者: ${escapeHtml(employeeName(task.assignee_slug))}
      ／ 期限: ${formatDueJp(task.due_date)}${task.repeat ? ` ／ <span class="status-badge status-progress">↻ ${repeatPillLabel(task.repeat)}</span>` : ''}
    </p>
    ${task.description ? `<p class="hint" style="white-space:pre-wrap;margin-bottom:14px;">${escapeHtml(task.description)}</p>` : ''}
    <div id="detail-attachments"></div>
    <div id="detail-actions"></div>
    <hr class="sep">
    <h2 style="font-size:14px;">やり取り</h2>
    <div id="detail-log"><p class="hint">読み込み中…</p></div>
  `);

  document.getElementById('closeDetail').addEventListener('click', () => closeSheet(overlay));

  const IMAGE_RE = /^image\//;
  async function loadAttachments() {
    const el = document.getElementById('detail-attachments');
    let attachments;
    try {
      attachments = await fetchTaskAttachments(task.id);
    } catch (e) {
      console.error(e);
      el.innerHTML = '<p class="msg-error">添付ファイルの読み込みに失敗しました。</p>';
      return;
    }
    if (!attachments.length) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = `<div class="attachment-list">${attachments
      .map((a) => `<div class="attachment-item" data-id="${a.id}">
        <span class="attachment-thumb" data-path="${escapeHtml(a.storage_path)}" data-image="${IMAGE_RE.test(a.content_type || '')}">読み込み中…</span>
        <span class="attachment-name">${escapeHtml(a.file_name)}</span>
        ${role !== 'viewer' && (a.uploaded_by === me.slug || me.is_admin) ? `<button type="button" class="ghost" data-remove-attachment="${a.id}" data-path="${escapeHtml(a.storage_path)}" title="削除">×</button>` : ''}
      </div>`)
      .join('')}</div>`;

    el.querySelectorAll('.attachment-thumb').forEach(async (span) => {
      try {
        const url = await getAttachmentUrl(span.dataset.path);
        if (span.dataset.image === 'true') {
          const img = document.createElement('img');
          img.src = url;
          img.className = 'attachment-img';
          img.alt = 'プレビュー(タップで拡大)';
          img.addEventListener('click', () => openImageLightbox(url));
          span.innerHTML = '';
          span.appendChild(img);
        } else {
          span.innerHTML = `<a href="${url}" target="_blank" rel="noopener">開く/ダウンロード</a>`;
        }
      } catch (e) {
        console.error(e);
        span.textContent = '読み込みに失敗しました';
      }
    });

    el.querySelectorAll('[data-remove-attachment]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('この添付ファイルを削除します。よろしいですか？')) return;
        btn.disabled = true;
        try {
          await deleteTaskAttachment(btn.dataset.removeAttachment, btn.dataset.path);
          loadAttachments();
        } catch (e) {
          console.error(e);
          alert('削除に失敗しました。通信状況を確認してもう一度お試しください。');
          btn.disabled = false;
        }
      });
    });
  }
  loadAttachments();

  const handleStatusChanged = () => {
    closeSheet(overlay);
    onChanged();
  };

  const actionsEl = document.getElementById('detail-actions');
  if (role === 'assignee') {
    renderAssigneeActions(actionsEl, task, me, { onStatusChanged: handleStatusChanged, onMessagePosted: () => loadLog() });
  } else if (role === 'viewer') {
    renderViewerActions(actionsEl, task, me, { onMessagePosted: () => loadLog() });
  } else {
    renderRequesterActions(actionsEl, task, me, { onEdited: handleStatusChanged, onMessagePosted: () => loadLog() });
  }

  loadLog();

  async function loadLog() {
    const logEl = document.getElementById('detail-log');
    try {
      const updates = await fetchTaskUpdates(task.id);
      if (!updates.length) {
        logEl.innerHTML = '<p class="hint">まだ更新はありません。</p>';
        return;
      }
      logEl.innerHTML = `<ul class="update-log">${updates
        .map((u) => {
          const statusHtml = u.status ? `<span class="status-badge ${statusClass(u.status)}">${u.status}</span>` : '';
          const label = u.status ? `${escapeHtml(employeeName(u.employee_slug))}が更新` : escapeHtml(employeeName(u.employee_slug));
          return `<li><div class="update-meta">${formatDateTimeJp(u.created_at)} ・ ${label} ${statusHtml}</div>${
            u.comment ? escapeHtml(u.comment).replace(/\n/g, '<br>') : ''
          }</li>`;
        })
        .join('')}</ul>`;
    } catch (e) {
      console.error(e);
      logEl.innerHTML = '<p class="msg-error">読み込みに失敗しました。</p>';
    }
  }
}

function renderAssigneeActions(container, task, me, { onStatusChanged, onMessagePosted }) {
  const actionButtonHtml =
    task.status === '未確認'
      ? `<button class="primary" id="confirmBtn">確認する</button>`
      : task.status === '確認済み'
        ? `<button class="primary" id="completeBtn">完了にする</button>`
        : `<p class="hint">このタスクは完了しています。</p>`;

  container.innerHTML = `
    ${actionButtonHtml}
    <p class="msg" id="statusMsg"></p>
    <div class="field" style="margin-top:14px;">
      <label for="as-due">期限</label>
      <input id="as-due" type="date" value="${task.due_date || ''}">
    </div>
    <button class="ghost" id="as-due-save" style="width:100%;">期限を変更する</button>
    <p class="msg" id="as-due-msg"></p>
    <div class="field" style="margin-top:14px;">
      <label for="msgInput">質問・コメント(任意)</label>
      <textarea id="msgInput" rows="3" placeholder="例) 納期は今週中で大丈夫でしょうか？"></textarea>
    </div>
    <button class="ghost" id="msgSubmit" style="width:100%;">送信する</button>
    <p class="msg" id="msgMsg"></p>
  `;

  document.getElementById('as-due-save').addEventListener('click', async () => {
    const btn = document.getElementById('as-due-save');
    const msgEl = document.getElementById('as-due-msg');
    const newDue = document.getElementById('as-due').value;
    btn.disabled = true;
    msgEl.textContent = '保存中…';
    msgEl.className = 'msg';
    try {
      await updateDueDate(task.id, newDue, me.slug);
      onStatusChanged();
    } catch (e) {
      console.error(e);
      msgEl.textContent = '変更に失敗しました。通信状況を確認してもう一度お試しください。';
      msgEl.className = 'msg msg-error';
      btn.disabled = false;
    }
  });

  const confirmBtn = document.getElementById('confirmBtn');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      const msgEl = document.getElementById('statusMsg');
      msgEl.textContent = '更新中…';
      msgEl.className = 'msg';
      try {
        await confirmTask(task.id, me.slug);
        onStatusChanged();
      } catch (e) {
        console.error(e);
        msgEl.textContent = '更新に失敗しました。通信状況を確認してもう一度お試しください。';
        msgEl.className = 'msg msg-error';
        confirmBtn.disabled = false;
      }
    });
  }

  const completeBtn = document.getElementById('completeBtn');
  if (completeBtn) {
    completeBtn.addEventListener('click', async () => {
      completeBtn.disabled = true;
      const msgEl = document.getElementById('statusMsg');
      msgEl.textContent = '更新中…';
      msgEl.className = 'msg';
      try {
        await completeTask(task.id, me.slug);
        onStatusChanged();
      } catch (e) {
        console.error(e);
        msgEl.textContent = '更新に失敗しました。通信状況を確認してもう一度お試しください。';
        msgEl.className = 'msg msg-error';
        completeBtn.disabled = false;
      }
    });
  }

  document.getElementById('msgSubmit').addEventListener('click', async () => {
    const input = document.getElementById('msgInput');
    const text = input.value.trim();
    const msgEl = document.getElementById('msgMsg');
    if (!text) {
      msgEl.textContent = '内容を入力してください。';
      msgEl.className = 'msg msg-error';
      return;
    }
    const btn = document.getElementById('msgSubmit');
    btn.disabled = true;
    msgEl.textContent = '送信中…';
    msgEl.className = 'msg';
    try {
      await postMessage(task.id, me.slug, text);
      input.value = '';
      msgEl.textContent = '';
      msgEl.className = 'msg';
      onMessagePosted();
    } catch (e) {
      console.error(e);
      msgEl.textContent = '送信に失敗しました。通信状況を確認してもう一度お試しください。';
      msgEl.className = 'msg msg-error';
    } finally {
      btn.disabled = false;
    }
  });
}

// 管理者が他人のタスクを見ている時。内容やステータスは変えられず、コメントだけ送れる。
function renderViewerActions(container, task, me, { onMessagePosted }) {
  container.innerHTML = `
    <p class="hint">管理者として閲覧中です。内容の変更・ステータス変更は依頼者/担当者だけができます。</p>
    <div class="field" style="margin-top:10px;">
      <label for="viewer-input">コメント(任意)</label>
      <textarea id="viewer-input" rows="3" placeholder="管理者からのコメント"></textarea>
    </div>
    <button class="ghost" id="viewer-submit" style="width:100%;">送信する</button>
    <p class="msg" id="viewer-msg"></p>
  `;
  document.getElementById('viewer-submit').addEventListener('click', async () => {
    const input = document.getElementById('viewer-input');
    const text = input.value.trim();
    const msgEl = document.getElementById('viewer-msg');
    if (!text) {
      msgEl.textContent = '内容を入力してください。';
      msgEl.className = 'msg msg-error';
      return;
    }
    const btn = document.getElementById('viewer-submit');
    btn.disabled = true;
    try {
      await postMessage(task.id, me.slug, text);
      input.value = '';
      msgEl.textContent = '';
      onMessagePosted();
    } catch (e) {
      console.error(e);
      msgEl.textContent = '送信に失敗しました。通信状況を確認してもう一度お試しください。';
      msgEl.className = 'msg msg-error';
    } finally {
      btn.disabled = false;
    }
  });
}

function renderRequesterActions(container, task, me, { onEdited, onMessagePosted }) {
  const assigneeOptions = EMPLOYEES.filter((e) => e.active !== false || e.slug === task.assignee_slug)
    .map((e) => `<option value="${e.slug}"${e.slug === task.assignee_slug ? ' selected' : ''}>${escapeHtml(e.name)}</option>`)
    .join('');
  const completeButtonHtml =
    task.status !== '完了' ? `<button class="primary" id="rq-completeBtn" style="width:100%;">完了にする</button><p class="msg" id="rq-completeMsg"></p>` : '';

  container.innerHTML = `
    ${completeButtonHtml}
    <div class="field">
      <label for="et-title">タスク内容</label>
      <input id="et-title" type="text" value="${escapeHtml(task.title)}">
    </div>
    <div class="field">
      <label for="et-assignee">担当者</label>
      <select id="et-assignee">${assigneeOptions}</select>
    </div>
    <div class="field">
      <label for="et-priority">重要度</label>
      <select id="et-priority">${priorityOptionsHtml(priorityOf(task))}</select>
    </div>
    <div class="field">
      <label for="et-due">期限</label>
      <input id="et-due" type="date" value="${task.due_date || ''}">
    </div>
    <div class="field">
      <label for="et-repeat">繰り返し</label>
      <select id="et-repeat">${repeatOptionsHtml(task.due_date, task.repeat || '')}</select>
    </div>
    <div id="et-repeat-weekdays"></div>
    <div class="field">
      <label for="et-desc">メモ</label>
      <textarea id="et-desc" rows="4">${escapeHtml(task.description || '')}</textarea>
    </div>
    <button class="primary" id="et-submit">内容を保存する</button>
    <button class="secondary" id="et-delete">このタスクをキャンセルする</button>
    <p class="msg" id="et-msg"></p>
    <div class="field" style="margin-top:14px;">
      <label for="reply-input">担当者への返信・コメント(任意)</label>
      <textarea id="reply-input" rows="3" placeholder="例) 承知しました、その内容でお願いします"></textarea>
    </div>
    <button class="ghost" id="reply-submit" style="width:100%;">送信する</button>
    <p class="msg" id="reply-msg"></p>
  `;

  let etRepeatWeekdays = task.repeat === 'weeklyMulti' ? task.repeat_weekdays || [] : [];
  function renderEtRepeatWeekdays() {
    const repeatSel = document.getElementById('et-repeat');
    const box = document.getElementById('et-repeat-weekdays');
    if (repeatSel.value === 'weeklyMulti' && !etRepeatWeekdays.length) {
      const base = document.getElementById('et-due').value ? new Date(`${document.getElementById('et-due').value}T00:00:00`) : new Date();
      etRepeatWeekdays = [base.getDay()];
    }
    box.innerHTML = repeatWeekdaysHtml('et', repeatSel.value, etRepeatWeekdays);
    box.querySelectorAll('[data-et-weekday]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.etWeekday);
        const pos = etRepeatWeekdays.indexOf(idx);
        if (pos === -1) etRepeatWeekdays.push(idx);
        else etRepeatWeekdays.splice(pos, 1);
        etRepeatWeekdays.sort((a, b) => a - b);
        renderEtRepeatWeekdays();
      });
    });
  }
  document.getElementById('et-due').addEventListener('change', () => {
    const repeatSel = document.getElementById('et-repeat');
    const current = repeatSel.value;
    repeatSel.innerHTML = repeatOptionsHtml(document.getElementById('et-due').value, current);
    renderEtRepeatWeekdays();
  });
  document.getElementById('et-repeat').addEventListener('change', () => {
    if (document.getElementById('et-repeat').value !== 'weeklyMulti') etRepeatWeekdays = [];
    renderEtRepeatWeekdays();
  });
  renderEtRepeatWeekdays();

  const completeBtn = document.getElementById('rq-completeBtn');
  if (completeBtn) {
    completeBtn.addEventListener('click', async () => {
      completeBtn.disabled = true;
      const msgEl = document.getElementById('rq-completeMsg');
      msgEl.textContent = '更新中…';
      msgEl.className = 'msg';
      try {
        await completeTask(task.id, me.slug);
        onEdited();
      } catch (e) {
        console.error(e);
        msgEl.textContent = '更新に失敗しました。通信状況を確認してもう一度お試しください。';
        msgEl.className = 'msg msg-error';
        completeBtn.disabled = false;
      }
    });
  }

  document.getElementById('et-submit').addEventListener('click', async () => {
    const title = document.getElementById('et-title').value.trim();
    const msgEl = document.getElementById('et-msg');
    if (!title) {
      msgEl.textContent = 'タスク内容を入力してください。';
      msgEl.className = 'msg msg-error';
      return;
    }
    const btn = document.getElementById('et-submit');
    btn.disabled = true;
    msgEl.textContent = '保存中…';
    msgEl.className = 'msg';
    try {
      await editTask(task.id, {
        title,
        description: document.getElementById('et-desc').value.trim(),
        assigneeSlug: document.getElementById('et-assignee').value,
        priority: document.getElementById('et-priority').value,
        dueDate: document.getElementById('et-due').value,
        repeat: document.getElementById('et-repeat').value || null,
        repeatWeekdays: etRepeatWeekdays,
      });
      onEdited();
    } catch (e) {
      console.error(e);
      msgEl.textContent = '保存に失敗しました。通信状況を確認してもう一度お試しください。';
      msgEl.className = 'msg msg-error';
      btn.disabled = false;
    }
  });

  document.getElementById('et-delete').addEventListener('click', async () => {
    if (!confirm(`「${task.title}」をキャンセルします。よろしいですか？`)) return;
    const btn = document.getElementById('et-delete');
    btn.disabled = true;
    try {
      await deleteTask(task.id);
      onEdited();
    } catch (e) {
      console.error(e);
      alert('キャンセルに失敗しました。通信状況を確認してもう一度お試しください。');
      btn.disabled = false;
    }
  });

  document.getElementById('reply-submit').addEventListener('click', async () => {
    const input = document.getElementById('reply-input');
    const text = input.value.trim();
    const msgEl = document.getElementById('reply-msg');
    if (!text) {
      msgEl.textContent = '内容を入力してください。';
      msgEl.className = 'msg msg-error';
      return;
    }
    const btn = document.getElementById('reply-submit');
    btn.disabled = true;
    msgEl.textContent = '送信中…';
    msgEl.className = 'msg';
    try {
      await postMessage(task.id, me.slug, text);
      input.value = '';
      msgEl.textContent = '';
      msgEl.className = 'msg';
      onMessagePosted();
    } catch (e) {
      console.error(e);
      msgEl.textContent = '送信に失敗しました。通信状況を確認してもう一度お試しください。';
      msgEl.className = 'msg msg-error';
    } finally {
      btn.disabled = false;
    }
  });
}

route();
