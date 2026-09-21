-- 管理者ページ(メンバー管理)用のSQL。supabase.sql を実行したあとに、SQL Editor で実行してください。
--
-- ・管理者(employees.is_admin = true)だけが呼べる関数で、社員の追加・変更・パスコードのリセットを行う。
-- ・ログイン用ユーザー(auth.users)の作成もこの関数の中で行うため、Supabaseの管理画面を触る必要がなくなる。
-- ・退職などで使わなくなった人は「利用停止」にする(タスクの記録は残り、ログインできなくなる)。

alter table employees add column if not exists active boolean not null default true;

-- 利用停止中の人は「社員」として扱わない(ログイン済みの端末でも即座に何も見えなくなる)
create or replace function current_slug() returns text
language sql stable security definer set search_path = public as $$
  select e.slug from employees e
  where e.active
    and e.slug = split_part(lower(coalesce(auth.jwt() ->> 'email', '')), '@', 1)
$$;

-- ログイン画面の名前一覧は、利用中の人だけ
create or replace view employee_directory as
  select slug, name, sort_order from employees where active;

-- ============ 社員の追加 ============

create or replace function admin_add_employee(p_slug text, p_name text, p_passcode text, p_is_admin boolean default false)
returns void
language plpgsql security definer set search_path = public, auth, extensions as $$
declare
  v_id uuid := gen_random_uuid();
  v_domain text := split_part(lower(coalesce(auth.jwt() ->> 'email', '')), '@', 2);
  v_email text;
begin
  if not is_admin() then raise exception '管理者だけが実行できます'; end if;
  p_slug := lower(trim(coalesce(p_slug, '')));
  p_name := trim(coalesce(p_name, ''));
  if p_name = '' then raise exception '名前を入力してください'; end if;
  if p_slug !~ '^[a-z0-9-]+$' then raise exception 'ログインIDは半角の英小文字・数字・ハイフンだけにしてください'; end if;
  if length(coalesce(p_passcode, '')) < 8 then raise exception '仮のパスコードは8文字以上にしてください'; end if;
  if exists (select 1 from employees where slug = p_slug) then raise exception 'そのログインIDはすでに使われています'; end if;

  v_email := p_slug || '@' || v_domain;
  if exists (select 1 from auth.users where lower(email) = v_email) then
    raise exception 'そのログインIDのユーザーがすでに存在します';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
    crypt(p_passcode, gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
    '', '', '', ''
  );

  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (
    gen_random_uuid(), v_id, v_id::text,
    jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true, 'phone_verified', false),
    'email', now(), now(), now()
  );

  insert into employees (slug, name, is_admin, sort_order)
  values (p_slug, p_name, coalesce(p_is_admin, false), coalesce((select max(sort_order) from employees), 0) + 1);
end $$;

-- ============ 名前・管理者・利用停止の変更 ============

create or replace function admin_update_employee(p_slug text, p_name text, p_is_admin boolean, p_active boolean)
returns void
language plpgsql security definer set search_path = public, auth, extensions as $$
declare v_uid uuid;
begin
  if not is_admin() then raise exception '管理者だけが実行できます'; end if;
  if not exists (select 1 from employees where slug = p_slug) then raise exception 'その社員は登録されていません'; end if;
  if trim(coalesce(p_name, '')) = '' then raise exception '名前を入力してください'; end if;
  if p_slug = current_slug() and (not p_is_admin or not p_active) then
    raise exception 'ご自身の管理者権限を外したり、利用を停止したりはできません';
  end if;

  update employees set name = trim(p_name), is_admin = p_is_admin, active = p_active where slug = p_slug;

  select id into v_uid from auth.users where split_part(lower(email), '@', 1) = p_slug limit 1;
  if v_uid is not null then
    update auth.users set banned_until = case when p_active then null else 'infinity'::timestamptz end where id = v_uid;
    if not p_active then
      delete from auth.sessions where user_id = v_uid;
    end if;
  end if;
end $$;

-- ============ パスコードのリセット(本人は次回ログイン時にまた自分で決め直す) ============

create or replace function admin_reset_passcode(p_slug text, p_passcode text)
returns void
language plpgsql security definer set search_path = public, auth, extensions as $$
declare v_uid uuid;
begin
  if not is_admin() then raise exception '管理者だけが実行できます'; end if;
  if length(coalesce(p_passcode, '')) < 8 then raise exception '仮のパスコードは8文字以上にしてください'; end if;
  select id into v_uid from auth.users where split_part(lower(email), '@', 1) = p_slug limit 1;
  if v_uid is null then raise exception 'その社員のログイン用ユーザーが見つかりません'; end if;

  update auth.users
    set encrypted_password = crypt(p_passcode, gen_salt('bf')),
        raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) - 'passcode_changed',
        updated_at = now()
    where id = v_uid;
  delete from auth.sessions where user_id = v_uid;
end $$;

-- 関数は、ログイン済みの人だけが呼べる(中で管理者かどうかも必ず確認している)
revoke execute on function admin_add_employee(text, text, text, boolean) from public, anon;
revoke execute on function admin_update_employee(text, text, boolean, boolean) from public, anon;
revoke execute on function admin_reset_passcode(text, text) from public, anon;
grant execute on function admin_add_employee(text, text, text, boolean) to authenticated;
grant execute on function admin_update_employee(text, text, boolean, boolean) to authenticated;
grant execute on function admin_reset_passcode(text, text) to authenticated;
