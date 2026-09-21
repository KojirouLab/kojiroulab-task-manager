-- Googleカレンダー連携用のSQL。supabase.sql / supabase_admin.sql / supabase_priority.sql を実行したあとに、
-- SQL Editor で実行してください。何度実行しても問題ありません。
--
-- 仕組み(アプリ → Google の一方向):
--   各自が「Googleカレンダーと連携」を押して自分のGoogleアカウントで許可(OAuth)
--   → Edge Function「task-google-callback」がrefresh_tokenを保存し、「社内タスク」カレンダーを作る。
--   タスクの変更(依頼・期限・担当・ステータス・キャンセル)をトリガーが検知
--   → Edge Function「task-google-sync」が、担当者と依頼者のカレンダーの予定を作成・更新・削除する。
--
-- 認証情報(refresh_token)を持つテーブルは、RLSを有効にしてポリシーを1つも作らない = アプリからは一切読めない。

-- ============ 設定 ============
-- client_id は、Google Cloud で作ったOAuthクライアントのID(公開されても問題ない値)。
-- 下の insert のあと、次のように登録します(SETUP.md 参照):
--   insert into google_settings (key, value) values ('client_id', 'xxxx.apps.googleusercontent.com')
--   on conflict (key) do update set value = excluded.value;

create table if not exists google_settings (
  key text primary key,
  value text not null
);
alter table google_settings enable row level security;

insert into google_settings (key, value) values
  ('sync_url', 'https://krdwyfemepbbyrteyoeb.supabase.co/functions/v1/task-google-sync'),
  ('redirect_uri', 'https://krdwyfemepbbyrteyoeb.supabase.co/functions/v1/task-google-callback'),
  ('secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')),
  ('app_url', 'https://kojiroulab.github.io/kojiroulab-task-manager/'),
  ('calendar_name', '社内タスク')
on conflict (key) do nothing;

-- ============ 連携情報 ============

create table if not exists google_accounts (
  slug text primary key references employees(slug) on update cascade on delete cascade,
  refresh_token text not null,
  calendar_id text not null,
  connected_at timestamptz not null default now(),
  last_synced_at timestamptz,
  last_error text
);
alter table google_accounts enable row level security;

-- どのタスクが、誰のカレンダーのどの予定になっているか(task_idには外部キーを張らない:
-- タスクが削除された後も、対応する予定を消しに行くために記録を残す必要があるため)
create table if not exists google_events (
  task_id uuid not null,
  slug text not null,
  role text not null check (role in ('assignee', 'requester')),
  event_id text,
  updated_at timestamptz not null default now(),
  primary key (task_id, slug)
);
alter table google_events enable row level security;

-- 連携ボタンを押した本人であることを、Googleから戻ってきた時に確かめるための使い捨てコード
create table if not exists google_oauth_states (
  state text primary key,
  slug text not null,
  created_at timestamptz not null default now()
);
alter table google_oauth_states enable row level security;

-- ============ Edge Functionを呼ぶ(内部用) ============

create or replace function google_sync_request(p_payload jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_url text; v_secret text;
begin
  select value into v_url from google_settings where key = 'sync_url';
  select value into v_secret from google_settings where key = 'secret';
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(
    url := v_url,
    body := p_payload,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-secret', v_secret)
  );
exception when others then
  -- 連携が失敗しても、タスクの操作そのものは失敗させない
  raise warning 'google_sync_request failed: %', sqlerrm;
end $$;

-- ============ タスク変更のトリガー ============
-- 関係する人の誰かがGoogle連携済み、または既に予定が作られているタスクだけ、Edge Functionを呼ぶ。

create or replace function tasks_google_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare r tasks;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  if exists (select 1 from google_accounts where slug in (r.assignee_slug, r.requester_slug))
     or exists (select 1 from google_events where task_id = r.id) then
    perform google_sync_request(jsonb_build_object('task_id', r.id, 'deleted', tg_op = 'DELETE'));
  end if;
  return r;
end $$;

drop trigger if exists tasks_google_sync_insdel on tasks;
create trigger tasks_google_sync_insdel after insert or delete on tasks
  for each row execute function tasks_google_sync();

drop trigger if exists tasks_google_sync_upd on tasks;
create trigger tasks_google_sync_upd after update of title, description, due_date, priority, status, assignee_slug on tasks
  for each row execute function tasks_google_sync();

-- ============ アプリから呼ぶ関数(本人の分だけ) ============

-- 連携の状態(トークンそのものは返さない)
create or replace function google_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_slug text := current_slug(); a google_accounts;
begin
  if v_slug is null then raise exception 'ログインしてください'; end if;
  select * into a from google_accounts where slug = v_slug;
  return jsonb_build_object(
    'configured', exists (select 1 from google_settings where key = 'client_id'),
    'connected', a.slug is not null,
    'connected_at', a.connected_at,
    'last_synced_at', a.last_synced_at,
    'last_error', a.last_error
  );
end $$;

-- 連携を始める: 使い捨てコード(state)と、Googleの認可URLを作るのに必要な公開情報を返す
create or replace function google_begin_connect() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_slug text := current_slug(); v_state text; v_client text; v_redirect text;
begin
  if v_slug is null then raise exception 'ログインしてください'; end if;
  select value into v_client from google_settings where key = 'client_id';
  select value into v_redirect from google_settings where key = 'redirect_uri';
  if v_client is null then raise exception 'Googleカレンダー連携は、まだ管理者の設定が完了していません'; end if;
  delete from google_oauth_states where created_at < now() - interval '1 hour';
  v_state := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into google_oauth_states (state, slug) values (v_state, v_slug);
  return jsonb_build_object('state', v_state, 'client_id', v_client, 'redirect_uri', v_redirect);
end $$;

-- 連携を解除する: Edge Functionが、作った「社内タスク」カレンダーごと削除し、トークンを取り消す
create or replace function google_disconnect() returns void
language plpgsql security definer set search_path = public as $$
declare v_slug text := current_slug();
begin
  if v_slug is null then raise exception 'ログインしてください'; end if;
  if not exists (select 1 from google_accounts where slug = v_slug) then return; end if;
  perform google_sync_request(jsonb_build_object('event', 'disconnect', 'slug', v_slug));
end $$;

revoke execute on function google_status() from public, anon;
revoke execute on function google_begin_connect() from public, anon;
revoke execute on function google_disconnect() from public, anon;
grant execute on function google_status() to authenticated;
grant execute on function google_begin_connect() to authenticated;
grant execute on function google_disconnect() to authenticated;
revoke execute on function google_sync_request(jsonb) from public, anon, authenticated;
