// Googleの許可画面から戻ってきた時の受け口。
// state(連携ボタンを押した本人だけが持つ使い捨てコード)を確かめ、refresh_tokenを保存し、
// 「社内タスク」カレンダーを作って、既存のタスクを反映してから、アプリのページへ戻す。
// デプロイ時は --no-verify-jwt が必要(Googleからのリダイレクトには、Supabaseのログイン情報がないため)。
// 必要なEdge Functionのsecret: TASKMGR_GOOGLE_CLIENT_SECRET

import { backfill, calendarExists, createCalendar, exchangeCode, loadSettings, supabase } from "../_shared/google.ts";

function back(appUrl: string, slug: string | null, result: "ok" | "error"): Response {
  const url = `${appUrl}${slug ? `?u=${encodeURIComponent(slug)}&` : "?"}google=${result}`;
  return new Response(null, { status: 302, headers: { Location: url } });
}

Deno.serve(async (req) => {
  const settings = await loadSettings();
  const appUrl = settings.app_url ?? "";
  const params = new URL(req.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");

  // 使い捨てコードの照合(15分以内・1回だけ)
  let slug: string | null = null;
  if (state) {
    const { data } = await supabase.from("google_oauth_states").select("slug, created_at").eq("state", state).maybeSingle();
    if (data && Date.now() - new Date(data.created_at).getTime() < 15 * 60 * 1000) slug = data.slug;
    await supabase.from("google_oauth_states").delete().eq("state", state);
  }
  if (!slug) return back(appUrl, null, "error");
  if (params.get("error") || !code) return back(appUrl, slug, "error"); // 許可しなかった場合など

  try {
    const tokens = await exchangeCode(code, settings);
    if (!tokens.refresh_token) throw new Error("refresh_token を取得できませんでした");

    // 再連携の場合は、以前のカレンダーを再利用する
    const { data: existing } = await supabase.from("google_accounts").select("calendar_id").eq("slug", slug).maybeSingle();
    let calendarId: string | null = existing?.calendar_id ?? null;
    if (calendarId && !(await calendarExists(tokens.access_token, calendarId))) calendarId = null;
    if (!calendarId) calendarId = await createCalendar(tokens.access_token, settings.calendar_name ?? "社内タスク");

    await supabase.from("google_accounts").upsert({
      slug,
      refresh_token: tokens.refresh_token,
      calendar_id: calendarId,
      connected_at: new Date().toISOString(),
      last_error: null,
    }, { onConflict: "slug" });

    await backfill(slug, settings);
    return back(appUrl, slug, "ok");
  } catch (e) {
    console.error(e);
    await supabase.from("google_accounts").update({ last_error: (e as Error).message.slice(0, 500) }).eq("slug", slug);
    return back(appUrl, slug, "error");
  }
});
