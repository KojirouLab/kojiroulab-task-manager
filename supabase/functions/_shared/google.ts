// Googleカレンダー連携の共通処理(task-google-sync と task-google-callback が使う)。
// 方向はアプリ → Googleの一方向のみ。予定は、各自の「社内タスク」カレンダー(アプリが作ったもの)にだけ書く。

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const CLIENT_SECRET = Deno.env.get("TASKMGR_GOOGLE_CLIENT_SECRET") ?? "";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CAL_API = "https://www.googleapis.com/calendar/v3";

export type Settings = Record<string, string>;

export async function loadSettings(): Promise<Settings> {
  const { data } = await supabase.from("google_settings").select("key, value");
  return Object.fromEntries((data ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
}

type Task = {
  id: string;
  title: string;
  description: string;
  requester_slug: string;
  assignee_slug: string;
  status: string;
  priority: string;
  due_date: string | null;
};
type Account = { slug: string; refresh_token: string; calendar_id: string };

const PRIORITY_LABEL: Record<string, string> = { A: "高", B: "中", C: "低" };
// Googleカレンダーのイベント色ID(A=トマト、B=ミカン、C=グラファイト、完了=バジル)
const PRIORITY_COLOR: Record<string, string> = { A: "11", B: "6", C: "8" };
const DONE_COLOR = "10";

async function accessTokenFor(acc: Account, clientId: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: CLIENT_SECRET,
      refresh_token: acc.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const detail = `${json.error ?? res.status}: ${json.error_description ?? ""}`;
    if (json.error === "invalid_grant") throw new Error("Googleとの連携が無効になりました。もう一度「Googleカレンダーと連携」を押してください");
    throw new Error(`Googleのトークンを取得できませんでした(${detail})`);
  }
  return json.access_token as string;
}

async function gcal(method: string, path: string, token: string, body?: unknown): Promise<Response> {
  return await fetch(`${CAL_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function addDays(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function eventBody(
  task: Task,
  role: "assignee" | "requester",
  slug: string,
  names: Map<string, string>,
  appUrl: string,
): Record<string, unknown> {
  const done = task.status === "完了";
  const p = task.priority in PRIORITY_LABEL ? task.priority : "B";
  const nameOf = (s: string) => names.get(s) ?? s;
  const summary = role === "assignee"
    ? `${done ? "✅ " : ""}【${p}】${task.title}`
    : `${done ? "✅ " : ""}【依頼中】${task.title}(担当: ${nameOf(task.assignee_slug)})`;
  const lines = [
    role === "assignee" ? `依頼者: ${nameOf(task.requester_slug)}` : `担当者: ${nameOf(task.assignee_slug)}`,
    `重要度: ${p}(${PRIORITY_LABEL[p]})`,
    `ステータス: ${task.status}`,
  ];
  if (task.description) lines.push("", task.description);
  const pageUrl = `${appUrl}?u=${encodeURIComponent(slug)}`;
  lines.push("", `専用ページ: ${pageUrl}`);
  return {
    summary,
    description: lines.join("\n"),
    // 終日の予定は、終了日を「期限の翌日」にする(Googleの仕様)
    start: { date: task.due_date },
    end: { date: addDays(task.due_date!, 1) },
    colorId: done ? DONE_COLOR : PRIORITY_COLOR[p],
    transparency: "transparent",
    source: { title: "社内タスク管理", url: pageUrl },
    extendedProperties: { private: { taskId: task.id } },
  };
}

// 1つのタスクについて、関係する人のカレンダーの予定を、あるべき状態に揃える。
export async function syncTask(taskId: string, settings: Settings): Promise<void> {
  const { data: taskRow } = await supabase.from("tasks").select("*").eq("id", taskId).maybeSingle();
  const task = (taskRow as Task | null) ?? null; // nullなら削除されたタスク
  const { data: trackedRows } = await supabase.from("google_events").select("*").eq("task_id", taskId);
  const tracked = (trackedRows ?? []) as { task_id: string; slug: string; role: string; event_id: string | null }[];

  const involved = new Set<string>(tracked.map((t) => t.slug));
  if (task) {
    involved.add(task.assignee_slug);
    involved.add(task.requester_slug);
  }
  const { data: accRows } = await supabase.from("google_accounts").select("slug, refresh_token, calendar_id").in("slug", [...involved]);
  const accounts = new Map(((accRows ?? []) as Account[]).map((a) => [a.slug, a]));

  const { data: emps } = await supabase.from("employees").select("slug, name");
  const names = new Map((emps ?? []).map((e: { slug: string; name: string }) => [e.slug, e.name]));

  // あるべき予定: 期限があるタスクだけ。担当者は「assignee」、依頼者は「requester」(自分宛なら1つだけ)
  const desired = new Map<string, "assignee" | "requester">();
  if (task && task.due_date) {
    desired.set(task.assignee_slug, "assignee");
    if (task.requester_slug !== task.assignee_slug) desired.set(task.requester_slug, "requester");
  }

  const errors = new Map<string, string>();
  const tokens = new Map<string, string>();
  const tokenFor = async (slug: string): Promise<string> => {
    const cached = tokens.get(slug);
    if (cached) return cached;
    const t = await accessTokenFor(accounts.get(slug)!, settings.client_id);
    tokens.set(slug, t);
    return t;
  };

  // 1) 不要になった予定を消す(担当変更・期限削除・タスク削除)
  for (const row of tracked) {
    if (desired.has(row.slug) && accounts.has(row.slug)) continue;
    const acc = accounts.get(row.slug);
    try {
      if (acc && row.event_id) {
        const res = await gcal("DELETE", `/calendars/${encodeURIComponent(acc.calendar_id)}/events/${row.event_id}`, await tokenFor(row.slug));
        if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`予定を削除できませんでした(${res.status})`);
      }
      await supabase.from("google_events").delete().eq("task_id", taskId).eq("slug", row.slug);
    } catch (e) {
      errors.set(row.slug, (e as Error).message);
    }
  }

  // 2) 作成・更新
  for (const [slug, role] of desired) {
    const acc = accounts.get(slug);
    if (!acc) continue; // 連携していない人には何もしない
    try {
      const body = eventBody(task!, role, slug, names, settings.app_url ?? "");
      const token = await tokenFor(slug);
      const calId = encodeURIComponent(acc.calendar_id);
      const existing = tracked.find((t) => t.slug === slug);
      let eventId = existing?.event_id ?? null;

      if (eventId) {
        const res = await gcal("PATCH", `/calendars/${calId}/events/${eventId}`, token, body);
        if (res.status === 404 || res.status === 410) eventId = null; // 手動で消された等 → 作り直す
        else if (!res.ok) throw new Error(`予定を更新できませんでした(${res.status}): ${await res.text()}`);
      }
      if (!eventId) {
        const res = await gcal("POST", `/calendars/${calId}/events`, token, body);
        if (!res.ok) throw new Error(`予定を作成できませんでした(${res.status}): ${await res.text()}`);
        eventId = (await res.json()).id as string;
      }
      await supabase.from("google_events").upsert(
        { task_id: taskId, slug, role, event_id: eventId, updated_at: new Date().toISOString() },
        { onConflict: "task_id,slug" },
      );
    } catch (e) {
      errors.set(slug, (e as Error).message);
    }
  }

  // 結果を、各アカウントの状態として残す(連携画面に表示される)
  for (const slug of accounts.keys()) {
    const err = errors.get(slug);
    await supabase.from("google_accounts").update(
      err ? { last_error: err.slice(0, 500) } : { last_error: null, last_synced_at: new Date().toISOString() },
    ).eq("slug", slug);
  }
}

// 連携した直後に、その人に関係する未完了・期限ありのタスクをまとめて反映する
export async function backfill(slug: string, settings: Settings): Promise<void> {
  const { data } = await supabase
    .from("tasks")
    .select("id")
    .or(`assignee_slug.eq.${slug},requester_slug.eq.${slug}`)
    .neq("status", "完了")
    .not("due_date", "is", null);
  for (const t of (data ?? []) as { id: string }[]) await syncTask(t.id, settings);
}

// 連携解除: 作った「社内タスク」カレンダーを丸ごと削除し、トークンを取り消して、記録を消す
export async function disconnect(slug: string, settings: Settings): Promise<void> {
  const { data } = await supabase.from("google_accounts").select("slug, refresh_token, calendar_id").eq("slug", slug).maybeSingle();
  const acc = data as Account | null;
  if (acc) {
    try {
      const token = await accessTokenFor(acc, settings.client_id);
      await gcal("DELETE", `/calendars/${encodeURIComponent(acc.calendar_id)}`, token);
    } catch (_e) {
      // 既に取り消されている等。記録の削除は続ける
    }
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: acc.refresh_token }),
    }).catch(() => {});
  }
  await supabase.from("google_events").delete().eq("slug", slug);
  await supabase.from("google_accounts").delete().eq("slug", slug);
}

export async function exchangeCode(code: string, settings: Settings) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: settings.client_id,
      client_secret: CLIENT_SECRET,
      redirect_uri: settings.redirect_uri,
      grant_type: "authorization_code",
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${json.error ?? res.status}: ${json.error_description ?? ""}`);
  return json as { access_token: string; refresh_token?: string };
}

export async function createCalendar(accessToken: string, name: string): Promise<string> {
  const res = await gcal("POST", "/calendars", accessToken, { summary: name, timeZone: "Asia/Tokyo" });
  if (!res.ok) throw new Error(`カレンダーを作成できませんでした(${res.status}): ${await res.text()}`);
  return (await res.json()).id as string;
}

export async function calendarExists(accessToken: string, calendarId: string): Promise<boolean> {
  const res = await gcal("GET", `/calendars/${encodeURIComponent(calendarId)}`, accessToken);
  return res.ok;
}
