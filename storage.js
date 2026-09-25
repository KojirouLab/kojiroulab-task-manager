// ここに Supabase の Project URL と anon key を貼り付けてください。
// (Supabase ダッシュボード > Project Settings > API で確認できます。anon key は
// 公開されても問題ない設計です。データはログイン(パスコード)とRLSで守られています。)
const SUPABASE_URL = 'https://krdwyfemepbbyrteyoeb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtyZHd5ZmVtZXBiYnlydGV5b2ViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0OTgzNDEsImV4cCI6MjA5OTA3NDM0MX0.J0gc9jt5hCwIjmKI0ltQ_ZjlcyBUaVnBaJlW95ykRvU';

// ログイン用メールの「@より後ろ」。社員のメールは「slug@このドメイン」で登録する(SETUP.md 参照)。
// 実在しないアドレスで構いません。
const LOGIN_DOMAIN = 'task-manager.example.com';

let sb = null;
try {
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} catch (e) {
  console.error('Supabase client init failed', e);
}

function assertClient() {
  if (!sb) throw new Error('Supabase未設定です。storage.js の SUPABASE_URL / SUPABASE_ANON_KEY を設定してください。');
}

// ---- 認証・社員 ----

// ログイン画面の名前一覧(ログイン前でも読める。名前とslugのみ)
async function fetchDirectory() {
  assertClient();
  const { data, error } = await sb.from('employee_directory').select('slug, name, sort_order').order('sort_order').order('name');
  if (error) throw error;
  return data || [];
}

async function loginWithPasscode(slug, passcode) {
  assertClient();
  const { error } = await sb.auth.signInWithPassword({ email: `${slug}@${LOGIN_DOMAIN}`, password: passcode });
  if (error) throw error;
}

async function logout() {
  assertClient();
  await sb.auth.signOut();
}

// パスコードを自分で変更する。変更済みの印(user_metadata.passcode_changed)も付ける。
async function changePasscode(newPasscode) {
  assertClient();
  const { error } = await sb.auth.updateUser({ password: newPasscode, data: { passcode_changed: true } });
  if (error) throw error;
}

// ログイン中の社員(slug, name, is_admin, mustChangePasscode)。未ログイン、または社員として登録されていなければ null。
// mustChangePasscode: 管理者が設定した仮のパスコードのままの状態(初回ログイン)。
async function fetchCurrentEmployee() {
  assertClient();
  const { data } = await sb.auth.getSession();
  const email = data && data.session && data.session.user && data.session.user.email;
  if (!email) return null;
  const slug = email.split('@')[0].toLowerCase();
  const { data: row, error } = await sb.from('employees').select('slug, name, is_admin').eq('slug', slug).maybeSingle();
  if (error) throw error;
  if (!row) return null;
  const meta = data.session.user.user_metadata || {};
  return { ...row, mustChangePasscode: !meta.passcode_changed };
}

// ログイン後に読める社員一覧(担当者の選択肢用)
async function fetchEmployees() {
  assertClient();
  // discord_user_id なども含める(担当者の選択と、管理者のメンバー管理で使う)
  const { data, error } = await sb.from('employees').select('*').order('sort_order').order('name');
  if (error) throw error;
  return data || [];
}

// ---- 管理者用: メンバー管理(DB側の関数が、呼んだ人が管理者かどうかを必ず確認する) ----

async function adminAddEmployee({ slug, name, passcode, isAdmin }) {
  assertClient();
  const { error } = await sb.rpc('admin_add_employee', {
    p_slug: slug,
    p_name: name,
    p_passcode: passcode,
    p_is_admin: !!isAdmin,
  });
  if (error) throw error;
}

async function adminUpdateEmployee({ slug, name, isAdmin, active }) {
  assertClient();
  const { error } = await sb.rpc('admin_update_employee', {
    p_slug: slug,
    p_name: name,
    p_is_admin: !!isAdmin,
    p_active: !!active,
  });
  if (error) throw error;
}

async function adminSetDiscord(slug, discordUserId) {
  assertClient();
  const { error } = await sb.rpc('admin_set_discord', { p_slug: slug, p_discord_user_id: discordUserId });
  if (error) throw error;
}

async function adminSendTestNotification(slug) {
  assertClient();
  const { error } = await sb.rpc('admin_send_test_notification', { p_slug: slug });
  if (error) throw error;
}

// その人宛ての通知の最新の記録(成功/失敗)。管理者だけが読める。
async function fetchLatestNotifyLog(slug) {
  assertClient();
  const { data, error } = await sb
    .from('notify_log')
    .select('created_at, event, ok, detail')
    .eq('to_slug', slug)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

async function adminResetPasscode(slug, passcode) {
  assertClient();
  const { error } = await sb.rpc('admin_reset_passcode', { p_slug: slug, p_passcode: passcode });
  if (error) throw error;
}

// ---- Googleカレンダー連携(本人の分だけ。トークン類はサーバー側にしかない) ----

async function googleStatus() {
  assertClient();
  const { data, error } = await sb.rpc('google_status');
  if (error) throw error;
  return data;
}

// 連携を始めるための使い捨てコードと、認可URLの材料(公開情報)を受け取る
async function googleBeginConnect() {
  assertClient();
  const { data, error } = await sb.rpc('google_begin_connect');
  if (error) throw error;
  return data;
}

async function googleDisconnect() {
  assertClient();
  const { error } = await sb.rpc('google_disconnect');
  if (error) throw error;
}

// ---- タスク ----

async function fetchTasksByRequester(slug) {
  assertClient();
  const { data, error } = await sb.from('tasks').select('*').eq('requester_slug', slug);
  if (error) throw error;
  return data || [];
}

async function fetchTasksByAssignee(slug) {
  assertClient();
  const { data, error } = await sb.from('tasks').select('*').eq('assignee_slug', slug);
  if (error) throw error;
  return data || [];
}

// 管理者用: 全員のタスク(RLSにより、管理者以外が呼んでも自分に関係するものしか返らない)
async function fetchAllTasks() {
  assertClient();
  const { data, error } = await sb.from('tasks').select('*');
  if (error) throw error;
  return data || [];
}

// ---- 繰り返し(taskdeskと同じ考え方: 完了にした時点で次回分を1件だけ新規発行する) ----

function lastDayOfMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}
function nthWeekdayOfMonth(date) {
  return Math.floor((date.getDate() - 1) / 7) + 1;
}
function nthWeekdayDate(year, month, weekday, nth) {
  const firstWeekday = new Date(year, month, 1).getDay();
  const offset = (weekday - firstWeekday + 7) % 7;
  let day = 1 + offset + (nth - 1) * 7;
  const last = lastDayOfMonth(year, month);
  if (day > last) day -= 7;
  return new Date(year, month, day);
}
function lastWeekdayDate(year, month, weekday) {
  const d = new Date(year, month, lastDayOfMonth(year, month));
  while (d.getDay() !== weekday) d.setDate(d.getDate() - 1);
  return d;
}
function lastBusinessDayDate(year, month) {
  const d = new Date(year, month, lastDayOfMonth(year, month));
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d;
}
function dateToKey(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// freq(文字列)と基準日から、次回の発生日を計算する(YYYY-MM-DD文字列で返す)。
function computeNextDueDate(baseDateStr, freq, weekdays) {
  const base = baseDateStr ? new Date(`${baseDateStr}T00:00:00`) : new Date();
  const y = base.getFullYear(), m = base.getMonth(), d = base.getDate();
  let next;
  switch (freq) {
    case 'daily':
      next = new Date(y, m, d + 1);
      break;
    case 'weekly':
      next = new Date(y, m, d + 7);
      break;
    case 'weeklyMulti': {
      const days = weekdays && weekdays.length ? weekdays : [base.getDay()];
      next = null;
      for (let add = 1; add <= 7; add++) {
        const cand = new Date(y, m, d + add);
        if (days.includes(cand.getDay())) {
          next = cand;
          break;
        }
      }
      if (!next) next = new Date(y, m, d + 7);
      break;
    }
    case 'monthlyDate':
      next = new Date(y, m + 1, Math.min(d, lastDayOfMonth(y, m + 1)));
      break;
    case 'monthlyNth':
      next = nthWeekdayDate(y, m + 1, base.getDay(), nthWeekdayOfMonth(base));
      break;
    case 'monthlyLastWeekday':
      next = lastWeekdayDate(y, m + 1, base.getDay());
      break;
    case 'monthlyFirstDay':
      next = new Date(y, m + 1, 1);
      break;
    case 'monthlyLastDay':
      next = new Date(y, m + 2, 0);
      break;
    case 'monthlyLastBusinessDay':
      next = lastBusinessDayDate(y, m + 1);
      break;
    default:
      next = new Date(y, m, d + 7);
  }
  return dateToKey(next);
}

async function createTask({ title, description, requesterSlug, assigneeSlug, priority, dueDate, repeat, repeatWeekdays }) {
  assertClient();
  const { data, error } = await sb
    .from('tasks')
    .insert({
      title,
      description: description || '',
      requester_slug: requesterSlug,
      assignee_slug: assigneeSlug,
      priority: priority || 'B',
      due_date: dueDate || null,
      status: '未確認',
      repeat: repeat || null,
      repeat_weekdays: repeat === 'weeklyMulti' ? repeatWeekdays || null : null,
      repeat_anchor_date: repeat ? dueDate || null : null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// 担当者が「確認する」を押した時。依頼者には一覧のステータスバッジで伝わる。
async function confirmTask(taskId, employeeSlug) {
  assertClient();
  const { error: updateError } = await sb
    .from('tasks')
    .update({ status: '確認済み', updated_at: new Date().toISOString() })
    .eq('id', taskId);
  if (updateError) throw updateError;

  const { error: logError } = await sb
    .from('task_updates')
    .insert({ task_id: taskId, employee_slug: employeeSlug, status: '確認済み', comment: null });
  if (logError) throw logError;
}

// 担当者、または依頼者が「完了にする」を押した時。繰り返し設定があれば、次回分を1件新規発行する。
async function completeTask(taskId, employeeSlug) {
  assertClient();
  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await sb
    .from('tasks')
    .update({ status: '完了', updated_at: now, completed_at: now })
    .eq('id', taskId)
    .select()
    .single();
  if (updateError) throw updateError;

  const { error: logError } = await sb
    .from('task_updates')
    .insert({ task_id: taskId, employee_slug: employeeSlug, status: '完了', comment: null });
  if (logError) throw logError;

  // 次回分の自動発行に失敗しても、完了処理自体は既に成功しているので失敗扱いにしない
  // (ここで例外を投げると、完了できたのに画面上は失敗したように見えてしまうため)。
  if (updated && updated.repeat) {
    try {
      const anchor = updated.repeat_anchor_date || updated.due_date;
      const nextDate = computeNextDueDate(anchor, updated.repeat, updated.repeat_weekdays);
      await createTask({
        title: updated.title,
        description: updated.description,
        requesterSlug: updated.requester_slug,
        assigneeSlug: updated.assignee_slug,
        priority: updated.priority,
        dueDate: nextDate,
        repeat: updated.repeat,
        repeatWeekdays: updated.repeat_weekdays,
      });
    } catch (e) {
      console.error('次回分の自動発行に失敗しました', e);
    }
  }
}

// 質問・コメント(ステータスは変えず、依頼者・担当者どちらからも送れる)。
async function postMessage(taskId, employeeSlug, comment) {
  assertClient();
  const { error } = await sb
    .from('task_updates')
    .insert({ task_id: taskId, employee_slug: employeeSlug, status: null, comment });
  if (error) throw error;
}

// 依頼者によるタスク内容の編集。
async function editTask(taskId, { title, description, assigneeSlug, priority, dueDate, repeat, repeatWeekdays }) {
  assertClient();
  const { error } = await sb
    .from('tasks')
    .update({
      title,
      description: description || '',
      assignee_slug: assigneeSlug,
      priority: priority || 'B',
      due_date: dueDate || null,
      repeat: repeat || null,
      repeat_weekdays: repeat === 'weeklyMulti' ? repeatWeekdays || null : null,
      repeat_anchor_date: repeat ? dueDate || null : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', taskId);
  if (error) throw error;
}

async function deleteTask(taskId) {
  assertClient();
  const { error } = await sb.from('tasks').delete().eq('id', taskId);
  if (error) throw error;
}

// ---- 添付ファイル ----
// ストレージの保存先パスは "{タスクid}/{タイムスタンプ}_{ランダム文字列}.{拡張子}" という
// 半角英数字だけの安全な形にする(日本語や②のような記号を含むファイル名だと、ストレージ側で
// 保存に失敗することがあるため)。元のファイル名は file_name 列にそのまま保存し、画面表示に使う。

async function uploadTaskAttachment(taskId, file, uploaderSlug) {
  assertClient();
  const extMatch = /\.[a-zA-Z0-9]{1,10}$/.exec(file.name);
  const ext = extMatch ? extMatch[0].toLowerCase() : '';
  const safeKey = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
  const path = `${taskId}/${safeKey}`;
  const { error: upErr } = await sb.storage.from('task-attachments').upload(path, file, {
    contentType: file.type || undefined,
  });
  if (upErr) throw upErr;
  const { error: insErr } = await sb.from('task_attachments').insert({
    task_id: taskId,
    storage_path: path,
    file_name: file.name,
    content_type: file.type || null,
    uploaded_by: uploaderSlug,
  });
  if (insErr) throw insErr;
}

async function fetchTaskAttachments(taskId) {
  assertClient();
  const { data, error } = await sb
    .from('task_attachments')
    .select('*')
    .eq('task_id', taskId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

// ダウンロード・プレビュー用の一時URL(非公開バケットのため毎回発行する。既定で10分有効)
async function getAttachmentUrl(storagePath) {
  assertClient();
  const { data, error } = await sb.storage.from('task-attachments').createSignedUrl(storagePath, 600);
  if (error) throw error;
  return data.signedUrl;
}

async function deleteTaskAttachment(id, storagePath) {
  assertClient();
  const { error: rmErr } = await sb.storage.from('task-attachments').remove([storagePath]);
  if (rmErr) throw rmErr;
  const { error: delErr } = await sb.from('task_attachments').delete().eq('id', id);
  if (delErr) throw delErr;
}

async function fetchTaskUpdates(taskId) {
  assertClient();
  const { data, error } = await sb
    .from('task_updates')
    .select('*')
    .eq('task_id', taskId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}
