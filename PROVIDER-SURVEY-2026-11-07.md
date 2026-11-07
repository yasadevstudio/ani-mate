# PROVIDER SURVEY — 2026-11-07

Every line below was probed live today, not read off a list. ani-py's own policy doc states the
rule this survey follows: *"Mocked parser tests are not evidence that a third-party deployment is
currently reachable."*

## THE HEADLINE, AND IT CHANGES THE PLAN

**For streaming, the ecosystem is a monoculture.** Nearly everything that still answers routes to
the same two backends: **ZokoAnime** and **megaplay.buzz**. Adding "more stream providers" largely
adds more doors into the same room.

**The subtitle chain is where redundancy actually exists**, and it has to come from
release-trackers rather than streaming sites. That is the opposite of how ANI-MATE is built.

## WHAT THE REST OF THE ECOSYSTEM DOES

| project | providers | note |
|---|---|---|
| **ani-cli** (pystardust) | **hianime.at only** | dropped its others |
| **ani-py** (actively maintained, commits 2026-10-11) | **HiAnime primary, AniLight opt-in** | **retired Kuhi + AnimeKai**: "their upstreams went away" |
| **Consumet** | — | `api.consumet.org` returns **HTTP 451**, legally blocked |
| **Kuhi API** | 10 providers, racing | public instance 404s; ani-py retired it |
| **AniDap** | 5 providers (Yuki/Loli/Sora/Neko/Uwu) | 2 commits total, unproven |

ani-py's reason for *deleting* rather than disabling dead providers applies directly to us:

> a provider that cannot resolve costs failover time and implies a safety net that is not there.

## PROBED LIVE, 2026-11-07

### Streams
| host | result |
|---|---|
| `hianime.at` | **200** — current primary. Two servers per episode: ZokoAnime + HD-1 (megaplay) |
| `api.anilight.live` | **200** — search + `/watch/` work. `/sources` is **403 IP-gated** |
| `gogoanime.by` | **200** — search responds. Extraction unverified |
| `animeheaven.me` | **200** — search responds. Extraction unverified |
| `animepahe.com` | **403** Cloudflare |
| `allanime.day` | **redirect loop** — ⚠ this is ENABLED in our code today |
| `anitaku.bz` | SSL chain failure |

### Subtitles
| host | result |
|---|---|
| **`animetosho.org`** | **200 — and it HAS the file we are missing.** `?disp=attachments` is a subtitle-only view |
| `kitsunekko.net` | 200, Japanese-focused |
| `subdl.org` | 200 |
| `jimaku.cc` | 200, API needs a key, Japanese-focused |
| `opensubtitles.org` | 401 without an account |

## THE TEST CASE THAT PROVES THE POINT

**BEASTARS FINAL SEASON Part 2, episode 1.**

    hianime ZokoAnime ...... 1 track, 7 cues — on-screen signs only
    hianime HD-1 ........... 0 subtitle tracks
    AniLight ............... embed_url = megaplay.buzz/stream/s-2/168223/sub
                             ^ the SAME megaplay id. Same backend, no new subtitles.
    episodes 2-5 ........... 348-422 cues each

Three "different providers", one actual answer. The episode was published without a script track.

**animetosho does NOT have it in a usable form.** Checked six releases on 2026-11-07, including
`[Erai-raws] Beastars Final Season - 13 ~ 24 [1080p NF WEB-DL][MultiSub]`: **zero extracted
attachments on every one.** Batch releases do not get attachment extraction, so the subtitles are
inside 1 GB MKVs on multiup/gofile/krakenfiles. Not automatable. Struck.

**AND THE ABSOLUTE-NUMBER THEORY IS WRONG FOR THIS EPISODE.** Part 2 is numbered 13-24
continuously, so Part 2 ep1 should be absolute episode 13. It is not:

    hianime Part2 ep2..ep5  <->  OpenSubtitles S03E14..E17   four for four, identical title
                                 card text at an identical 00:01:42.018
    hianime Part2 ep1       ->   derives to S03E13, and is a DIFFERENT VIDEO
                                 2-3 exact cue times against every Part 2 file;
                                 the ep2/E14 control scores 91

hianime's own episode 1 is on a different timing grid from the rest of its own listing. The
derivation is arithmetically right and the answer is still wrong, which is why external subtitles
ship as a labeled last resort and never as the default.

## WHAT TO BUILD

Two **independent** chains, which is the thing ANI-MATE conflates today.

**Stream chain:** hianime/ZokoAnime → hianime/HD-1 → **gogoanime.by** → AniDB
**Subtitle chain:** hianime/Zoko → hianime/HD-1 → **hianime DUB servers, same episode id** →
other hianime listings → OpenSubtitles (labeled, never default)

The third subtitle tier is the one that actually fixed the bug, and it needed no new provider at
all. hianime lists sub AND dub servers per episode and the sub path never read the dub ones:

    BEASTARS FINAL SEASON Part 2 ep1    sub 1 track / 7 cues    dub 66 tracks / 336 cues
    Cowboy Bebop ep1                    sub 2 tracks / 1 cue    dub 2 tracks / 217 cues

Same episode id, same encode, so the timing cannot drift -- confirmed by the sub-mode signs cues
reappearing in the dub track at identical timestamps (4 of 7 identical in text too).

AniLight is struck from the stream chain: the routes probed all 404, and its watch route returned
the same megaplay id as hianime anyway. animeheaven is struck: its Part II page lists no episodes.

The subtitle chain must be able to pull from a provider that is not serving the video. Checked and
safe: on Beastars S2 ep2 the Zoko and HD-1 tracks are **byte-identical in timing** — 300 cues,
same timestamps, same text. Cross-source grafting does not drift between these encodes.

**Absolute episode numbering has to be part of the lookup.** A release tracker indexes by absolute
number; streaming sites restart at 1 per part. Without that mapping, animetosho lookups miss.

## CLEAN-UP OWED

`allanime` is in the enabled list and is a redirect loop. `animepahe` and `animeheaven` sit
`enabled: false` / "chain unconfirmed" since August. Per ani-py's rule those should be removed or
proven, not left as decoration — today ANI-MATE claims five providers and has **one** that returns
subtitles.
