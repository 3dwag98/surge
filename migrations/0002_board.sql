-- The banner becomes a board.
--
-- v1 had a single slot: one 'live' row at a time, and a lower bid was refunded
-- into an 'outbid' dead end. v2 seats everyone who paid, ranked by what they
-- paid, so there is no losing bid — only a lower rank.

-- The grey second line of a listing. v1 rows had only the bold line.
ALTER TABLE banner_claims ADD COLUMN tagline TEXT NOT NULL DEFAULT '';

-- Nobody is evicted any more, so every claim that actually cleared is live.
UPDATE banner_claims SET status = 'live' WHERE status IN ('retired', 'outbid');

-- The board read is this exact ordering: most money first, earliest tie-break.
DROP INDEX IF EXISTS idx_banner_live;
CREATE INDEX IF NOT EXISTS idx_banner_rank
  ON banner_claims (status, amount_cents DESC, claimed_at ASC);

-- Side slots are won by playing, and the winner may hang a link off theirs.
ALTER TABLE scores ADD COLUMN url TEXT;
