-- ExecuBrief cloud persistence schema for a no-card/free-tier deployment.
-- Apply this file once in Supabase SQL Editor. All application tables are private;
-- the Node server accesses them with the server-only Supabase secret API key.

create table if not exists public.organizations (
  id uuid primary key,
  name text not null check (char_length(name) between 1 and 100),
  slug text not null unique,
  report_currency text check (report_currency is null or report_currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now()
);

create table if not exists public.app_users (
  id uuid primary key,
  email text not null,
  name text not null check (char_length(name) between 1 and 120),
  password_salt text,
  password_hash text,
  google_sub text unique,
  picture text,
  created_at timestamptz not null default now(),
  constraint app_users_password_pair check ((password_salt is null) = (password_hash is null))
);
create unique index if not exists app_users_email_lower_uq on public.app_users (lower(email));

create table if not exists public.organization_memberships (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.app_users(id) on delete cascade,
  role text not null check (role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index if not exists organization_memberships_user_idx on public.organization_memberships(user_id, created_at);

create table if not exists public.auth_sessions (
  token_hash text primary key,
  user_id uuid not null references public.app_users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  csrf_token text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists auth_sessions_expiry_idx on public.auth_sessions(expires_at);

create table if not exists public.workspace_imports (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_file text not null,
  file_sha256 text not null,
  storage_path text not null,
  mapping_json jsonb not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  rows_imported integer not null default 0 check (rows_imported >= 0),
  rows_skipped integer not null default 0 check (rows_skipped >= 0),
  rows_received integer not null default 0 check (rows_received >= 0),
  duplicates_skipped integer not null default 0 check (duplicates_skipped >= 0),
  invalid_rows integer not null default 0 check (invalid_rows >= 0),
  min_date date,
  max_date date,
  status text not null default 'completed' check (status in ('completed','partial','failed')),
  error text,
  imported_at timestamptz not null default now(),
  unique(organization_id, file_sha256)
);
create index if not exists workspace_imports_recent_idx on public.workspace_imports(organization_id, imported_at desc);

create table if not exists public.custom_reports (
  id uuid primary key,
  user_id uuid not null references public.app_users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_id uuid not null,
  title text not null,
  source_file text not null,
  storage_path text,
  row_count integer not null default 0 check (row_count >= 0),
  rows_received integer not null default 0 check (rows_received >= 0),
  duplicates_skipped integer not null default 0 check (duplicates_skipped >= 0),
  invalid_rows integer not null default 0 check (invalid_rows >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  start_date date,
  end_date date,
  status text not null check (status in ('pending','completed','failed')),
  summary_json jsonb,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists custom_reports_org_recent_idx on public.custom_reports(organization_id, created_at desc);

-- Keep all application tables inaccessible to public / browser roles. The Node
-- service uses SUPABASE_SECRET_KEY; never expose it in frontend code.
alter table public.organizations enable row level security;
alter table public.app_users enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.auth_sessions enable row level security;
alter table public.workspace_imports enable row level security;
alter table public.custom_reports enable row level security;
revoke all on public.organizations, public.app_users, public.organization_memberships,
  public.auth_sessions, public.workspace_imports, public.custom_reports from public, anon, authenticated;
grant all on public.organizations, public.app_users, public.organization_memberships,
  public.auth_sessions, public.workspace_imports, public.custom_reports to service_role;

-- The registration RPC is transactional so a partially created organisation cannot be left behind.
create or replace function public.execubrief_register_user(
  p_user_id uuid, p_organization_id uuid, p_email text, p_name text,
  p_password_salt text, p_password_hash text, p_organization_name text, p_slug text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare u public.app_users; o public.organizations;
begin
  if exists (select 1 from public.app_users where lower(email) = lower(p_email)) then
    raise exception using errcode = '23505', message = 'ExecuBrief account email already exists';
  end if;
  insert into public.organizations(id, name, slug, created_at)
    values (p_organization_id, p_organization_name, p_slug, now()) returning * into o;
  insert into public.app_users(id, email, name, password_salt, password_hash, created_at)
    values (p_user_id, lower(p_email), p_name, p_password_salt, p_password_hash, now()) returning * into u;
  insert into public.organization_memberships(organization_id, user_id, role, created_at)
    values (o.id, u.id, 'owner', now());
  return jsonb_build_object(
    'user', jsonb_build_object('id', u.id, 'email', u.email, 'name', u.name, 'picture', u.picture, 'created_at', u.created_at),
    'organization', jsonb_build_object('id', o.id, 'name', o.name, 'report_currency', o.report_currency)
  );
end;
$$;

create or replace function public.execubrief_google_user(
  p_user_id uuid, p_organization_id uuid, p_email text, p_name text,
  p_google_sub text, p_picture text, p_organization_name text, p_slug text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare u public.app_users; o public.organizations;
begin
  select * into u from public.app_users where google_sub = p_google_sub limit 1;
  if found then
    update public.app_users set name = p_name, picture = coalesce(p_picture, picture) where id = u.id returning * into u;
  else
    select * into u from public.app_users where lower(email) = lower(p_email) limit 1;
    if found then
      if u.google_sub is not null and u.google_sub <> p_google_sub then
        raise exception using errcode = '23505', message = 'This email is linked to another Google account';
      end if;
      update public.app_users set google_sub = p_google_sub, name = p_name, picture = coalesce(p_picture, picture)
        where id = u.id returning * into u;
    else
      insert into public.organizations(id, name, slug, created_at)
        values (p_organization_id, p_organization_name, p_slug, now()) returning * into o;
      insert into public.app_users(id, email, name, google_sub, picture, created_at)
        values (p_user_id, lower(p_email), p_name, p_google_sub, p_picture, now()) returning * into u;
      insert into public.organization_memberships(organization_id, user_id, role, created_at)
        values (o.id, u.id, 'owner', now());
    end if;
  end if;
  select org.* into o from public.organizations org
    join public.organization_memberships m on m.organization_id = org.id
    where m.user_id = u.id order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, m.created_at limit 1;
  if not found then
    insert into public.organizations(id, name, slug, created_at)
      values (p_organization_id, p_organization_name, p_slug, now()) returning * into o;
    insert into public.organization_memberships(organization_id, user_id, role, created_at)
      values (o.id, u.id, 'owner', now());
  end if;
  return jsonb_build_object(
    'user', jsonb_build_object('id', u.id, 'email', u.email, 'name', u.name, 'picture', u.picture, 'created_at', u.created_at),
    'organization', jsonb_build_object('id', o.id, 'name', o.name, 'report_currency', o.report_currency)
  );
end;
$$;

create or replace function public.execubrief_resolve_session(p_token_hash text)
returns jsonb
language sql stable security definer set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'csrf_token', s.csrf_token,
    'user', jsonb_build_object('id', u.id, 'email', u.email, 'name', u.name, 'picture', u.picture, 'created_at', u.created_at),
    'organization', jsonb_build_object('id', o.id, 'name', o.name, 'report_currency', o.report_currency)
  )
  from public.auth_sessions s
  join public.app_users u on u.id = s.user_id
  join public.organizations o on o.id = s.organization_id
  join public.organization_memberships m on m.organization_id = o.id and m.user_id = u.id
  where s.token_hash = p_token_hash and s.expires_at > now()
  limit 1;
$$;

revoke all on function public.execubrief_register_user(uuid,uuid,text,text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.execubrief_google_user(uuid,uuid,text,text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.execubrief_resolve_session(text) from public, anon, authenticated;
grant execute on function public.execubrief_register_user(uuid,uuid,text,text,text,text,text,text) to service_role;
grant execute on function public.execubrief_google_user(uuid,uuid,text,text,text,text,text,text) to service_role;
grant execute on function public.execubrief_resolve_session(text) to service_role;

-- Private object bucket for imported CSVs and generated PDFs. The service key is
-- server-only; browsers never receive direct credentials to this bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('execubrief-private', 'execubrief-private', false, 10485760, array['text/csv','application/csv','application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 10485760,
  allowed_mime_types = array['text/csv','application/csv','application/pdf'];
