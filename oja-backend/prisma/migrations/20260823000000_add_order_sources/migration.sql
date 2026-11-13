-- Checkout `origin` attribute tags: revenue-by-channel attribution
-- (analytics enrichment). STOREFRONT/POS keep their existing meanings.

ALTER TYPE "OrderSource" ADD VALUE 'DIRECT';
ALTER TYPE "OrderSource" ADD VALUE 'SOCIAL';
ALTER TYPE "OrderSource" ADD VALUE 'MARKETPLACE';
ALTER TYPE "OrderSource" ADD VALUE 'REFERRAL';
