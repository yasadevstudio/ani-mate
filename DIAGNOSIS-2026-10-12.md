# ANI-MATE — Dragon Ball report, 2026-10-12

Reported: *"dragonball super does not show the beerus arc, you cant see the
season splits on earlier seasons, just the latest ones, a lot of issues."*

Measured against the live server on :7890. Four findings, and **three of them
are one bug.**

---

## FINDING 0 — THE REPORTED BUG. Searching "Dragon Ball Super" opens Dragon Ball Z

**`Dragon Ball Super: Beerus` is a new release, not an arc.** TV, 1 episode,
first aired **2026-10-11**. It is in the data, search returns it, and
`/episodes` returns episode 1, so it plays.

The problem is you cannot get to it. Searching `dragon ball super` returns a
**single franchise card** covering 12 entries, and tapping that card opens:

```
  >>> Dragon Ball Z   (1989-04-26, 291 episodes)
```

Beerus is chip 3 of 12 in the season strip, reachable only after landing on a
1989 series and noticing the strip exists.

**This is a v0.5.1 regression and it is mine.** `groupByFranchise()` sorts
members by format rank, then **date ascending**, and opens `members[0]`. I
changed it to oldest-first in v0.5.1 so Apothecary Diaries would open S1 rather
than S2. Correct for a three-season show. Wrong for a franchise where
`'dragon ball'` is a FRANCHISE_PATTERN prefix that unions forty years of
releases into one card — there, oldest-first means a search for a 2026 release
opens a 1989 series.

**The fix: the card should open the entry that best matches the QUERY, not the
oldest member.** `rankResults` already computes `search_score` on every result.
`members[0]` should be the highest-scoring member; the strip stays chronological.
Search "dragon ball super" and you land on Dragon Ball Super. Search "beerus"
and you land on Beerus. Search "apothecary diaries" with no season and the
highest scorer is still S1, so that fix is preserved rather than reverted.

---

## FINDING 0b — arcs inside a series do not exist

Distinct from the above, and worth recording since it came up. `/episodes` for
Dragon Ball Super returns **all 131 episodes as a flat array of numbers**. There
is no arc or saga concept in the payload, in AniList, or in AllAnime. A
long-running series renders as one undivided grid. That is a missing feature,
not a defect, and it needs either a curated table or a data source neither
provider offers.

---

## FINDING 1 — THE ROOT CAUSE. 27 of 40 entries inherit the 1986 original's data

Search `dragon ball` returns 40 results. **27 of them carry
`start_key = 19860226`** — the air date of the 1986 original — and **all 27 also
carry `anilist_format: "TV"`.**

| entry |真 format | what the app says |
|---|---|---|
| Dragon Ball Super: Super Hero | 2022 MOVIE | TV, 1986-02-26 |
| Dragon Ball Super: Broly | 2018 MOVIE | TV, 1986-02-26 |
| Dragon Ball Movie 3: Makafushigi Daibouken | MOVIE | TV, 1986-02-26 |
| Dragon Ball GT: Goku Gaiden | SPECIAL | TV, 1986-02-26 |

**Why.** `findAniMatch()` pass 3 is a prefix match:

```js
const okR = r.length >= 8 && (r.startsWith(n) || n.startsWith(r))
            && seasonNum(r) === nSeason;
```

`normName('Dragon Ball')` is `dragonball`, which is 10 characters, so it clears
the `>= 8` guard. Every title in the franchise starts with it. `Dragon Ball
Super: Broly` normalises to `dragonballsuperbroly`, `n.startsWith(r)` is true,
and it matches the 1986 entry.

**The v0.5.1 season guard does not catch this.** That guard requires
`seasonNum(r) === nSeason`, but none of these titles contain a season number, so
`seasonNum()` returns 1 for every one of them and they all "agree". The guard
was built for `Season 3` matching `Season 1`. It does nothing for a franchise
whose entries are distinguished by subtitle rather than by number.

**Everything downstream is poisoned by this:**
- chronological sort is meaningless when 27 entries share one date
- movies never render as MOVIE, because they claim to be TV
- the season strip cannot tell a film from a season

---

## FINDING 2 — the season strip is a franchise dump, not a season list

`'dragon ball'` is an explicit entry in `FRANCHISE_PATTERNS` and matching is
`name.startsWith(pattern)`, so the entire 40-year franchise unions into one
`franchise_id`. The relation filter compounds it: `ufUnion` runs over
`SEQUEL, PREQUEL, SIDE_STORY, SPIN_OFF, ALTERNATIVE, PARENT`, and union-find is
transitive, so one spin-off edge drags in everything it touches.

The strip for Dragon Ball Super therefore renders **twelve chips**:

```
S1 | Super Saiyajin… | Ginga Girigiri!… | Super Senshi Ge… | Super Saiya-jin…
 | S1 | ONA | Big Bang Mission | ONA | Broly | Super Hero | Beerus
```

Three TV series, five movies, three ONAs, one OVA. **Two different chips both
read "S1"** — Dragon Ball Z and Dragon Ball Super — because `seasonLabel()`
falls through to `'S1'` for anything with no season number, no colon and a
non-film format.

A franchise card grouping all of this is arguable. A **season** strip doing it
is not.

---

## FINDING 3 — "just the latest ones": the strip never fetches the rest

```js
if (franchiseSiblings(sel.franchiseId).length >= 2) return;
```

`franchiseSiblings()` reads from `state.results`, `state.dailyResults`,
`state.favorites` and the cache — in other words, **whatever the current search
happened to return.** `ensureFranchiseSiblings()` then gives up as soon as it
finds two.

So if a search returns the two or three most popular entries, which skew recent,
the strip declares itself satisfied and the earlier seasons are never fetched.
That is the reported symptom exactly.

---

## FINDING 4 — franchise_id is not stable across searches

| query | franchise_id for the same shows |
|---|---|
| `dragon ball super` | **502** |
| `dragon ball` | **223** |

The id is the union-find root over whatever AniList returned for that query, so
it changes with the query. Anything persisted against a franchise_id —
favourites, history, the sibling cache — goes stale the moment a different
search assigns a different root. This was not in the report and is probably
causing symptoms he has attributed to something else.

---

## WHAT FIXING IT LOOKS LIKE

**1. Kill the bad prefix match (fixes most of it).**
Pass 3 should require more than a shared prefix. The cheapest correct guard: the
candidate's *remainder* after the prefix must be empty or must itself be a
season marker. `dragonball` → `dragonballsuperbroly` leaves `superbroly`, which
is not a season marker, so it should not match. This alone restores correct
dates and formats to 27 of 40 entries.

**2. Trust AniList's own format and date over an inherited one.**
Any entry whose `anilist_format` came from a *fuzzy* match should be marked as
such and not used for sorting or labelling. Better: fetch format and date from
the matched id directly rather than copying the matched record wholesale.

**3. Make the season strip a season strip.**
Filter to the TV spine: `anilist_format === 'TV'` plus the SEQUEL/PREQUEL chain.
Movies, ONAs, OVAs and specials belong in a separate "Also in this franchise"
row, or behind a toggle. With finding 1 fixed, this filter starts working.

**4. Always fetch the full franchise.**
Drop the `length >= 2` early return. Fetch once per franchise, cache it, and let
the strip render from the complete set rather than from search leftovers.

**5. Give franchise_id a stable key.**
Derive it from the lowest AniList id in the union, or from the matched
FRANCHISE_PATTERN string, rather than from whatever the current query's
union-find produced.

**6. Arcs — separate decision.**
Neither provider has saga boundaries. Options: a curated table for the handful
of long-running shows where it matters (DB, One Piece, Naruto, Bleach), or
chapter the episode grid by a fixed interval, or leave it. This is a product
call, not a bug fix.

Nothing here has been changed. Server left running on :7890 as it was found.
