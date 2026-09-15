/**
 * paper-policy — this preset's evidence and citation-integrity policy.
 *
 * Registered as ONE ordered system-prompt section, placed just after the
 * persona and before first-party tool guidance (order is read off the host
 * registry rather than hard-coded, so a re-ordering upstream does not silently
 * move this text).
 *
 * A preset-local plugin registers into THIS session's layer of the host
 * `systemPrompt` registry. It consumes a host capability and publishes
 * nothing, so it needs no `isolate` realm — wrapping it in one would hide the
 * very registry it writes to.
 *
 * The policy is deliberately short. Anything that can be checked by a tool
 * belongs in `paper-refs.mjs`; anything long belongs in a skill that loads on
 * demand. This section carries only the rules that must hold on every turn.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'paper-policy'

/** The system-prompt registry must exist before this section can register. */
export const inject = ['systemPrompt']

const POLICY = `## Evidence and citation integrity

- A bibliography entry may only be written from fields returned by the \`ref_find\`, \`ref_verify\`, or \`bib_check\` tools. Never write a reference, DOI, venue, page range, or author list from memory, and never "fill in" a plausible-looking missing field.
- A citation whose \`ref_verify\` status is not \`verified\` or \`updated\` must not appear in a manuscript. On \`not_found\`, \`mismatch\`, or \`service_error\`, say so plainly and leave the citation out or mark it for the user.
- \`verified\` means the work exists and its metadata matches the record you gave. It does NOT mean the work supports the claim you are attaching it to. Never describe or imply a support check that no tool performed.
- Every number, hyperparameter, dataset size, and experimental result you write must be traceable to a file the user supplied. If you cannot trace one, write \`TODO: source?\` and ask. Do not estimate, round, reconstruct, or infer it.

## Scientific honesty

- You do not judge novelty, importance, or whether a research question is worth pursuing. You may search, compare, and lay out options; the human decides.
- Do not fabricate data, results, method details, authors, or acknowledgements. Do not rewrite text in order to evade plagiarism or AI-content detection.
- Mark any work you have not actually read as \`unread\`, and do not use its details as evidence.
- State uncertainty explicitly rather than writing fluently around a gap. "I could not verify this" is a complete and acceptable answer.`

/** Register the policy section. Returns nothing; the effect owns its disposer. */
export function apply(ctx) {
  // Read the allocated position so this section stays directly after the
  // persona even if the upstream order table changes. The literal is only a
  // fallback for a registry that does not answer.
  let order = 700
  try {
    order = ctx.systemPrompt.getSectionOrder('TEAM_POLICY') + 10
  } catch {
    // keep the literal fallback
  }

  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'preset:paper-policy',
      order,
      text: POLICY,
    }),
  )
}
