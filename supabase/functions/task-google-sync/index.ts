// タスクの変更を、担当者・依頼者のGoogleカレンダーに反映する(アプリ → Googleの一方向)。
// DBのトリガー(supabase_google.sql)からpg_net経由で呼ばれる。
//
// 認証: x-sync-secret ヘッダを、DBの google_settings.secret と照合する。
// デプロイ時は --no-verify-jwt が必要(呼び出し元はSupabaseのJWTを持たないため)。
// 必要なEdge Functionのsecret: TASKMGR_GOOGLE_CLIENT_SECRET

import { backfill, disconnect, loadSettings, syncTask } from "../_shared/google.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const settings = await loadSettings();
  if (!settings.secret || req.headers.get("x-sync-secret") !== settings.secret) {
    return new Response("unauthorized", { status: 401 });
  }
  if (!settings.client_id) return Response.json({ ok: false, error: "client_id が未設定です" });

  let payload: { task_id?: string; deleted?: boolean; event?: string; slug?: string };
  try {
    payload = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  try {
    if (payload.event === "disconnect" && payload.slug) await disconnect(payload.slug, settings);
    else if (payload.event === "backfill" && payload.slug) await backfill(payload.slug, settings);
    else if (payload.task_id) await syncTask(payload.task_id, settings);
    else return new Response("bad request", { status: 400 });
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, error: (e as Error).message });
  }
});
