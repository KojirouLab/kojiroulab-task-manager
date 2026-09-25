-- タスク依頼時に「繰り返し」を設定できるようにするSQL。
-- supabase.sql を実行済みのプロジェクトで、SQL Editor に貼り付けて実行してください。
--
-- taskdesk(個人用タスクアプリ)と同じ考え方: 完了にした時点で、次回分のタスクを
-- 自動でもう1件作る(未来の回をあらかじめ全部作っておくわけではない)。
-- 次回の日付の計算はアプリ側(JavaScript)で行うため、ここでは列を追加するだけでよい。

alter table tasks add column if not exists repeat text
  check (repeat is null or repeat in (
    'daily', 'weekly', 'weeklyMulti', 'monthlyDate', 'monthlyNth',
    'monthlyLastWeekday', 'monthlyFirstDay', 'monthlyLastDay', 'monthlyLastBusinessDay'
  ));
alter table tasks add column if not exists repeat_weekdays int[];
-- 繰り返しパターンの基準日。「今回だけ日付を動かす」と「今後もこの日を基準にする」を
-- 区別するために、期限日(due_date)とは別に持つ(taskdeskのrepeatAnchorDateと同じ)。
alter table tasks add column if not exists repeat_anchor_date date;
