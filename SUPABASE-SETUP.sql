create table if not exists public.profit_sync (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Supabase grants default privileges to `anon`/`authenticated` for new tables
-- created through the dashboard, but projects with changed defaults need this.
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.profit_sync to authenticated;

alter table public.profit_sync enable row level security;

create policy "Users can read their own finance data"
on public.profit_sync for select
to authenticated
using (auth.uid() = user_id);

create policy "Users can insert their own finance data"
on public.profit_sync for insert
to authenticated
with check (auth.uid() = user_id);

create policy "Users can update their own finance data"
on public.profit_sync for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);


create or replace function public.set_profit_sync_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profit_sync_updated_at on public.profit_sync;
create trigger profit_sync_updated_at
before update on public.profit_sync
for each row execute function public.set_profit_sync_updated_at();
