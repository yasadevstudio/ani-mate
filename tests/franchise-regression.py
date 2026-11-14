#!/usr/bin/env python3
"""Regression harness for franchise grouping, season strips and AniList matching.

Every case here is either a bug reported by YASA or a fix from v0.5.1 that must
not regress. Run before and after any change to findAniMatch, groupByFranchise,
FRANCHISE_PATTERNS or the season strip.

    python3 tests/franchise-regression.py            # run
    python3 tests/franchise-regression.py --save X   # write results to X.json
    python3 tests/franchise-regression.py --diff A B # compare two saved runs
"""
import json, os, re, subprocess, sys, time, urllib.parse, urllib.request

# The same variable the two JS live suites read, so one setting moves all three. It was
# fixed at port 7890 here, which is the app the user is running.
API = os.environ.get("ANIMATE_API", "http://localhost:7890").rstrip("/")
# No RANK table here any more: the member ordering is groupByFranchise's, and this
# harness calls it rather than restating it.


class Empty(Exception):
    """Upstream returned nothing. NEVER let this pass as a result."""


def search(q, _min=1, _tries=3):
    """Search, retrying transient empties.

    An empty result set is raised, not returned. The first version of this
    harness returned [] on an upstream hiccup and three cases PASSED on it,
    because `max([...] or [0]) <= 6` is true of nothing and
    `next((...), {}).get('format')` is None for a row that is not there.
    Absent data must fail, loudly. That failure mode is the whole reason this
    file exists.
    """
    last = 0
    for attempt in range(_tries):
        u = f"{API}/search?q=" + urllib.parse.quote(q)
        try:
            with urllib.request.urlopen(u, timeout=180) as r:
                rows = json.load(r).get("results", [])
        except Exception:
            rows = []
        if len(rows) >= _min:
            return rows
        last = len(rows)
        time.sleep(3 + attempt * 4)
    raise Empty(f"{q!r} returned {last} results after {_tries} tries, need >= {_min}")


def need(rows, *names):
    """Assert these titles are present, so a check never passes on absence."""
    have = {r["name"] for r in rows}
    missing = [n for n in names if n not in have]
    if missing:
        raise Empty("missing from results: " + ", ".join(missing))
    return {n: next(r for r in rows if r["name"] == n) for n in names}


class NoGrouping(Exception):
    """The JS could not be lifted or returned nothing. NEVER let this pass as a result."""


def card_opens(rows, parent_mode="score"):
    """Returns {fid: (whatTheCardOpens, membersInOrder)} by calling THE SHIPPED JS.

    ⛔ THIS WAS A PYTHON PORT OF groupByFranchise AND THE PORT IS WHY IT LIED.
    Its docstring already recorded drifting once ("reported a working fix as a
    failure"). By 2026-11-09 it had drifted again: it still began

        if r.get("franchise_id"):

    long after the JS stopped requiring a franchise_id to group. So every franchise the
    server had not tagged was absent from the return value, and the three cases below
    that call this were evaluating `all(... for ... in {}.values())` — vacuously true.
    Three green rows asserting nothing.

    tests/lift-js.js extracts groupByFranchise out of ui/ani-mate-ui.html and runs it.
    One implementation, and the test exercises the one that ships.
    """
    if not rows:
        raise NoGrouping("no rows to group")
    lifter = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lift-js.js")
    p = subprocess.run(["node", lifter, "group", parent_mode],
                       input=json.dumps(rows), capture_output=True, text=True, timeout=120)
    if p.returncode != 0:
        raise NoGrouping("lift-js.js failed: " + (p.stderr.strip() or "rc=%d" % p.returncode))
    try:
        data = json.loads(p.stdout)
    except ValueError:
        raise NoGrouping("lift-js.js produced no JSON: " + p.stdout[:200])
    out = {}
    for g in data.get("groups", []):
        out[str(g["franchise_id"])] = (g["parent"], g["members"])
    if not out:
        # Absent data must fail loudly, the same rule the search() wrapper follows.
        raise NoGrouping("%d rows produced zero franchise groups" % len(rows))
    return out


CASES = [
    # ── the 2026-10-12 report ────────────────────────────────────────────────
    dict(id="db-card-opens", q="dragon ball super", minrows=5,
         want="every franchise card opens an entry matching the query",
         check=lambda rs: (lambda g: bool(g) and all("Super" in parent["name"]
                                                     for parent, _ in g.values()))(card_opens(rs))),
    dict(id="db-beerus-present", q="dragon ball super", minrows=5,
         want="the 2026 Beerus remake is in the results",
         check=lambda rs: bool(need(rs, "Dragon Ball Super: Beerus"))),
    dict(id="db-dates-not-collapsed", q="dragon ball", minrows=20,
         want="no more than 6 entries share one REAL date (absent != collapsed)",
         # A null start_key is missing data, not the 1986 date stamped onto 27
         # entries. Those degrade correctly: the season strip filters on format, so
         # an unknown lands under "+N more" instead of masquerading as a season.
         check=lambda rs: (lambda keys: not keys or max(
                               sum(1 for r in rs if r.get("start_key") == k) for k in keys) <= 6)(
                           {r.get("start_key") for r in rs if r.get("start_key")})),
    dict(id="db-movies-are-movies", q="dragon ball", minrows=20,
         want="Broly and Super Hero report MOVIE, not TV",
         check=lambda rs: all(
             v.get("anilist_format") == "MOVIE"
             for v in need(rs, "Dragon Ball Super: Broly",
                               "Dragon Ball Super: Super Hero").values())),
    dict(id="fid-stable", q=None,
         want="same show gets the same franchise_id from two different queries",
         check=lambda _: (lambda a, b: a == b and a not in (None, "None"))(
             need(search("dragon ball super", 5), "Dragon Ball Super")
                 ["Dragon Ball Super"].get("franchise_id"),
             need(search("dragon ball", 20), "Dragon Ball Super")
                 ["Dragon Ball Super"].get("franchise_id"))),
    # ── v0.5.1 fixes that must not regress ──────────────────────────────────
    dict(id="v051-apothecary-s3", q="apothecary diaries", minrows=3,
         want="later seasons do not inherit season 1's start_key",
         check=lambda rs: (lambda later, s1: bool(later) and bool(s1)
                           and all(x.get("start_key") != s1.get("start_key") for x in later))(
             [r for r in rs if re.search(r"(Season\s*[23]|[23](?:nd|rd)\s+Season)", r["name"], re.I)],
             next((r for r in rs if r["name"] in ("The Apothecary Diaries",
                                                  "Kusuriya no Hitorigoto")), None))),
    dict(id="v051-apothecary-card", q="apothecary diaries", minrows=3,
         want="card still opens season 1 when no season is named",
         # `all(...)` over an empty dict is TRUE. card_opens now raises NoGrouping on an
         # empty result rather than handing this assertion nothing to be true of.
         check=lambda rs: (lambda g: bool(g) and all(
             "Season 2" not in p["name"] and "Season 3" not in p["name"]
             and "2nd Season" not in p["name"] and "3rd Season" not in p["name"]
             for p, _ in g.values()))(card_opens(rs))),
    dict(id="untagged-still-groups", q="beastars", minrows=2,
         want="seasons group even when the server tags none of them with a franchise_id",
         # The 2026-11-09 report: "no navigation on the Beastars Final season part 2
         # page, and franchise grouping is still not perfect". Grouping must not depend
         # on franchise_id, so strip it from the rows and require the group to survive.
         check=lambda rs: (lambda g: bool(g) and max(len(m) for _, m in g.values()) >= 2)(
             card_opens([{k: v for k, v in r.items() if k != "franchise_id"} for r in rs]))),
    dict(id="fav-card-is-season-1", q="apothecary diaries", minrows=3,
         want="on FAVS the card is season 1, not whichever season ranks best",
         check=lambda rs: (lambda g: bool(g) and all(
             not re.search(r"(Season\s*[2-9]|[2-9](?:nd|rd|th)\s+Season|Final Season)",
                           p["name"], re.I)
             for p, _ in g.values()))(card_opens(rs, "first"))),
    dict(id="v051-frieren-grouped", q="frieren",
         want="the curly-apostrophe English title groups with the romaji one",
         check=lambda rs: (lambda g: len(g) <= 1)(
             {str(r.get("franchise_id")) for r in rs
              if "Frieren" in r["name"] and r.get("franchise_id")})),
    dict(id="v051-search-semantic", q="apothecary in the imperial palace",
         want="content search still returns Apothecary Diaries",
         check=lambda rs: any("Apothecary" in r["name"] or "Kusuriya" in r["name"] for r in rs)),
    dict(id="v051-bebop-rank", q="cowboy bebop",
         want="the 26-episode series outranks the movie",
         check=lambda rs: (lambda i, j: i is not None and (j is None or i < j))(
             next((n for n, r in enumerate(rs) if r["name"] == "Cowboy Bebop"), None),
             next((n for n, r in enumerate(rs) if "Tengoku" in r["name"]), None))),
]


def run():
    res, npass = [], 0
    for c in CASES:
        try:
            rows = search(c["q"], c.get("minrows", 1)) if c["q"] else []
            ok = bool(c["check"](rows))
            err = "" if ok else "assertion false"
        except Empty as e:
            ok, err = False, f"NO DATA — {e}"
        except NoGrouping as e:
            ok, err = False, f"NO GROUPING — {e}"
        except Exception as e:
            ok, err = False, f"{type(e).__name__}: {e}"
        npass += ok
        res.append(dict(id=c["id"], ok=ok, want=c["want"], err=err))
        print(f"  {'PASS' if ok else 'FAIL'}  {c['id']:<26} {c['want']}"
              + (f"\n        {err}" if err else ""))
    print(f"\n  {npass}/{len(CASES)} passing")
    return res


if __name__ == "__main__":
    a = sys.argv[1:]
    if a and a[0] == "--diff":
        x = {r["id"]: r["ok"] for r in json.load(open(a[1]))}
        y = {r["id"]: r["ok"] for r in json.load(open(a[2]))}
        for k in sorted(set(x) | set(y)):
            if x.get(k) != y.get(k):
                arrow = "FIXED" if y.get(k) else "BROKE"
                print(f"  {arrow}  {k}")
        print("  (no differences)" if all(x.get(k) == y.get(k) for k in set(x) | set(y)) else "")
        sys.exit(0)
    r = run()
    if a and a[0] == "--save":
        json.dump(r, open(a[1] + ".json", "w"), indent=1)
        print(f"  saved {a[1]}.json")
    sys.exit(0 if all(x["ok"] for x in r) else 1)
