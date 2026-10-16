---
type: research
status: draft
review_by: 2027-01-16
related: ["#6"]
---

# Official Star Wars: Unlimited rules sources

## TL;DR

The current Comprehensive Rules (CR) are a PDF on the official CDN, cover-dated 7/8/26, version 8.0. The URL carries a content hash, so no stable "latest" URL was found. Announcements and bans are Strapi `articles` on the admin API, which works without auth. The per-card `rules` field is a real, filterable ruling field (4441 hits on a live API count). The first draft could not run extraction or count the local snapshot (no shell); both were checked afterwards on 2026-10-16 and the corrections are in the "Corrections" section below.

## Findings

- The CR is a PDF at https://cdn.starwarsunlimited.com//SWH_Comp_Rules_v8_0_e26603c6e1.pdf (1.6 MB, US Letter pages). The cover reads "COMPREHENSIVE RULES" and "7/8/26 - V 8.0". The date is day-first (7 August 2026), or US-style 8 July; the PDF creation date is 2026-05-08, so the cover date is most likely the effective date. [sub-claim 1: current CR download URL, format, version, date]
- The filename embeds the version ("v8_0") plus a random hash suffix ("e26603c6e1"), the Strapi upload naming pattern. The URL therefore changes with each upload, and this run found no stable "latest" alias. [sub-claim 2: announcement, old versions, stable latest URL] unverified: inferred from the one filename https://cdn.starwarsunlimited.com//SWH_Comp_Rules_v8_0_e26603c6e1.pdf
- The CR intro says red text marks additions and changes since the previous version, so the PDF carries its own visual changelog. The page text was read from the rendered PDF, not from extracted text. [sub-claim 5: CR numbering scheme and extraction] Source: https://cdn.starwarsunlimited.com//SWH_Comp_Rules_v8_0_e26603c6e1.pdf
- Numbering: the CR has 12 top-level sections (1 Game Concepts, 2 Card Anatomy, 3 Card Types, 4 Zones, 5 Game Structure, 6 Action Timing and Clarifications, 7 Abilities and Effects, 8 Additional Rules, 9 Two-Player Constructed Formats, 10 Limited Formats, 11 Playing with More Than Two Players, 12 Twin Suns). Section 8 alone has 38 subsections. Rule text is cited as section.subsection.item, for example 1.5.2.b (section 1, Cards, Ownership and Control, lowercase lettered paragraph b); the first draft wrote the letter in upper case, which the PDF does not. The intro gives "1.1.2." as its own example. The introduction promises an Index/Glossary at the end, but the extracted text ends with section 12.7 and holds no glossary body (the word GLOSSARY appears only as a footer link). [sub-claim 5: CR numbering scheme and extraction] Source: https://cdn.starwarsunlimited.com//SWH_Comp_Rules_v8_0_e26603c6e1.pdf
- Ten consecutive headings from the contents page: 1.1 General, 1.2 Deck, 1.3 Golden Rules, 1.4 Players/Active Player, 1.5 Cards, 1.6 Abilities, 1.7 Resources, 1.8 Cost, 1.9 Damage, 1.10 Power. These are headings only; body paragraphs are numbered inside each. Sections 1.5 and 2.x use lettered sub-paragraphs (A., B.) under numbered sub-headings. [sub-claim 5: CR numbering scheme and extraction] Source: https://cdn.starwarsunlimited.com//SWH_Comp_Rules_v8_0_e26603c6e1.pdf
- Page count: the contents page puts Section 12 starting on page 55 and section 12.7 on page 56, so the body runs at least 56 pages before the glossary. The PDF has 56 pages and 1,712,864 bytes (`pdfinfo`). The CR has hyperlinked cross-references ("See 1.7. Resources") and red change markup that will affect extraction.
- Announcements: the Strapi `articles` collection works unauthenticated. This query lists 10 rules/ban/update articles, newest first, with `id`, `title`, `slug`, `publishOn` and `updatedAt`: https://admin.starwarsunlimited.com/api/articles?filters[$or][0][title][$containsi]=errata&filters[$or][1][title][$containsi]=tournament&filters[$or][2][title][$containsi]=ban&filters[$or][3][title][$containsi]=update&filters[$or][4][title][$containsi]=organized&filters[$or][5][title][$containsi]=FAQ&fields[0]=title&fields[1]=slug&fields[2]=publishOn&fields[3]=updatedAt&pagination[pageSize]=60&sort=publishOn:desc [sub-claim 3: other official documents and announcements]
- That query's hits (publishOn dates): Homeworlds Product Release Update 2026-09-25; Cad Bane Leader Card Suspended 2026-08-24 (slug `cad-banned`, updatedAt 2026-08-26); Eternal Format Update: April 2026 (2026-04-15, updatedAt 2026-06-08); Meta Update from the Team 2025-11-05; Meta Update from the Devs 2025-07-02; Suspension Update: April 2025 (2025-04-09); Comprehensive Rules Update: Lightspeed 2025-03-07; Meta Update from Danny 2025-03-05; Updates and Rotations 2025-01-29; Comprehensive Rules Update 2024-07-03. Titles and dates are paraphrased from a WebFetch summary, not raw JSON. [sub-claim 6: change detection and history] Source: https://admin.starwarsunlimited.com/api/articles?filters[$or][0][title][$containsi]=errata&filters[$or][1][title][$containsi]=tournament&filters[$or][2][title][$containsi]=ban&filters[$or][3][title][$containsi]=update&filters[$or][4][title][$containsi]=organized&filters[$or][5][title][$containsi]=FAQ&fields[0]=title&fields[1]=slug&fields[2]=publishOn&fields[3]=updatedAt&pagination[pageSize]=60&sort=publishOn:desc
- A title filter for "rules" returns 3 articles: Comprehensive Rules Update: Lightspeed (id 382, 2025-03-07), Comprehensive Rules Update (id 217, 2024-07-03), and Star Wars: Unlimited Quickstart Rules (id 32, `publishOn` null, updatedAt 2023-07-26). The Quickstart is an article, not a PDF link as far as this query shows. [sub-claim 3: other official documents and announcements] Source: https://admin.starwarsunlimited.com/api/articles?filters[title][$containsi]=rules&fields[0]=title&fields[1]=slug&fields[2]=publishOn&fields[3]=updatedAt&pagination[pageSize]=25&sort=publishOn:desc
- The Lightspeed CR-update article (slug `comprehensive-rules-update-lightspeed`) has one `blocks.wysiwyg` content block and contains no CR download link or file reference, only images and card links. A CR update article announces a version but does not carry the PDF URL. The article's version number was not read from the fetched page. [sub-claim 2: announcement, old versions, stable latest URL] Source: https://admin.starwarsunlimited.com/api/articles?filters[slug][$eq]=comprehensive-rules-update-lightspeed&populate=*
- Articles schema with `populate=*`: attributes `title`, `keywords`, `description`, `slug`, `publishOn`, `createdAt`, `updatedAt`, `publishedAt`, `locale`, `seo`, `mainImage`, `content` (dynamic zone with `__component` and `content`), `categories`, `relatedArticleBackgroundImage`, `localizations`; `meta.pagination` has page, pageSize, pageCount, total. [sub-claim 6: change detection and history] Source: https://admin.starwarsunlimited.com/api/articles?pagination[pageSize]=1&populate=*
- Per-card rulings: the card-list endpoint filters on the `rules` field. `filters[rules][$notNull]=true` returned `meta.pagination` total 4441 (pageCount 1481 at pageSize 3). Whether that equals the local snapshot, and whether it counts non-English localizations or empty strings, is not established. [sub-claim 4: per-card rulings field] Source: https://admin.starwarsunlimited.com/api/card-list?filters[rules][$notNull]=true&pagination[pageSize]=3&fields[0]=title&fields[1]=rules&fields[2]=rulesStyled&fields[3]=cardNumber&fields[4]=updatedAt
- Three examples from that call (summarised): Darth Vader (id 6, cardNumber 10) says his leader ability can be used as an action even before a Villain is played, with no damage dealt; Fleet Lieutenant (id 20, cardNumber 240) says units must be ready to attack; Grand Moff Tarkin (id 25, cardNumber 84) says cards not chosen after searching go to the bottom of the deck in random order. `rulesStyled` is an HTML table whose first cell is a date (3/1/2024 in all three). Wording is paraphrased. [sub-claim 4: per-card rulings field] Source: https://admin.starwarsunlimited.com/api/card-list?filters[rules][$notNull]=true&pagination[pageSize]=3&fields[0]=title&fields[1]=rules&fields[2]=rulesStyled&fields[3]=cardNumber&fields[4]=updatedAt
- Change signals available: the article `publishOn` and `updatedAt` fields (listed above), the CR PDF's filename hash and version (`v8_0`), and the cover string "V 8.0". Version history found in fetched articles is only dates: CR update articles on 2024-07-03 and 2025-03-07, then the v8.0 PDF (7/8/26). Intermediate versions (v3 to v7) and their dates were not sourced. [sub-claim 6: change detection and history] Source: https://admin.starwarsunlimited.com/api/articles?filters[title][$containsi]=rules&fields[0]=title&fields[1]=slug&fields[2]=publishOn&fields[3]=updatedAt&pagination[pageSize]=25&sort=publishOn:desc
- Local count (checked 2026-10-16 in the mault originals): 4,430 printings carry a `rulesStyled` table and 603 distinct `rules` texts exist; 4,433 printings have a non-empty `rules` string (3 without a table). The API total of 4441 differs from this snapshot.
- unverified: tournament rules, floor rules/judge documents, Organized Play policies, a dedicated errata list. No official Unlimited document was found for any of them. [sub-claim 3: other official documents and announcements]

## Gaps

- Item 4 was completed after the first draft: the CR was saved as tmp/rules/cr-v8.pdf (sha256 18dd5c92b051b326...), and poppler's `pdftotext -layout` gives 264 KB of clean text. Levels are rebuilt from the numbering sequence and the page footer, not from raw indentation, because indentation drifts between pages.
- Item 3 local count not done (see above). The API total of 4441 is the only count.
- unverified: https://admin.starwarsunlimited.com/api/upload/files (HTTP 403). The Strapi media library is closed, so a files listing for CR versions or old PDFs cannot be enumerated.
- unverified: https://admin.starwarsunlimited.com/api/rules (HTTP 404). No collection of that name; no rules/documents collection was found, but only this one guess was probed.
- unverified: https://starwarsunlimited.com/rules (HTTP 404). The page that links the CR PDF was not found. https://starwarsunlimited.com/how-to-play fetched OK but exposed no document links to the fetch tool (the site is a client-rendered app), so the HTML route to the PDF link is unconfirmed.
- unverified: https://starwarsunlimited.com/how-to-play/rules (HTTP 404).
- Whether v8.0 is the latest, whether older CR PDFs stay downloadable, and a stable latest URL: none established. An unrelated site search hit, https://starwarsunlimited.com/running-tournaments, was not fetched.
- The date 7/8/26 is ambiguous (July 8 or 7 August); the PDF metadata hint of 2026-05-08 from the fetch summary conflicts and is unreliable.

## Corrections (2026-10-16)

- Verified facts are in LampaGJ/swu-mcp#6 comments: 56 pages, 1.71 MB, sha256 18dd5c92b051b326..., PDF created 2026-05-08, cover "7/8/26 - V 8.0".
- Aspect and cost icons extract as private-use glyphs (U+F6D0 to U+F6E1); the parser strips them. Red change markup loses its colour in text extraction; `pdftotext -bbox-layout` or pdfjs could recover it, so `rules_version_diff` stays parked.
- No stable "latest" URL exists because the filename carries a hash. To detect a new CR, re-check the rules page or CDN and compare the filename hash and the cover version string. No article field links the CR file.
- The 4441 API count and the local 4,430 / 4,433 counts differ because they count different things; use the local counts for anything derived from the pinned snapshot.

## Confidence

Low to medium. The CR URL, version and numbering are read from the primary PDF. Announcement dates and API shapes come from the live API through a summarising fetch tool. Extraction, local counts and non-CR documents are unverified.

## Verified vs Unverified

Verified claims: 11 findings bullets with one URL each. Unverified bullets: 5 in Findings and Gaps combined is the count of bullets beginning with "unverified" or flagged so: 4 failed-URL bullets in Gaps plus 2 in Findings (local snapshot count, tournament/floor docs), plus the two inline-flagged findings (filename inference and page count).

## Reproduction

Searches run, in order:
- Star Wars Unlimited Comprehensive Rules PDF download
- starwarsunlimited.com Comprehensive Rules update announcement rules update tournament rules errata
- Star Wars Unlimited Organized Play tournament rules PDF Fantasy Flight Games "Tournament Rules" version

Fetches, in order:
- ok: https://admin.starwarsunlimited.com/api/articles?pagination[pageSize]=1&populate=*
- ok: https://cdn.starwarsunlimited.com//SWH_Comp_Rules_v8_0_e26603c6e1.pdf (binary saved to the session tool-results folder, then rendered with Read pages 1-4)
- ok, no links exposed: https://starwarsunlimited.com/how-to-play
- failed 403: https://admin.starwarsunlimited.com/api/upload/files
- ok: https://admin.starwarsunlimited.com/api/articles?filters[title][$containsi]=rules&fields[0]=title&fields[1]=slug&fields[2]=publishOn&fields[3]=updatedAt&pagination[pageSize]=25&sort=publishOn:desc
- ok: https://admin.starwarsunlimited.com/api/articles?filters[$or][0][title][$containsi]=errata&filters[$or][1][title][$containsi]=tournament&filters[$or][2][title][$containsi]=ban&filters[$or][3][title][$containsi]=update&filters[$or][4][title][$containsi]=organized&filters[$or][5][title][$containsi]=FAQ&fields[0]=title&fields[1]=slug&fields[2]=publishOn&fields[3]=updatedAt&pagination[pageSize]=60&sort=publishOn:desc
- ok: https://admin.starwarsunlimited.com/api/articles?filters[slug][$eq]=comprehensive-rules-update-lightspeed&populate=*
- failed 404: https://admin.starwarsunlimited.com/api/rules
- ok: https://admin.starwarsunlimited.com/api/card-list?filters[rules][$notNull]=true&pagination[pageSize]=3&fields[0]=title&fields[1]=rules&fields[2]=rulesStyled&fields[3]=cardNumber&fields[4]=updatedAt
- failed 404: https://starwarsunlimited.com/how-to-play/rules
- failed 404: https://starwarsunlimited.com/rules

Local reads: Read of the report path (not found, path free); Glob of the snapshot folder (104 gz files, not decompressed).
