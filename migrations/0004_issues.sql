-- Open issues and pull requests across the fleet.
--
-- Collected with ONE search call per run (user:<owner> is:open), not one call
-- per repo. The collector already spends ~44 of its 45 free-tier subrequests
-- on the repo slice, so a per-repo endpoint would not fit; search returns the
-- whole account's open set, private repos included, in a single request.
--
-- The point of this table is one distinction: who opened it. An issue from
-- someone other than the owner is the strongest adoption signal the fleet can
-- produce -- stronger than clones (machines) or downloads (mostly machines).
-- author_kind records it: 'owner', 'external' (a human who is not the owner),
-- or 'bot' (Dependabot and friends, which are not users either).
--
-- Titles and logins are untrusted third-party text and are escaped on render.

CREATE TABLE IF NOT EXISTS issues (
  repo        TEXT    NOT NULL,          -- repo name, from repository_url
  number      INTEGER NOT NULL,
  is_pr       INTEGER NOT NULL DEFAULT 0,
  title       TEXT,
  author      TEXT,
  author_kind TEXT    NOT NULL,          -- owner | external | bot
  association TEXT,                      -- GitHub author_association, verbatim
  state       TEXT    NOT NULL,          -- open | closed
  comments    INTEGER NOT NULL DEFAULT 0,
  html_url    TEXT,
  created_at  TEXT,
  updated_at  TEXT,
  first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (repo, number)
);

CREATE INDEX IF NOT EXISTS idx_issues_open ON issues(state, author_kind);
