-- 依頼者も「完了にする」ボタンを押せるようにする追加設定。
-- 既にSupabaseプロジェクトを作成済みの場合は、SQL Editorでこの内容を実行してください。
-- (これから新規にセットアップする場合は supabase.sql に含まれているので不要です。)

drop policy if exists "task_updates insert" on task_updates;
create policy "task_updates insert" on task_updates for insert to authenticated
  with check (
    employee_slug = current_slug()
    and exists (select 1 from tasks t where t.id = task_id)
    -- ステータス変更ログを残せるのは、担当者(確認・完了どちらも)、または
    -- 依頼者が完了にする場合のみ(コメントだけなら見えるタスクなら誰でも可、管理者含む)。
    and (
      status is null
      or exists (select 1 from tasks t where t.id = task_id and t.assignee_slug = current_slug())
      or (status = '完了' and exists (select 1 from tasks t where t.id = task_id and t.requester_slug = current_slug()))
    )
  );

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
  if new.status <> old.status or new.completed_at is distinct from old.completed_at then
    if me = old.assignee_slug then
      null; -- 担当者は確認・完了どちらも可能
    elsif me = old.requester_slug and new.status = '完了' then
      null; -- 依頼者は完了にすることだけ可能
    else
      raise exception 'ステータスを変更できるのは担当者、または完了にする場合は依頼者だけです';
    end if;
  end if;
  return new;
end $$;
