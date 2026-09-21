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

async function createTask({ title, description, requesterSlug, assigneeSlug, priority, dueDate }) {
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

// 担当者が「完了にする」を押した時。
async function completeTask(taskId, employeeSlug) {
  assertClient();
  const now = new Date().toISOString();
  const { error: updateError } = await sb
    .from('tasks')
    .update({ status: '完了', updated_at: now, completed_at: now })
    .eq('id', taskId);
  if (updateError) throw updateError;

  const { error: logError } = await sb
    .from('task_updates')
    .insert({ task_id: taskId, employee_slug: employeeSlug, status: '完了', comment: null });
  if (logError) throw logError;
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
async function editTask(taskId, { title, description, assigneeSlug, priority, dueDate }) {
  assertClient();
  const { error } = await sb
    .from('tasks')
    .update({
      title,
      description: description || '',
      assignee_slug: assigneeSlug,
      priority: priority || 'B',
      due_date: dueDate || null,
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
