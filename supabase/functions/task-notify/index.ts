// タスクの変更(依頼・確認済み・完了・コメント・期限)を、関係する人のDiscordへDMで通知する。
// DBのトリガー/pg_cron(supabase_notify.sql)から、pg_net経由で呼ばれる。
//
// 認証: リクエストの x-notify-secret ヘッダを、DBの notify_settings.secret と照合する
// (DBの外に合言葉を持たないため、Edge Functionのsecretは DISCORD_BOT_TOKEN の1つだけ)。
// デプロイ時は --no-verify-jwt が必要(呼び出し元はSupabaseのJWTを持たないため)。

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_TOKEN = Deno.env.get("DISCORD_BOT_TOKEN") ?? "";

const DISCORD_API = "https://discord.com/api/v10";
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

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
type Employee = { slug: string; name: string; discord_user_id: string | null; discord_dm_channel_id: string | null; active: boolean };

const PRIORITY_COLOR: Record<string, number> = { A: 0xc0392b, B: 0xd68910, C: 0x7f8c8d };
const PRIORITY_LABEL: Record<string, string> = { A: "高", B: "中", C: "低" };

function formatDue(due: string | null): string {
  if (!due) return "期限未定";
  const d = new Date(`${due}T00:00:00Z`);
  const w = ["日", "月", "火", "水", "木", "金", "土"][d.getUTCDay()];
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${w})`;
}

async function discord(path: string, method: string, body: unknown, attempt = 0): Promise<Response> {
  const res = await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (task-notify, 1.0)",
    },
    body: JSON.stringify(body),
  });
  if (res.status === 429 && attempt < 2) {
    const j = await res.json().catch(() => ({ retry_after: 1 }));
    await new Promise((r) => setTimeout(r, Math.min(5, Number(j.retry_after ?? 1)) * 1000 + 100));
    return discord(path, method, body, attempt + 1);
  }
  return res;
}

async function openDm(emp: Employee): Promise<string> {
  const res = await discord("/users/@me/channels", "POST", { recipient_id: emp.discord_user_id });
  if (!res.ok) throw new Error(`DMを開けませんでした(${res.status}): ${await res.text()}`);
  const ch = await res.json();
  await supabase.from("employees").update({ discord_dm_channel_id: ch.id }).eq("slug", emp.slug);
  return ch.id as string;
}

// 1人にDMを送る。保存済みのDMチャンネルが無効なら、開き直して1回だけ再送する。
async function sendDm(emp: Employee, embed: Record<string, unknown>): Promise<void> {
  if (!BOT_TOKEN) throw new Error("DISCORD_BOT_TOKEN が設定されていません");
  if (!emp.discord_user_id) throw new Error("DiscordユーザーIDが未登録です");
  let channelId = emp.discord_dm_channel_id ?? (await openDm(emp));
  let res = await discord(`/channels/${channelId}/messages`, "POST", { embeds: [embed] });
  if (res.status === 404) {
    channelId = await openDm(emp);
    res = await discord(`/channels/${channelId}/messages`, "POST", { embeds: [embed] });
  }
  if (!res.ok) {
    const text = await res.text();
    if (text.includes("50007")) {
      throw new Error("DMを送れませんでした。本人のDiscordで「サーバーメンバーからのダイレクトメッセージを許可する」がオフの可能性があります");
    }
    throw new Error(`送信に失敗しました(${res.status}): ${text}`);
  }
}

function embedFor(
  event: string,
  task: Task | null,
  names: Map<string, string>,
  actorSlug: string | null,
  comment: string | null,
  recipient: Employee,
  appUrl: string,
): Record<string, unknown> {
  const actor = actorSlug ? names.get(actorSlug) ?? actorSlug : "";
  const url = `${appUrl}?u=${encodeURIComponent(recipient.slug)}`;
  if (event === "test" || !task) {
    return {
      title: "✅ テスト通知",
      description: `${recipient.name}さん、Discordへの通知はこのとおり届きます。${actor ? `\n(${actor}さんが送信しました)` : ""}`,
      color: 0x0d6b58,
      url,
    };
  }
  const base = {
    url,
    fields: [
      { name: "重要度", value: `${task.priority}(${PRIORITY_LABEL[task.priority] ?? ""})`, inline: true },
      { name: "期限", value: formatDue(task.due_date), inline: true },
      { name: "依頼者 → 担当者", value: `${names.get(task.requester_slug) ?? task.requester_slug} → ${names.get(task.assignee_slug) ?? task.assignee_slug}`, inline: false },
    ],
  };
  const color = PRIORITY_COLOR[task.priority] ?? 0x7f8c8d;
  switch (event) {
    case "created":
      return { ...base, color, title: "📋 新しいタスクの依頼", description: `**${task.title}**\n${actor}さんからの依頼です。${task.description ? `\n\n${task.description}` : ""}` };
    case "reassigned":
      return { ...base, color, title: "📋 担当になりました", description: `**${task.title}**\n${actor ? `${actor}さんが担当を変更しました。` : "担当が変更されました。"}` };
    case "confirmed":
      return { ...base, color: 0x2e86c1, title: "👀 確認済みになりました", description: `**${task.title}**\n${actor}さんが確認しました。` };
    case "completed":
      return { ...base, color: 0x1e7a3d, title: "✅ 完了しました", description: `**${task.title}**\n${actor}さんが完了にしました。` };
    case "comment":
      return { ...base, color: 0x8e44ad, title: "💬 コメントが届きました", description: `**${task.title}**\n${actor}さん:\n${(comment ?? "").slice(0, 1500)}` };
    case "due_tomorrow":
      return { ...base, color: 0xd68910, title: "⏰ 明日が期限です", description: `**${task.title}**\n現在のステータス: ${task.status}` };
    case "overdue":
      return { ...base, color: 0xc0392b, title: "⚠️ 期限を過ぎています", description: `**${task.title}**\n現在のステータス: ${task.status}` };
    default:
      return { ...base, color, title: "タスクの更新", description: `**${task.title}**` };
  }
}

// 誰に送るか。操作した本人には送らない。
function recipientsFor(event: string, task: Task | null, actor: string | null, to: string | null): string[] {
  let list: string[] = [];
  if (event === "test") list = to ? [to] : [];
  else if (!task) list = [];
  else if (event === "created" || event === "reassigned" || event === "due_tomorrow") list = [task.assignee_slug];
  else if (event === "confirmed" || event === "completed") list = [task.requester_slug];
  else if (event === "comment") list = [task.requester_slug, task.assignee_slug];
  else if (event === "overdue") list = [task.assignee_slug, task.requester_slug];
  const unique = [...new Set(list)];
  return event === "test" ? unique : unique.filter((s) => s !== actor);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const { data: rows } = await supabase.from("notify_settings").select("key, value").in("key", ["secret", "app_url"]);
  const settings = new Map((rows ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
  const secret = settings.get("secret");
  if (!secret || req.headers.get("x-notify-secret") !== secret) return new Response("unauthorized", { status: 401 });
  const appUrl = settings.get("app_url") ?? "";

  let payload: { event: string; task_id: string | null; actor: string | null; comment: string | null; to: string | null };
  try {
    payload = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  let task: Task | null = null;
  if (payload.task_id) {
    const { data } = await supabase.from("tasks").select("*").eq("id", payload.task_id).maybeSingle();
    task = (data as Task) ?? null;
    if (!task) return Response.json({ ok: false, error: "task not found" });
  }

  const { data: emps } = await supabase.from("employees").select("slug, name, discord_user_id, discord_dm_channel_id, active");
  const employees = (emps ?? []) as Employee[];
  const names = new Map(employees.map((e) => [e.slug, e.name]));

  const results: { to: string; ok: boolean; detail: string }[] = [];
  for (const slug of recipientsFor(payload.event, task, payload.actor, payload.to)) {
    const emp = employees.find((e) => e.slug === slug);
    if (!emp || !emp.active) continue; // 停止中の人には送らない
    if (!emp.discord_user_id && payload.event !== "test") continue; // 未登録の人は黙ってスキップ(テストだけはエラーとして記録)
    try {
      await sendDm(emp, embedFor(payload.event, task, names, payload.actor, payload.comment, emp, appUrl));
      results.push({ to: slug, ok: true, detail: "送信しました" });
    } catch (e) {
      results.push({ to: slug, ok: false, detail: (e as Error).message.slice(0, 500) });
    }
  }

  if (results.length) {
    await supabase.from("notify_log").insert(
      results.map((r) => ({ event: payload.event, to_slug: r.to, task_id: payload.task_id, ok: r.ok, detail: r.detail })),
    );
  }
  return Response.json({ ok: true, results });
});
