---
name: paper-writing-craft
description: Use when drafting, restructuring, or tightening any part of an academic paper — titles, abstracts, introductions, related work, methods, results, discussion, figure captions — or when reviewing a draft and explaining why a section does not land. Covers sentence-level information flow, section-level templates, figure practice, and the reviewer complaints that actually cost papers points.
---

# Academic writing craft

This is a reference, not a procedure. Read the section that matches what the user is working on; there is no required order.

## Section order is not writing order

Results and figures are written first, the abstract last. The abstract is a summary of a finished argument — writing it first means writing a plan and calling it a result.

A workable order: Results → Discussion → Method → Related Work → Introduction → Conclusion → Abstract. The reason is that each section depends on decisions made in the ones before it, and the introduction cannot promise a contribution that has not been pinned down yet.

## Sentence level: where information goes

The core model (Gopen & Swan): readers expect **old information early and new information late**.

1. **Topic position (start of sentence).** Put what the reader already knows, or the link back to the previous sentence. This is the connective slot.
2. **Stress position (end of sentence).** Put the thing you want remembered. The end of a clause is where emphasis lands — do not bury the result there.
3. **New information that appears in the stress position must be picked up later.** If a sentence ends on a concept that never returns, the reader experiences a broken thread.
4. **Put actions in verbs.** "We measured the latency" beats "measurements of latency were performed". Keep subject and verb close; material wedged between them reads as unimportant.
5. **One discourse unit, one function.** A paragraph makes one move. When a paragraph makes two, split it.

Two tests worth applying to any draft sentence:

- Read only the first five or six words of each sentence in a paragraph. Do they form a coherent chain of topics? If not, the paragraph has no spine.
- Read only the last few words. Do they carry the payload, or is the sentence trailing off into qualifications?

## Title

Topic keywords + what you did + (optionally) the contribution. Aim for under ~15 words. Long/short/abbreviated forms are worth preparing:

> `Floosh: A Linear-Time Algorithm for Approximate External Sort`

Avoid "we are the first to…" — it is hard to verify and invites a reviewer to find a counterexample. If something is genuinely first, the introduction can demonstrate it.

## Abstract

Structural abstracts carry five moves: **Context / Objective / Methods / Results / Conclusions**.

- Objective: at most three sentences.
- Methods and Results: **must contain concrete numbers.** An abstract with no numbers tells a reviewer nothing was measured.
- Results: only the most important result. Do not list everything.
- Do not reuse sentences verbatim from the body — an abstract has tighter constraints than the sentences it summarizes.
- Respect the venue's word limit; check it rather than guessing.

## Introduction

Five questions a reader needs answered, in roughly this order:

1. What is the problem?
2. Why is it interesting and important?
3. Why is it hard — what makes the obvious approaches fail?
4. Why hasn't it been solved before? What is wrong with existing solutions?
5. What are the key components of your approach and results, and what are their limitations?

Then an explicit **Summary of Contributions**: a bulleted list, **at most four items, non-overlapping**, each mapped to the section that delivers it.

Two structural habits that work:

- **Get a contribution on the page early.** By roughly the first quarter of the paper, a reader should know what is new. Reviewers form a lean by the end of the introduction.
- **Name the gap in a checkable way.** "No prior work addresses X" is weak; "Prior work assumes A, which fails when B" is checkable and tells the reader what to look for.

The literature-review move (Swales' CARS): establish the territory → establish the gap → occupy the gap. Use it as a checklist for whether the introduction actually does those three things.

## Related work

- **Never paraphrase abstracts.** The point is to let the reader understand each work's core idea and where yours differs.
- Write a **relationship sentence** per item, not a summary per item: `X et al. propose A; we also use A but move it to a different setting.` Similar works can share a paragraph when the contrast is the same.
- When more than three or four works are being compared, a **difference matrix** usually beats prose: rows are works, columns are task / data / method / metric / limitation, plus a row for this paper. The matrix can then be collapsed into paragraphs by grouping rows.
- The gap must be **checkable**. Vague novelty claims invite a reviewer to supply the citation you missed.
- Placement is a real tradeoff: front-loading related work defends novelty immediately; putting it just before the conclusion avoids the reader concluding your work is derivative before reaching your contribution. Choose based on whether novelty is likely to be challenged.

## Figures and captions

- **Figure first.** Build the figures, then let them structure the Results section. Results reports; it does not explain. Explanation belongs in the Discussion.
- Captions must be **self-contained**: short title, abbreviations expanded, and a statement of what the reader should conclude. A caption that restates the axis labels is wasted space.
- A figure should be readable without the body text, and one claim should use one visual encoding.
- Errors bars, sample sizes, and what the error bars represent must be stated in the caption.
- In the layout: figure text roughly the size of body text; place figures at the top of a page or column; a figure should appear on or near the page of its first mention.

## Banned and overused

Cut these on sight:

- `clearly`, `obviously`, `trivially`, `easily`, `of course` — if it were obvious, you would not need to say so.
- `it is important to note that`, `in order to` (use "to"), `for various reasons`.
- **Non-referential `this`** as a bare subject. Say what "this" refers to.
- Self-praise: `novel`, `powerful`, `state-of-the-art`, `significant improvement` — state the number and let the reader judge.
- `existing work` — use `previous work`.
- Passive voice in technical prose where the actor matters.
- Filler strength adjectives with no number attached: "strict cleaning procedure", "extensive experiments". Give the count or delete the clause.

Tense: present tense to describe the paper and its claims, past tense to describe what was run.

## The reviewer complaints that actually cost points

Ranked roughly by how often they sink a paper:

1. **Contribution unclear.** Fix: contributions on the page early, bulleted, mapped to sections.
2. **Motivation thin.** Fix: answer "why is this hard" before "what we did".
3. **Difference from prior work unexplained.** Fix: relationship sentences plus a matrix.
4. **Evidence does not support the claim.** Fix: align each abstract/introduction claim with a specific result; explicitly enumerate limitations.
5. **Not reproducible.** Fix: hyperparameters, splits, compute, and available code/data; a limitations section that the venue can see.
6. **Overclaiming.** Fix: qualify the claim to what the evidence licenses. Reviewers rarely penalise a stated limitation; they frequently penalise a missing one.
7. **Figures unreadable or captioned poorly.** Fix: the caption practice above.

A useful self-check before sending a draft: for each sentence in the abstract and the contributions list, name the table or figure that backs it. Any sentence with no answer is either an overclaim or an under-supported contribution — both are fixable now and expensive later.
