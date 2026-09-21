-- Supabase の SQL Editor にこの内容を貼り付けて実行してください。
--
-- 認証の考え方:
--   ・各社員は Supabase Auth のユーザー(メール=「slug@ドメイン」、パスワード=その人のパスコード)として登録する。
--   ・employees テーブルの slug と、ログインメールの「@より前」が一致する人が、その社員として扱われる。
--   ・employees.is_admin = true の人は、全員のタスクを読める(管理者)。
--   ・ログインしていない人(anon)は、名前の一覧(employee_directory)以外は一切読み書きできない。

-- ============ テーブル ============

create table if not exists employees (
  slug text primary key check (slug ~ '^[a-z0-9-]+$'),
  name text not null,
  is_admin boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  requester_slug text not null references employees(slug) on update cascade,
  assignee_slug text not null references employees(slug) on update cascade,
  status text not null default '未確認' check (status in ('未確認', '確認済み', '完了')),
  due_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists task_updates (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  employee_slug text not null references employees(slug) on update cascade,
  status text,
  comment text,
  created_at timestamptz not null default now()
);

create index if not exists tasks_requester_slug_idx on tasks(requester_slug);
create index if not exists tasks_assignee_slug_idx on tasks(assignee_slug);
create index if not exists task_updates_task_id_idx on task_updates(task_id);

-- ============ 「今ログインしているのは誰か」を返す関数 ============

create or replace function current_slug() returns text
language sql stable security definer set search_path = public as $$
  select e.slug from employees e
  where e.slug = split_part(lower(coalesce(auth.jwt() ->> 'email', '')), '@', 1)
$$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select e.is_admin from employees e where e.slug = current_slug()), false)
$$;

-- ============ ログイン画面用の名前一覧(名前とslugだけ。管理者フラグは出さない) ============

create or replace view employee_directory as
  select slug, name, sort_order from employees;

grant select on employee_directory to anon, authenticated;

-- ============ アクセス制御(RLS) ============

alter table employees enable row level security;
alter table tasks enable row level security;
alter table task_updates enable row level security;

-- employees: ログイン済みなら全員の名前を読める(担当者の選択に必要)。書き換えはSQL Editorからのみ。
create policy "employees read" on employees for select to authenticated using (true);

-- tasks: 自分が依頼した/受けたタスク、または管理者は全部
create policy "tasks read" on tasks for select to authenticated
  using (is_admin() or requester_slug = current_slug() or assignee_slug = current_slug());

create policy "tasks insert" on tasks for insert to authenticated
  with check (requester_slug = current_slug());

create policy "tasks update" on tasks for update to authenticated
  using (requester_slug = current_slug() or assignee_slug = current_slug());

create policy "tasks delete" on tasks for delete to authenticated
  using (requester_slug = current_slug());

-- task_updates: 見えるタスクのやり取りだけ読める。書き込みは自分名義のみ。
create policy "task_updates read" on task_updates for select to authenticated
  using (exists (select 1 from tasks t where t.id = task_id));

create policy "task_updates insert" on task_updates for insert to authenticated
  with check (
    employee_slug = current_slug()
    and exists (select 1 from tasks t where t.id = task_id)
    -- ステータス変更ログは担当者だけが残せる(コメントだけなら見えるタスクなら誰でも可、管理者含む)
    and (status is null or exists (select 1 from tasks t where t.id = task_id and t.assignee_slug = current_slug()))
  );

-- ============ 更新できる項目の制限 ============
-- RLS は列単位で制限できないため、トリガーで守る:
--   ・依頼者だけが 内容/担当者/期限/メモ を変えられる(依頼者そのものは変更不可)
--   ・担当者だけが ステータス/完了日時 を変えられる
-- SQL Editor などJWTなしの操作(current_slug() が null)は制限しない。

create or replace function tasks_update_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare me text := current_slug();
begin
  if me is null then
    return new;
  end if;
  if new.requester_slug <> old.requester_slug then
    raise exception '依頼者は変更できません';
  end if;
  if me <> old.requester_slug and (
    new.title <> old.title or new.description <> old.description
    or new.assignee_slug <> old.assignee_slug or new.due_date is distinct from old.due_date
  ) then
    raise exception 'タスクの内容を変更できるのは依頼者だけです';
  end if;
  if me <> old.assignee_slug and (
    new.status <> old.status or new.completed_at is distinct from old.completed_at
  ) then
    raise exception 'ステータスを変更できるのは担当者だけです';
  end if;
  return new;
end $$;

drop trigger if exists tasks_update_guard on tasks;
create trigger tasks_update_guard before update on tasks
  for each row execute function tasks_update_guard();

-- ============ 最初の社員登録(例) ============
-- 下の例を実際の名前に書き換えて実行してください(SETUP.md 参照)。
-- 管理者にしたい人は is_admin を true にします。
--
-- insert into employees (slug, name, is_admin, sort_order) values
--   ('tanaka', '田中', true, 1),
--   ('suzuki', '鈴木', false, 2);
