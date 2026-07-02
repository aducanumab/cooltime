-- ============================================================
--  쿨타임 트래커 스키마 v1
--  Supabase 대시보드 > SQL Editor 에 전체를 붙여넣고 Run 하세요.
--  (여러 번 실행해도 안전하도록 작성됨)
-- ============================================================

-- 1) profiles — 회원 부가정보 (비밀번호는 여기 없음! Supabase Auth가 해시로 관리)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  default_cooldown_days int not null default 30 check (default_cooldown_days >= 0),
  timezone text not null default 'Asia/Seoul',
  created_at timestamptz not null default now()
);

-- 가입 시 profiles 행 자동 생성
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2) menus — 회원별 메뉴 + 쿨타임
create table if not exists public.menus (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  cooldown_days int not null default 30 check (cooldown_days >= 0),
  created_at timestamptz not null default now()
);

-- 회원 내에서 메뉴 이름(대소문자 무시) 중복 방지
create unique index if not exists menus_user_name_uniq
  on public.menus (user_id, lower(name));

-- 3) records — 먹은 기록
create table if not exists public.records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  menu_id uuid not null references public.menus(id) on delete cascade,
  eaten_on date not null,
  note text,
  nutrition jsonb,
  created_at timestamptz not null default now()
);

create index if not exists records_user_menu_idx
  on public.records (user_id, menu_id, eaten_on desc);

-- 4) RLS — 행 단위 보안: 본인 데이터만 접근 가능
--    (anon key가 공개되어도 안전한 이유가 바로 이 정책들)
alter table public.profiles enable row level security;
alter table public.menus    enable row level security;
alter table public.records  enable row level security;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "own menus" on public.menus;
create policy "own menus" on public.menus
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- records: 본인 행만 접근 + 삽입/수정 시 참조하는 menu도 본인 소유여야 함
-- (menu_id in (...) 검사가 없으면 남의 menu_id를 참조하는 기록을 만들 수 있음)
drop policy if exists "own records" on public.records;
create policy "own records" on public.records
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and menu_id in (select id from public.menus where user_id = auth.uid())
  );

-- 5) 회원 탈퇴 — 본인 계정 삭제 (cascade로 모든 데이터 함께 삭제)
create or replace function public.delete_own_account()
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function public.delete_own_account() from public, anon;
grant execute on function public.delete_own_account() to authenticated;
