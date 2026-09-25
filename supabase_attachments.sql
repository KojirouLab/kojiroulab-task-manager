-- タスク依頼時に画像・添付ファイルを付けられるようにするSQL。
-- supabase.sql (と supabase_admin.sql) を実行済みのプロジェクトで、SQL Editor に貼り付けて実行してください。

-- ============ ストレージバケット ============
-- 非公開バケット。ファイルの実体はここに入り、URLを知っているだけではアクセスできない
-- (下のstorage.objectsポリシーで、そのタスクの関係者だけがアクセスできるようにしている)。

insert into storage.buckets (id, name, public)
values ('task-attachments', 'task-attachments', false)
on conflict (id) do nothing;

-- パスの決まり: "{タスクのid}/{ファイル名}" という形式で保存する前提。
-- (storage.foldername(name))[1] が先頭フォルダ = タスクid になる。

create policy "task-attachments storage select" on storage.objects for select to authenticated
  using (
    bucket_id = 'task-attachments'
    and exists (
      select 1 from tasks t
      where t.id::text = (storage.foldername(name))[1]
        and (is_admin() or t.requester_slug = current_slug() or t.assignee_slug = current_slug())
    )
  );

create policy "task-attachments storage insert" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'task-attachments'
    and exists (
      select 1 from tasks t
      where t.id::text = (storage.foldername(name))[1]
        and (t.requester_slug = current_slug() or t.assignee_slug = current_slug())
    )
  );

create policy "task-attachments storage delete" on storage.objects for delete to authenticated
  using (
    bucket_id = 'task-attachments'
    and exists (
      select 1 from tasks t
      where t.id::text = (storage.foldername(name))[1]
        and (is_admin() or t.requester_slug = current_slug() or t.assignee_slug = current_slug())
    )
  );

-- ============ 添付ファイルの一覧テーブル ============
-- ストレージ本体とは別に、どのタスクにどのファイルが付いているか(元のファイル名等)を持つ。

create table if not exists task_attachments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null,
  content_type text,
  uploaded_by text not null references employees(slug),
  created_at timestamptz not null default now()
);

alter table task_attachments enable row level security;

create policy "task_attachments select" on task_attachments for select to authenticated
  using (
    is_admin()
    or exists (select 1 from tasks t where t.id = task_id and (t.requester_slug = current_slug() or t.assignee_slug = current_slug()))
  );

create policy "task_attachments insert" on task_attachments for insert to authenticated
  with check (
    uploaded_by = current_slug()
    and exists (select 1 from tasks t where t.id = task_id and (t.requester_slug = current_slug() or t.assignee_slug = current_slug()))
  );

create policy "task_attachments delete" on task_attachments for delete to authenticated
  using (
    is_admin() or uploaded_by = current_slug()
  );
