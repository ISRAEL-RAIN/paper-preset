---
name: citation-integrity
description: Use whenever writing, editing, or reviewing a bibliography or an in-text citation — deciding whether a reference may be used, checking that a citation supports the sentence it is attached to, recording what a source does and does not say, or auditing a .bib file. Covers the two-layer verification model (existence vs support), literature claim cards, and the failure signatures of fabricated references.
---

# Citation integrity

## Why this is the part that matters

Fabricated references are not a rare edge case, and they do not look wrong.

- A review of chatbot-produced medical answers found up to **25–34%** of their references were fabricated or unverifiable in the worst-performing models, complete with plausible titles and invented URLs.
- Across multi-turn conversations, citation fabrication compounds: one study measured an **85.6%** fabrication rate by the end of a long session.
- A scan of the 4,841 papers accepted to NeurIPS 2025 found **at least 100 references that pointed to publications that do not exist**, spread across 51 accepted papers. Every one of those papers passed at least three reviewers.

The reason is structural, not moral. A citation has no redundancy: a wrong number is caught by the next experiment, but a wrong reference looks exactly like a right one. So the rule is absolute —

> **Every bibliography entry comes from a tool result in this session. Never from memory.**

## The two layers, and only one of them is automated

| Layer | Question | Who answers it |
|---|---|---|
| **Existence** | Does this work exist, and do title / authors / year / venue / DOI match it? | `ref_verify`, `bib_check` — a real oracle |
| **Support** | Does the work actually say what your sentence claims? | **You, by reading it.** No API answers this. |

Both are required. Passing layer 1 and skipping layer 2 produces the most damaging kind of error: a real citation deployed to support a claim the cited work does not make. `verified` means the work exists with matching metadata — it is **not** a statement about support. Never describe or imply otherwise.

Concretely, the support layer means: before a citation is used as evidence, you can point to the passage in that source which carries the claim. If you cannot, the honest options are to read it, to weaken the sentence, or to drop the citation.

## Where the tools stop

`ref_verify` reaches Crossref, DataCite, and OpenAlex. That covers most journals, conferences, and preprints. It does **not** cover:

- **Chinese-language sources (CNKI/知网)** — there is no open API. Ask the user to export RIS or NoteExpress/NoteFirst, then verify what can be verified and mark the rest `unverified-cnki`. Do not pretend to have searched 知网.
- **Books, theses, standards, patents, technical reports** — often absent from all three registries. `not_found` here means "not in these registries", not "fabricated". Say which one it is.
- **Whether a citation is retracted** — neither tool checks this. If a source is central to the argument, look it up.

## Statuses, and what each one licenses

| Status | What it means | What you may do |
|---|---|---|
| `verified` | Exists, metadata matches | May be used once support is established |
| `updated` | Same work, later year and a real venue — the preprint was published | Update the entry, then treat as verified |
| `mismatch` | Found, but fields disagree (listed explicitly) | Fix the entry to the authoritative values, then re-verify |
| `not_found` | Not in Crossref, DataCite, or OpenAlex | **Do not cite it.** Report it and ask the user |
| `service_error` | No source could be reached | **Unchecked, not valid.** Retry; never report it as passing |

`service_error` is the one people get wrong. A check that could not run is not a check that passed.

## Literature claim cards

For sources that carry the argument (not for every reference), keep a short card. The point of the format is that it forces the **counter-evidence** into the record:

```markdown
### [cite-key] Short title
- **Claim used for**: the sentence in this manuscript this source is meant to support
- **Supporting**: quote + locator (section / page / figure)
- **Qualifying**: the conditions the authors themselves attach — sample, domain, assumptions
- **Contradicting**: passages in this same source that cut against your claim, or other
  sources that disagree. Write `none found` only after looking.
- **Read**: full text | abstract only | `unread`
```

Three rules about the card:

1. A card with no **Qualifying** or **Contradicting** field filled in is a red flag, not a clean source. Most real papers qualify their own findings.
2. **`Read: unread`** is a legitimate value, and it is binding: an unread source may be cited as related work, but its specific findings may not be used as evidence for anything.
3. Cards belong next to the manuscript, not inside the bibliography. They are working notes about your argument, not publication metadata.

## Failure signatures to watch for

When something is wrong, it usually looks like one of these:

- **The plausible triple.** A tidy author-year-journal combination with no DOI. This is the single most common signature of a fabricated reference.
- **Title near-match with a wrong year.** The search finds something at similarity 0.7–0.85 — often a real paper with a similar name. Read the `differences` list; do not round it up to a match.
- **Author drift.** The first surname is absent from the authoritative author list. This is high severity: it usually means two papers were blended.
- **Preprint/publication duplication.** The same work entered twice, once as a preprint and once as the published version. `updated` exists to catch this.
- **DOI that does not belong to the title.** `ref_verify` with the DOI and then with the title; if they disagree, the DOI was attached to the wrong record.

## Working habits

- Verify **as you add**, not at the end. A fabricated reference costs seconds to catch while writing and a correction notice after publication.
- When a check fails, report the failure to the user in plain language: which key, which status, what was searched. Do not silently drop the citation, and do not silently keep it.
- Never "repair" a failing entry by inventing a plausible correction. Fix it from the authoritative record the tool returned, or remove it.
- Never write a reference for a source the user described but did not provide, unless a tool finds it — and then confirm with the user that it is the intended work.
