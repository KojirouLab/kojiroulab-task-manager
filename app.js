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

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const aDone = a.status === '完了' ? 1 : 0;
    const bDone = b.status === '完了' ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;
    const aDue = a.due_date || '9999-12-31';
    const bDue = b.due_date || '9999-12-31';
    if (aDue !== bDue) return aDue < bDue ? -1 : 1;
    return new Date(b.created_at) - new Date(a.created_at);
  });
}

async function route() {
  try {
    const me = await fetchCurrentEmployee();
    if (!me) return renderLogin();
    if (me.mustChangePasscode) return renderChangePasscode(me, true);
    EMPLOYEES = await fetchEmployees();
    renderPersonPage(me);
  } catch (e) {
    console.error(e);
    renderError('読み込みに失敗しました。通信状況を確認して、ページを再読み込みしてください。');
  }
}

async function renderLogin() {
  app.innerHTML = `
    <div class="page">
      <h1>社内タスク管理</h1>
      <div class="card">
        <h2>ログイン</h2>
        <div class="field">
          <label for="lg-user">名前</label>
          <select id="lg-user"><option value="">読み込み中…</option></select>
        </div>
        <div class="field">
          <label for="lg-pass">パスコード</label>
          <input id="lg-pass" type="password" autocomplete="current-password">
        </div>
        <button class="primary" id="lg-submit">ログイン</button>
        <p class="msg" id="lg-msg"></p>
      </div>
      <p class="hint">パスコードは管理者から伝えられたものを入力してください。一度ログインすると、この端末では次回から自動でログインされます。</p>
    </div>`;

  const userEl = document.getElementById('lg-user');
  const passEl = document.getElementById('lg-pass');
  const msgEl = document.getElementById('lg-msg');
  const btn = document.getElementById('lg-submit');

  try {
    const list = await fetchDirectory();
    userEl.innerHTML =
      '<option value="">選択してください</option>' +
      list.map((e) => `<option value="${escapeHtml(e.slug)}">${escapeHtml(e.name)}</option>`).join('');
  } catch (e) {
    console.error(e);
    msgEl.textContent = '名前の一覧を読み込めませんでした。通信状況を確認して再読み込みしてください。';
    msgEl.className = 'msg msg-error';
    return;
  }

  async function submit() {
    if (!userEl.value || !passEl.value) {
      msgEl.textContent = '名前とパスコードを入力してください。';
      msgEl.className = 'msg msg-error';
      return;
    }
    btn.disabled = true;
    msgEl.textContent = 'ログイン中…';
    msgEl.className = 'msg';
    try {
      await loginWithPasscode(userEl.value, passEl.value);
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

async function renderPersonPage(me) {
  const slug = me.slug;
  const isAdmin = !!me.is_admin;

  app.innerHTML = `
    <div class="page">
      <div class="page-header">
        <h1>${escapeHtml(me.name)}さんのページ${isAdmin ? '<span class="admin-badge">管理者</span>' : ''}</h1>
        <span class="header-links">
          <a class="switch-link" href="#" id="changePasscodeBtn">パスコード変更</a>
          <a class="switch-link" href="#" id="logoutBtn">ログアウト</a>
        </span>
      </div>
      <p class="hint">自分が「受けたタスク」と「依頼したタスク」をここでまとめて管理できます。${isAdmin ? '管理者は「全員のタスク」で全員分を確認できます。' : ''}</p>

      <button class="primary" id="newTaskBtn" style="margin:14px 0;">＋ タスクを依頼する</button>

      <div class="view-tabs">
        <button class="view-tab sel" data-tab="received">受けたタスク</button>
        <button class="view-tab" data-tab="requested">依頼したタスク</button>
        ${isAdmin ? '<button class="view-tab" data-tab="all">全員のタスク</button>' : ''}
      </div>

      <div class="filter-row">
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

  let activeTab = 'received';
  let activeFilter = 'open';
  let receivedTasks = [];
  let requestedTasks = [];
  let allTasks = [];

  const listArea = document.getElementById('taskListArea');

  function currentTasks() {
    if (activeTab === 'all') return allTasks;
    return activeTab === 'received' ? receivedTasks : requestedTasks;
  }

  // 詳細画面での立場。自分が担当者/依頼者ならその操作ができ、どちらでもなければ(管理者の閲覧)閲覧のみ。
  function roleFor(task) {
    if (activeTab === 'received') return 'assignee';
    if (activeTab === 'requested') return 'requester';
    if (task.assignee_slug === slug) return 'assignee';
    if (task.requester_slug === slug) return 'requester';
    return 'viewer';
  }

  function taskItemHtml(task) {
    const overdueClass = isOverdue(task) ? ' overdue' : '';
    let who;
    if (activeTab === 'received') who = `依頼者: ${escapeHtml(employeeName(task.requester_slug))}`;
    else if (activeTab === 'requested') who = `担当者: ${escapeHtml(employeeName(task.assignee_slug))}`;
    else who = `${escapeHtml(employeeName(task.requester_slug))} → ${escapeHtml(employeeName(task.assignee_slug))}`;
    return `<li class="task-item${overdueClass}" data-id="${task.id}">
      <div class="task-title">${escapeHtml(task.title)}</div>
      <div class="task-meta">
        <span class="status-badge ${statusClass(task.status)}">${task.status}</span>
        ${who} ・ 期限: ${formatDueJp(task.due_date)}
      </div>
    </li>`;
  }

  function renderList() {
    let tasks = currentTasks();
    if (activeFilter === 'open') tasks = tasks.filter((t) => t.status !== '完了');
    if (activeTab === 'all') {
      const who = document.getElementById('personFilter').value;
      if (who) tasks = tasks.filter((t) => t.requester_slug === who || t.assignee_slug === who);
    }
    tasks = sortTasks(tasks);
    if (!tasks.length) {
      listArea.innerHTML = `<p class="hint">${activeFilter === 'open' ? '未完了のタスクはありません。' : 'タスクはありません。'}</p>`;
      return;
    }
    listArea.innerHTML = `<ul class="task-list">${tasks.map(taskItemHtml).join('')}</ul>`;
    listArea.querySelectorAll('.task-item').forEach((li) => {
      li.addEventListener('click', () => {
        const task = currentTasks().find((t) => String(t.id) === li.dataset.id);
        if (task) openTaskDetail(task, roleFor(task), me, { onChanged: refreshActive });
      });
    });
  }

  async function refreshActive() {
    listArea.innerHTML = '<p class="hint">読み込み中…</p>';
    try {
      if (activeTab === 'received') {
        receivedTasks = await fetchTasksByAssignee(slug);
      } else if (activeTab === 'requested') {
        requestedTasks = await fetchTasksByRequester(slug);
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
      activeTab = btn.dataset.tab;
      document.getElementById('personFilterField').style.display = activeTab === 'all' ? '' : 'none';
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

function openNewTaskSheet(me, { onCreated }) {
  const assigneeOptions = EMPLOYEES.map((e) => `<option value="${e.slug}">${escapeHtml(e.name)}</option>`).join('');
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
      <label for="nt-due">期限(任意)</label>
      <input id="nt-due" type="date">
    </div>
    <div class="field">
      <label for="nt-desc">メモ(任意)</label>
      <textarea id="nt-desc" rows="4" placeholder="補足事項があれば"></textarea>
    </div>
    <button class="primary" id="nt-submit">この内容で依頼する</button>
    <p class="msg" id="nt-msg"></p>
  `);

  document.getElementById('closeNewTask').addEventListener('click', () => closeSheet(overlay));

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
      await createTask({
        title,
        description: document.getElementById('nt-desc').value.trim(),
        requesterSlug: me.slug,
        assigneeSlug: document.getElementById('nt-assignee').value,
        dueDate: document.getElementById('nt-due').value,
      });
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
      ／ 依頼者: ${escapeHtml(employeeName(task.requester_slug))} ／ 担当者: ${escapeHtml(employeeName(task.assignee_slug))}
      ／ 期限: ${formatDueJp(task.due_date)}
    </p>
    ${task.description ? `<p class="hint" style="white-space:pre-wrap;margin-bottom:14px;">${escapeHtml(task.description)}</p>` : ''}
    <div id="detail-actions"></div>
    <hr class="sep">
    <h2 style="font-size:14px;">やり取り</h2>
    <div id="detail-log"><p class="hint">読み込み中…</p></div>
  `);

  document.getElementById('closeDetail').addEventListener('click', () => closeSheet(overlay));

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
      <label for="msgInput">質問・コメント(任意)</label>
      <textarea id="msgInput" rows="3" placeholder="例) 納期は今週中で大丈夫でしょうか？"></textarea>
    </div>
    <button class="ghost" id="msgSubmit" style="width:100%;">送信する</button>
    <p class="msg" id="msgMsg"></p>
  `;

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
  const assigneeOptions = EMPLOYEES.map(
    (e) => `<option value="${e.slug}"${e.slug === task.assignee_slug ? ' selected' : ''}>${escapeHtml(e.name)}</option>`
  ).join('');
  container.innerHTML = `
    <div class="field">
      <label for="et-title">タスク内容</label>
      <input id="et-title" type="text" value="${escapeHtml(task.title)}">
    </div>
    <div class="field">
      <label for="et-assignee">担当者</label>
      <select id="et-assignee">${assigneeOptions}</select>
    </div>
    <div class="field">
      <label for="et-due">期限</label>
      <input id="et-due" type="date" value="${task.due_date || ''}">
    </div>
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
        dueDate: document.getElementById('et-due').value,
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
