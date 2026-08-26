-- The paid board is gone.
--
-- v2 sold ranked listings through PayPal alongside the free high scores. The
-- game is the product, so the auction, the claim flow and the PayPal
-- integration have all been removed; this drops the table they wrote to.
--
-- `scores.url` was the optional link a top-3 run could hang off its slot on
-- that board. Nothing renders it any more, but the column stays: SQLite makes
-- dropping a column a table rebuild, and an unread nullable column costs
-- nothing.

DROP INDEX IF EXISTS idx_banner_rank;
DROP INDEX IF EXISTS idx_banner_live;
DROP TABLE IF EXISTS banner_claims;
