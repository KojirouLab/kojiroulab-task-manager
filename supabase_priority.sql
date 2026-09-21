-- タスクに「重要度」(A=高 / B=中 / C=低)を追加する。SQL Editor に貼り付けて実行してください。
-- 既存のタスクがある場合は、すべて B(中)になります。何度実行しても問題ありません。

alter table tasks add column if not exists priority text not null default 'B';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_priority_check') then
    alter table tasks add constraint tasks_priority_check check (priority in ('A', 'B', 'C'));
  end if;
end $$;

-- 重要度を変えられるのは、タスクの内容と同じく依頼者だけ
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
    or new.priority <> old.priority
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
