-- Shared public-facing store information. Visitors may read; ONLY the
-- service-role-backed Edge Function may modify it after admin verification.
create table if not exists public.storefront_settings (
  id smallint primary key default 1 check (id = 1),
  store_name text not null check (char_length(store_name) between 1 and 120),
  store_email text not null check (char_length(store_email) between 3 and 254),
  store_phone text not null check (char_length(store_phone) between 6 and 32),
  address text not null check (char_length(address) between 1 and 500),
  currency text not null default 'INR' check (currency in ('INR','USD')),
  tax_rate numeric(5,2) not null default 5 check (tax_rate between 0 and 100),
  free_ship_min integer not null default 999 check (free_ship_min between 0 and 10000000),
  enable_cod boolean not null default true,
  enable_online boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into public.storefront_settings
 (id, store_name, store_email, store_phone, address, currency, tax_rate,
  free_ship_min, enable_cod, enable_online)
values
 (1, 'Shanmuki Organics', 'shanmukioilmill@gmail.com', '+91 866 775 8694',
  'Dharapuram Road, Erode, Tamil Nadu - 638 004', 'INR', 5, 999, true, true)
on conflict (id) do nothing;
alter table public.storefront_settings enable row level security;
revoke all on table public.storefront_settings from PUBLIC, anon, authenticated;
grant select on table public.storefront_settings to anon, authenticated;
grant select, insert, update on table public.storefront_settings to service_role;
drop policy if exists public_storefront_settings_read on public.storefront_settings;
create policy public_storefront_settings_read on public.storefront_settings
  for select to anon, authenticated using (id = 1);
-- No INSERT / UPDATE / DELETE policies for anon or authenticated.
