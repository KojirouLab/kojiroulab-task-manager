-- 担当者も期限を変更できるようにするSQL。
-- 既にSupabaseプロジェクトを作成済みの場合は、SQL Editorでこの内容を実行してください。
-- (これから新規にセットアップする場合は supabase.sql に含まれているので不要です。)
--
-- これまでは「タスクの内容(タイトル・担当者・メモ・期限)を変えられるのは依頼者だけ」
-- という扱いだったが、期限だけは担当者も変えられるようにする。
-- タイトル・担当者・メモは引き続き依頼者だけが変更できる。

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
    or new.assignee_slug <> old.assignee_slug
  ) then
    raise exception 'タスクの内容を変更できるのは依頼者だけです';
  end if;
  if new.due_date is distinct from old.due_date and me <> old.requester_slug and me <> old.assignee_slug then
    raise exception '期限を変更できるのは依頼者または担当者だけです';
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
