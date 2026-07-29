# ADR 0001 — Force the Postgres cluster to C.UTF-8

**Status:** accepted, 2026-07-29

## Context

The first build installed `postgresql` on a minimal Debian 12 container with no
locale configured. Debian initialised the cluster with locale `C`, which sets the
default encoding to **SQL_ASCII**.

The collector then failed mid-fleet:

```
UnicodeEncodeError: 'ascii' codec can't encode character '\u2192'
```

A Unicode arrow in a repo description. The sync had written 6 of 29 repos and
aborted, so every repo alphabetically after the failure was simply absent — and
the failure looked like a collector bug rather than a database one.

## Decision

Force `C.UTF-8` at cluster creation. `install.sh` inspects `template1`'s encoding
and, if it is not UTF8, runs `pg_dropcluster` / `pg_createcluster --locale=C.UTF-8`
before creating the database.

## Alternatives rejected

**Client-side encoding only.** `conn.set_client_encoding("UTF8")` makes psycopg2
send UTF-8 bytes, which a SQL_ASCII server stores verbatim. It works, and it was
used as a stopgap. But SQL_ASCII performs no encoding validation, byte-orders
non-ASCII text, and produces mojibake across dump/restore with a different client
encoding. A latent wart, not a fix.

## Consequences

Encoding is fixed at creation and cannot be altered, so getting this wrong means
a rebuild. Doing it in `install.sh` makes it unskippable. Verified: repo
descriptions containing non-ASCII now store and render correctly.
