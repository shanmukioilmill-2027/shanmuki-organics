-- Shanmuki Organics: non-destructive category image alignment metadata.
-- Run in Supabase SQL Editor BEFORE deploying the updated Edge Function and frontend.
-- This adds one public display-only JSONB field; it does not change RLS grants.
ALTER TABLE public.categories
  ADD COLUMN IF NOT EXISTS image_alignment JSONB NOT NULL
  DEFAULT '{"scale":100,"x":0,"y":0}'::jsonb;

-- Existing category records automatically use the default alignment.
-- Verify without changing data:
-- SELECT slug, name, image_alignment FROM public.categories ORDER BY order_index;
