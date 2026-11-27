-- Shanmuki Organics v14: allow nested categories at any depth.
-- Run AFTER the original v11 parent_slug migration and BEFORE deploying v14.
-- Non-destructive: preserves category rows, product links, IDs, slugs, RLS,
-- authentication, cart, payment and image alignment settings.
BEGIN;

-- Remove the old one-level-only validation trigger introduced by v11.
DROP TRIGGER IF EXISTS trg_categories_one_level_hierarchy ON public.categories;

-- Prevent placing a category under itself or any descendant at any depth.
-- The original FK keeps parent_slug referencing a real category slug.
CREATE OR REPLACE FUNCTION public.enforce_nested_category_no_cycles()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  creates_cycle BOOLEAN;
BEGIN
  IF NEW.parent_slug IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.parent_slug = NEW.slug THEN
    RAISE EXCEPTION 'A category cannot be its own parent' USING ERRCODE = '23514';
  END IF;

  WITH RECURSIVE ancestors(slug, parent_slug) AS (
    SELECT c.slug, c.parent_slug
      FROM public.categories AS c WHERE c.slug = NEW.parent_slug
    UNION
    SELECT c.slug, c.parent_slug
      FROM public.categories AS c
      JOIN ancestors a ON c.slug = a.parent_slug
  )
  SELECT EXISTS(SELECT 1 FROM ancestors WHERE slug = NEW.slug)
    INTO creates_cycle;

  IF creates_cycle THEN
    RAISE EXCEPTION 'Category hierarchy cycle is not allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_categories_nested_no_cycles ON public.categories;
CREATE TRIGGER trg_categories_nested_no_cycles
  BEFORE INSERT OR UPDATE OF parent_slug, slug ON public.categories
  FOR EACH ROW EXECUTE FUNCTION public.enforce_nested_category_no_cycles();
COMMIT;

-- Confirm trigger + hierarchy after migration (read only):
SELECT slug, name, parent_slug FROM public.categories ORDER BY order_index, name;
