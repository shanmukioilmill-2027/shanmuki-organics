-- Optional visual alignment settings for the Below Featured banner slider.
-- Apply once in the SAME Supabase database used by the storefront and admin.
-- Safe additive migration: existing banners/images/status/order are preserved.
alter table public.banners
  add column if not exists image_settings jsonb not null default '{}'::jsonb;

-- Existing public RLS allows SELECT only for active banners; do not grant
-- any customer INSERT/UPDATE/DELETE permission for this new field.
