-- Discord(DM)通知用のSQL。supabase.sql / supabase_admin.sql / supabase_priority.sql を実行したあとに、
-- SQL Editor で実行してください。何度実行しても問題ありません。
--
-- 仕組み:
--   タスクの変更(依頼・担当変更・確認済み・完了・コメント)をトリガーが検知 → Edge Function「task-notify」を呼ぶ
--   → Edge Function が、宛先の人のDiscordへBotからDMを送る。
--   期限の前日・期限切れは、毎朝8時(日本時間)にpg_cronが判定して同じ仕組みで送る。
--   通知の成否は notify_log に残り、管理者の画面(メンバー管理)から確認できる。

-- ============ 社員ごとのDiscord情報 ============

alter table employees add column if not exists discord_user_id text;
alter table employees add column if not exists discord_dm_channel_id text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'employees_discord_user_id_check') then
    alter table employees add constraint employees_discord_user_id_check
      check (discord_user_id is null or discord_user_id ~ '^[0-9]{15,25}$');
  end if;
end $$;

-- ============ 設定(Edge FunctionのURLと、呼び出しの合言葉) ============
-- RLSを有効にして、ポリシーを1つも作らない = アプリ(anon/ログイン済み)からは一切読めない。
-- 合言葉(secret)は、この関数がEdge Functionを呼ぶときにだけ使う。

create table if not exists notify_settings (
  key text primary key,
  value text not null
);
alter table notify_settings enable row level security;

insert into notify_settings (key, value) values
  ('function_url', 'https://krdwyfemepbbyrteyoeb.supabase.co/functions/v1/task-notify'),
  ('secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')),
  ('app_url', 'https://kojiroulab.github.io/kojiroulab-task-manager/')
on conflict (key) do nothing;

-- ============ 通知の記録(成功/失敗) ============

create table if not exists notify_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  event text not null,
  to_slug text,
  task_id uuid,
  ok boolean not null,
  detail text
);
create index if not exists notify_log_to_slug_idx on notify_log(to_slug, created_at desc);
alter table notify_log enable row level security;

drop policy if exists "notify_log admin read" on notify_log;
create policy "notify_log admin read" on notify_log for select to authenticated using (is_admin());

-- ============ Edge Functionを呼ぶ関数 ============

create or replace function notify_task_event(
  p_event text, p_task_id uuid, p_actor text default null, p_comment text default null, p_to text default null
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_url text; v_secret text;
begin
  select value into v_url from notify_settings where key = 'function_url';
  select value into v_secret from notify_settings where key = 'secret';
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(
    url := v_url,
    body := jsonb_build_object('event', p_event, 'task_id', p_task_id, 'actor', p_actor, 'comment', p_comment, 'to', p_to),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', v_secret)
  );
exception when others then
  -- 通知が失敗しても、タスクの操作そのものは失敗させない
  raise warning 'notify_task_event failed: %', sqlerrm;
end $$;

-- ============ トリガー ============

create or replace function tasks_notify_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform notify_task_event('created', new.id, new.requester_slug);
  return new;
end $$;

drop trigger if exists tasks_notify_insert on tasks;
create trigger tasks_notify_insert after insert on tasks
  for each row execute function tasks_notify_insert();

create or replace function tasks_notify_reassign() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.assignee_slug <> old.assignee_slug then
    perform notify_task_event('reassigned', new.id, current_slug());
  end if;
  return new;
end $$;

drop trigger if exists tasks_notify_reassign on tasks;
create trigger tasks_notify_reassign after update of assignee_slug on tasks
  for each row execute function tasks_notify_reassign();

create or replace function task_updates_notify() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = '確認済み' then
    perform notify_task_event('confirmed', new.task_id, new.employee_slug);
  elsif new.status = '完了' then
    perform notify_task_event('completed', new.task_id, new.employee_slug);
  elsif new.status is null and coalesce(new.comment, '') <> '' then
    perform notify_task_event('comment', new.task_id, new.employee_slug, new.comment);
  end if;
  return new;
end $$;

drop trigger if exists task_updates_notify on task_updates;
create trigger task_updates_notify after insert on task_updates
  for each row execute function task_updates_notify();

-- ============ 期限の前日・期限切れ(毎朝8時・日本時間) ============

create or replace function notify_task_deadlines() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  t record;
begin
  for t in
    select id, due_date from tasks
    where status <> '完了' and due_date is not null and due_date in (v_today + 1, v_today - 1)
  loop
    perform notify_task_event(case when t.due_date > v_today then 'due_tomorrow' else 'overdue' end, t.id);
  end loop;
end $$;

-- pg_cron は UTC。日本時間の朝8時 = UTC 23:00(前日)
do $$
begin
  if exists (select 1 from cron.job where jobname = 'task-manager-deadlines') then
    perform cron.unschedule('task-manager-deadlines');
  end if;
  perform cron.schedule('task-manager-deadlines', '0 23 * * *', 'select notify_task_deadlines()');
end $$;

-- ============ 管理者の画面から使う関数 ============

create or replace function admin_set_discord(p_slug text, p_discord_user_id text) returns void
language plpgsql security definer set search_path = public as $$
declare v_id text := nullif(trim(coalesce(p_discord_user_id, '')), '');
begin
  if not is_admin() then raise exception '管理者だけが実行できます'; end if;
  if not exists (select 1 from employees where slug = p_slug) then raise exception 'その社員は登録されていません'; end if;
  if v_id is not null and v_id !~ '^[0-9]{15,25}$' then
    raise exception 'DiscordユーザーIDは15〜25桁の数字です(ユーザー名や表示名ではありません)';
  end if;
  update employees set discord_user_id = v_id, discord_dm_channel_id = null where slug = p_slug;
end $$;

create or replace function admin_send_test_notification(p_slug text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception '管理者だけが実行できます'; end if;
  if not exists (select 1 from employees where slug = p_slug and discord_user_id is not null) then
    raise exception 'DiscordユーザーIDが登録されていません';
  end if;
  perform notify_task_event('test', null, current_slug(), null, p_slug);
end $$;

revoke execute on function admin_set_discord(text, text) from public, anon;
revoke execute on function admin_send_test_notification(text) from public, anon;
grant execute on function admin_set_discord(text, text) to authenticated;
grant execute on function admin_send_test_notification(text) to authenticated;

-- 通知の呼び出し用関数は、アプリ(ログイン済みの人)からは直接呼べないようにする
revoke execute on function notify_task_event(text, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function notify_task_deadlines() from public, anon, authenticated;
