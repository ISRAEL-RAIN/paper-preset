/**
 * paper-refs — zero-dependency literature lookup and citation verification.
 *
 * Everything here talks to public scholarly APIs through the Node built-in
 * `fetch`; the preset installs no npm and no pip package, so it is useful the
 * moment it mounts.
 *
 * WHY THESE THREE TOOLS. Reference correctness is the one part of paper
 * writing with an objective ground truth: a citation either resolves to a real
 * record with matching metadata or it does not. That is exactly the class of
 * work a tool should own, and the class a language model is worst at — citing
 * from memory produces entries that look right and do not exist. Everything
 * that has no oracle (novelty, importance, whether a source *supports* a
 * claim) is deliberately NOT automated here; the policy section sends those
 * back to the human.
 *
 * FAILURE IS NEVER SILENTLY A PASS. An unreachable service yields
 * `service_error`, never `verified`. A citation nobody could check must read
 * as unchecked.
 *
 * SOURCE CHOICE. OpenAlex is the primary search index (free, no key, polite
 * pool via `mailto`). Crossref answers DOI lookups, but arXiv's `10.48550/*`
 * DOIs are NOT in Crossref — they live at DataCite — so a DataCite fallback
 * is mandatory, not optional. Semantic Scholar is not used: without an API key
 * it rate-limits with HTTP 429 immediately.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'paper-refs'

/** The tool registry must exist before these tools can register. */
export const inject = ['tools']

const TIMEOUT_MS = 20000
const TITLE_STRONG = 0.85
const TITLE_WEAK = 0.7
const MAX_ENTRIES = 60
const CONCURRENCY = 4

/**
 * Contact address sent to the public scholarly APIs.
 *
 * OpenAlex, Crossref, and DataCite are free but ask callers to identify
 * themselves, so they can contact you before throttling rather than after. A
 * placeholder is fine for one person trying the preset; a DEPLOYMENT THAT
 * SHIPS THIS TO OTHERS MUST SET A REAL, MONITORED ADDRESS HERE. Getting this
 * wrong is how a product gets silently rate-limited.
 */
const CONTACT_EMAIL = 'noreply@example.com'

/** The user-agent every request carries. */
const USER_AGENT = `dsh-paper-preset/0.1 (mailto:${CONTACT_EMAIL})`

/**
 * The installed preset version, read from `INSTALLED.json` beside this file.
 *
 * Read at CALL time and never hard-coded, so shipping a new version is a
 * metadata change rather than a code change. That matters more than it looks:
 * DSH loads these modules through a plain `import()` and Node caches them for
 * the life of the process, so ANY edit here costs every deployment a restart.
 * Keeping the version out of the code means version bumps land on the next
 * session while only real logic changes require a restart.
 */
function installedVersion() {
  try {
    const fs = process.getBuiltinModule('node:fs')
    const path = process.getBuiltinModule('node:path')
    const url = process.getBuiltinModule('node:url')
    const file = path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'INSTALLED.json')
    const match = fs.readFileSync(file, 'utf8').match(/"version"\s*:\s*"([^"]+)"/)
    return match === null ? 'unknown' : match[1]
  } catch {
    return 'unknown'
  }
}

/** Minimal JSON schema compiler for tool parameters (zero dependencies). */
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const property = { type: meta.type }
    if (meta.description) property.description = meta.description
    properties[key] = property
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/** The shared text output contract for every tool in this file. */
const TEXT_OUTPUT = {
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

/** Fetch JSON, distinguishing "no such record" from "could not ask". */
async function httpJson(url, outerSignal) {
  const signal = outerSignal ?? (typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(TIMEOUT_MS) : undefined)
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal,
    })
    if (!response.ok) return { ok: false, status: response.status }
    return { ok: true, status: response.status, data: await response.json() }
  } catch (error) {
    return { ok: false, status: 0, error: String((error && error.message) || error) }
  }
}

/** True when the attempt means "the service was unreachable", not "no such record". */
function unavailable(attempt) {
  return attempt.status === 0 || attempt.status === 429 || attempt.status >= 500
}

/** Every attempt failed for a service reason rather than a real miss. */
function allUnavailable(attempts) {
  return attempts.length > 0 && attempts.every(unavailable)
}

// ── normalisation ───────────────────────────────────────────────────────────

function cleanDoi(value) {
  return String(value ?? '')
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .trim()
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim()
}

/** Levenshtein distance over two short strings (titles, surnames). */
function levenshtein(left, right) {
  if (left === right) return 0
  if (left.length === 0) return right.length
  if (right.length === 0) return left.length
  let previous = new Array(right.length + 1)
  for (let j = 0; j <= right.length; j += 1) previous[j] = j
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution)
    }
    previous = current
  }
  return previous[right.length]
}

/** 1.0 means identical titles after normalisation. */
function titleSimilarity(left, right) {
  const a = normalizeText(left)
  const b = normalizeText(right)
  if (a.length === 0 || b.length === 0) return 0
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length)
}

/** A comparable surname, handling both "First Last" and BibTeX "Last, First". */
function surname(value) {
  const cleaned = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (cleaned.length === 0) return ''
  if (/[\u4e00-\u9fff]/.test(cleaned)) return cleaned.replace(/\s+/g, '')
  // BibTeX writes `author = {Amershi, Saleema}`: the surname is BEFORE the comma.
  const head = cleaned.includes(',') ? cleaned.slice(0, cleaned.indexOf(',')) : cleaned
  const parts = head.trim().split(' ').filter(Boolean)
  return normalizeText(parts[parts.length - 1] || '')
}

/** Split a BibTeX `author` field on the ` and ` separator. */
function splitAuthors(value) {
  return String(value ?? '')
    .split(/\s+and\s+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

// ── source-specific record shapes ───────────────────────────────────────────

function recordFromOpenAlex(work) {
  const location = work && work.primary_location ? work.primary_location : undefined
  const source = location && location.source ? location.source : undefined
  const authorships = work && Array.isArray(work.authorships) ? work.authorships : []
  return {
    title: (work && (work.title || work.display_name)) || '',
    doi: cleanDoi(work && work.doi),
    year: work && typeof work.publication_year === 'number' ? work.publication_year : undefined,
    venue: (source && source.display_name) || '',
    authors: authorships.map((entry) => (entry && entry.author && entry.author.display_name) || '').filter(Boolean),
    type: (work && work.type) || '',
    citedBy: work && typeof work.cited_by_count === 'number' ? work.cited_by_count : undefined,
    url: (work && work.id) || '',
  }
}

function recordFromCrossref(message) {
  const parts = message && message.issued && message.issued['date-parts'] ? message.issued['date-parts'][0] : undefined
  const authors = message && Array.isArray(message.author) ? message.author : []
  return {
    title: Array.isArray(message && message.title) ? message.title[0] || '' : String((message && message.title) || ''),
    doi: cleanDoi(message && message.DOI),
    year: parts && typeof parts[0] === 'number' ? parts[0] : undefined,
    venue: Array.isArray(message && message['container-title']) ? message['container-title'][0] || '' : '',
    authors: authors.map((entry) => [entry.given, entry.family].filter(Boolean).join(' ')).filter(Boolean),
    type: (message && message.type) || '',
    url: (message && message.URL) || '',
  }
}

function recordFromDatacite(attributes) {
  const titles = attributes && Array.isArray(attributes.titles) ? attributes.titles : []
  const creators = attributes && Array.isArray(attributes.creators) ? attributes.creators : []
  return {
    title: (titles[0] && titles[0].title) || '',
    doi: cleanDoi(attributes && attributes.doi),
    year: attributes && attributes.publicationYear,
    venue: (attributes && attributes.publisher) || '',
    authors: creators.map((entry) => entry.name || [entry.givenName, entry.familyName].filter(Boolean).join(' ')).filter(Boolean),
    type: (attributes && attributes.types && attributes.types.resourceTypeGeneral) || '',
    url: (attributes && attributes.url) || '',
  }
}

// ── resolution ──────────────────────────────────────────────────────────────

/** Resolve a DOI through Crossref, then DataCite, then OpenAlex. */
async function resolveDoi(doi, signal) {
  const clean = cleanDoi(doi)
  const attempts = []

  const crossref = await httpJson(`https://api.crossref.org/works/${encodeURIComponent(clean)}`, signal)
  if (crossref.ok && crossref.data && crossref.data.message) {
    return { record: recordFromCrossref(crossref.data.message), source: 'Crossref', attempts }
  }
  attempts.push({ source: 'Crossref', status: crossref.status })

  // Required for arXiv 10.48550/* DOIs, which Crossref does not hold.
  const datacite = await httpJson(`https://api.datacite.org/dois/${encodeURIComponent(clean)}`, signal)
  if (datacite.ok && datacite.data && datacite.data.data && datacite.data.data.attributes) {
    return { record: recordFromDatacite(datacite.data.data.attributes), source: 'DataCite', attempts }
  }
  attempts.push({ source: 'DataCite', status: datacite.status })

  const openalex = await httpJson(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(clean)}`, signal)
  if (openalex.ok && openalex.data && openalex.data.id) {
    return { record: recordFromOpenAlex(openalex.data), source: 'OpenAlex', attempts }
  }
  attempts.push({ source: 'OpenAlex', status: openalex.status })

  return { record: null, source: null, attempts }
}

/** Search by title through OpenAlex, then Crossref. */
async function searchByTitle(query, limit, signal) {
  const attempts = []
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=${limit}&mailto=${encodeURIComponent(CONTACT_EMAIL)}`
  const openalex = await httpJson(url, signal)
  if (openalex.ok && openalex.data && Array.isArray(openalex.data.results) && openalex.data.results.length > 0) {
    return { records: openalex.data.results.map(recordFromOpenAlex), source: 'OpenAlex', attempts }
  }
  attempts.push({ source: 'OpenAlex', status: openalex.status })

  const crossref = await httpJson(
    `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=${limit}`,
    signal,
  )
  if (crossref.ok && crossref.data && crossref.data.message && Array.isArray(crossref.data.message.items)) {
    return { records: crossref.data.message.items.map(recordFromCrossref), source: 'Crossref', attempts }
  }
  attempts.push({ source: 'Crossref', status: crossref.status })

  return { records: [], source: null, attempts }
}

// ── comparison ──────────────────────────────────────────────────────────────

/**
 * Compare the user's fields against the authoritative record.
 *
 * `verified` means "this work exists and the metadata you gave matches it".
 * It never means "this work supports your claim" — no API can answer that.
 */
function compareFields(provided, record) {
  const differences = []

  if (provided.title && record.title) {
    const score = titleSimilarity(provided.title, record.title)
    if (score < TITLE_STRONG) {
      differences.push({
        field: 'title',
        severity: score < TITLE_WEAK ? 'high' : 'medium',
        yours: provided.title,
        found: record.title,
        similarity: Number(score.toFixed(3)),
      })
    }
  }

  if (provided.year && record.year && Number(provided.year) !== Number(record.year)) {
    differences.push({ field: 'year', severity: 'medium', yours: provided.year, found: record.year })
  }

  if (provided.firstAuthor && record.authors.length > 0) {
    const mine = surname(provided.firstAuthor)
    // Containment, not equality: "van der Berg" should match "Berg", and a
    // middle initial should not turn a correct author into a mismatch.
    const matched = record.authors
      .map(surname)
      .some((name) => name === mine || (mine.length >= 3 && (name.includes(mine) || mine.includes(name))))
    if (mine && !matched) {
      differences.push({
        field: 'first author',
        severity: 'high',
        yours: provided.firstAuthor,
        found: record.authors.slice(0, 4).join(', '),
      })
    }
  }

  if (provided.venue && record.venue) {
    const mine = normalizeText(provided.venue)
    const theirs = normalizeText(record.venue)
    if (mine && theirs && !theirs.includes(mine) && !mine.includes(theirs)) {
      differences.push({ field: 'venue', severity: 'low', yours: provided.venue, found: record.venue })
    }
  }

  return differences
}

/** A preprint that has since appeared in a venue: same work, better entry. */
function isPreprintUpgrade(provided, record, differences) {
  if (differences.length === 0) return false
  if (!differences.every((entry) => entry.field === 'year')) return false
  const delta = Number(record.year) - Number(provided.year)
  return delta >= 1 && delta <= 2 && Boolean(record.venue)
}

/**
 * An exact title whose year is far off is usually the INDEX, not the reference.
 *
 * Free indexes carry duplicate and mis-indexed records for well-known papers —
 * same title, same authors, a junk DOI, and a year years away from the real
 * one. Reporting that as a confident field mismatch would blame the user for
 * the index's error, so it gets its own signal.
 */
function isIndexSuspect(via, weakMatch, differences, provided, record) {
  if (via !== 'title' || weakMatch) return false
  if (differences.length === 0) return false
  if (!differences.every((entry) => entry.field === 'year')) return false
  return Math.abs(Number(record.year) - Number(provided.year)) > 2
}

/**
 * Score title-search candidates.
 *
 * Pure relevance is not enough. Indexes carry duplicates and mis-titled
 * records, and an exact-title duplicate from a later year can outrank the real
 * paper — so a match on the user's own year, then citation count, break the
 * tie. The caller decides which similarity is good enough to act on; this
 * function only orders them.
 */
function scoreCandidates(records, provided) {
  return records
    .map((candidate) => {
      const similarity = titleSimilarity(provided.title, candidate.title)
      const yearBonus =
        provided.year && candidate.year && Number(provided.year) === Number(candidate.year) ? 0.03 : 0
      return { candidate, similarity, score: similarity + yearBonus }
    })
    .sort(
      (left, right) =>
        right.score - left.score || (right.candidate.citedBy ?? 0) - (left.candidate.citedBy ?? 0),
    )
}

/** Decide the status from the resolution outcome and the field comparison. */
function decideStatus(attempts, record, differences) {
  if (!record) return allUnavailable(attempts) ? 'service_error' : 'not_found'
  if (differences.length === 0) return 'verified'
  return 'mismatch'
}

/** Render one authoritative record as the compact block the model reads. */
function formatRecord(record, source) {
  const authors = record.authors.length > 0
    ? record.authors.slice(0, 3).join(', ') + (record.authors.length > 3 ? ', et al.' : '')
    : '(no author metadata)'
  const lines = [
    `  title : ${record.title || '(none)'}`,
    `  authors: ${authors}`,
    `  year  : ${record.year ?? '(none)'}`,
    `  venue : ${record.venue || '(none)'}`,
    `  type  : ${record.type || '(none)'}`,
  ]
  if (record.doi) lines.push(`  doi   : ${record.doi}`)
  if (typeof record.citedBy === 'number') lines.push(`  cited : ${record.citedBy}`)
  if (source) lines.push(`  source: ${source}`)
  return lines.join('\n')
}

// ── BibTeX reading ──────────────────────────────────────────────────────────

/** Split a .bib file into entries, tracking brace depth and quoted strings. */
function parseBibEntries(text) {
  const entries = []
  const opener = /@([A-Za-z]+)\s*\{/g
  let match = opener.exec(text)
  while (match !== null) {
    const type = match[1].toLowerCase()
    if (type === 'comment' || type === 'preamble' || type === 'string') {
      match = opener.exec(text)
      continue
    }
    const bodyStart = match.index + match[0].length
    let depth = 1
    let index = bodyStart
    let quoted = false
    while (index < text.length && depth > 0) {
      const char = text[index]
      if (char === '"' && text[index - 1] !== '\\') quoted = !quoted
      else if (!quoted && char === '{') depth += 1
      else if (!quoted && char === '}') depth -= 1
      index += 1
    }
    const body = text.slice(bodyStart, index - 1)
    const comma = body.indexOf(',')
    const key = (comma === -1 ? body : body.slice(0, comma)).trim()
    const fields = comma === -1 ? {} : parseBibFields(body.slice(comma + 1))
    if (key.length > 0) entries.push({ key, type, fields })
    match = opener.exec(text)
  }
  return entries
}

/** Parse `name = {value}` / `name = "value"` pairs out of one entry body. */
function parseBibFields(text) {
  const fields = {}
  let cursor = 0
  while (cursor < text.length) {
    const equals = text.indexOf('=', cursor)
    if (equals === -1) break
    const fieldName = text.slice(cursor, equals).replace(/[,\s]/g, '').toLowerCase()
    if (fieldName.length === 0) {
      cursor = equals + 1
      continue
    }
    let index = equals + 1
    while (index < text.length && /\s/.test(text[index])) index += 1
    let value = ''
    if (text[index] === '{') {
      let depth = 0
      const start = index + 1
      while (index < text.length) {
        if (text[index] === '{') depth += 1
        else if (text[index] === '}') {
          depth -= 1
          if (depth === 0) break
        }
        index += 1
      }
      value = text.slice(start, index)
      index += 1
    } else if (text[index] === '"') {
      const start = index + 1
      index += 1
      while (index < text.length && text[index] !== '"') index += 1
      value = text.slice(start, index)
      index += 1
    } else {
      const start = index
      while (index < text.length && text[index] !== ',' && text[index] !== '\n') index += 1
      value = text.slice(start, index)
    }
    fields[fieldName] = value.replace(/[{}]/g, ' ').replace(/\s+/g, ' ').trim()
    const next = text.indexOf(',', index)
    if (next === -1 || next < cursor) break
    cursor = next + 1
  }
  return fields
}

/** Collect the citation keys a LaTeX source actually uses. */
function citedKeys(texText) {
  const keys = new Set()
  const pattern = /\\(?:cite|citep|citet|autocite|parencite|textcite|footcite)\*?(?:\[[^\]]*\])*\s*\{([^}]*)\}/g
  let match = pattern.exec(texText)
  while (match !== null) {
    for (const raw of match[1].split(',')) {
      const key = raw.trim()
      if (key.length > 0) keys.add(key)
    }
    match = pattern.exec(texText)
  }
  return keys
}

/** Turn one BibTeX entry into the field set `ref_verify` compares on. */
function providedFromEntry(entry) {
  return {
    title: entry.fields.title || '',
    doi: cleanDoi(entry.fields.doi),
    year: entry.fields.year || '',
    firstAuthor: splitAuthors(entry.fields.author)[0] || '',
    venue: entry.fields.journal || entry.fields.booktitle || entry.fields.publisher || '',
  }
}

/** The shared verification core used by both `ref_verify` and `bib_check`. */
async function verifyOne(provided, signal) {
  const attempts = []
  let record = null
  let source = null
  let via = null
  let weakMatch = false
  let closest = null
  let alternatives = []

  if (provided.doi) {
    const resolved = await resolveDoi(provided.doi, signal)
    record = resolved.record
    source = resolved.source
    via = record ? 'doi' : null
    attempts.push(...resolved.attempts)
  }

  if (!record && provided.title) {
    const search = await searchByTitle(provided.title, 5, signal)
    attempts.push(...search.attempts)
    const scored = scoreCandidates(search.records, provided)
    if (scored.length > 0) closest = scored[0].candidate

    const usable = scored.filter((entry) => entry.similarity >= TITLE_WEAK)
    if (usable.length > 0) {
      record = usable[0].candidate
      // A 0.70-0.85 title match is a *similar* title, not this title. Say so
      // rather than reporting a confident mismatch against the wrong paper.
      weakMatch = usable[0].similarity < TITLE_STRONG
      source = search.source
      via = 'title'
      alternatives = usable.slice(1, 4).map((entry) => entry.candidate)
      if (closest && closest !== record && !alternatives.includes(closest)) {
        alternatives = [closest, ...alternatives].slice(0, 3)
      }
    }
  }

  if (!record) {
    return {
      status: allUnavailable(attempts) ? 'service_error' : 'not_found',
      record: null,
      source: null,
      via,
      weakMatch: false,
      indexSuspect: false,
      closest,
      differences: [],
      alternatives: [],
      attempts,
    }
  }

  const differences = compareFields(provided, record)
  const base = {
    record,
    source,
    via,
    weakMatch,
    indexSuspect: isIndexSuspect(via, weakMatch, differences, provided, record),
    closest,
    differences,
    alternatives,
    attempts,
  }
  if (differences.length === 0) return { status: 'verified', ...base }
  if (isPreprintUpgrade(provided, record, differences)) return { status: 'updated', ...base }
  return { status: 'mismatch', ...base }
}

// ── tool registration ───────────────────────────────────────────────────────

/** Register the three literature tools. */
export function apply(ctx) {
  ctx.tools.register({
    name: 'ref_find',
    description:
      'Search scholarly literature (OpenAlex primary, Crossref fallback) and return structured metadata for the best matches. Use this BEFORE writing any citation: entries must come from a tool result, never from memory. Accepts a topic, a paper title, or a DOI.',
    parameters: toJsonSchema({
      query: { type: 'string', required: true, description: 'topic, paper title, or DOI to look up' },
      limit: { type: 'number', description: 'max results, 1-10 (default 5)' },
    }),
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const query = String(args.query || '').trim()
      if (query.length === 0) return { text: 'ref_find needs a non-empty query.' }
      const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10)
      const signal = exec && exec.signal ? exec.signal : undefined

      // A DOI handed to a search tool should just be resolved.
      if (/^(https?:\/\/(dx\.)?doi\.org\/|doi:)?10\.\d{4,9}\//i.test(query)) {
        const resolved = await resolveDoi(query, signal)
        if (!resolved.record) {
          const status = allUnavailable(resolved.attempts) ? 'service_error' : 'not_found'
          return { text: `status: ${status}\nNo record resolved for DOI ${cleanDoi(query)}.` }
        }
        return { text: `status: verified\n${formatRecord(resolved.record, resolved.source)}` }
      }

      const search = await searchByTitle(query, limit, signal)
      if (search.records.length === 0) {
        const status = allUnavailable(search.attempts) ? 'service_error' : 'not_found'
        const detail = search.attempts.map((entry) => `${entry.source}=${entry.status}`).join(', ')
        return {
          text:
            `status: ${status}\nNo match for "${query}" (attempts: ${detail}).\n` +
            (status === 'service_error'
              ? 'The sources were unreachable — this is NOT evidence that the work does not exist.'
              : 'Try a shorter query, or check the title spelling.'),
        }
      }

      const blocks = search.records.map((record, index) => `[${index + 1}]\n${formatRecord(record, undefined)}`)
      return {
        text:
          `${search.records.length} result(s) from ${search.source} for "${query}":\n\n${blocks.join('\n\n')}\n\n` +
          'Cite only from these records. Run ref_verify on the one you pick before writing it into a manuscript.',
      }
    },
  })

  ctx.tools.register({
    name: 'ref_verify',
    description:
      'Verify one reference against authoritative registries (Crossref, DataCite, OpenAlex). Returns status verified / updated / mismatch / not_found / service_error plus any field differences. "verified" means the work EXISTS and the metadata matches — it does NOT mean the work supports your claim.',
    parameters: toJsonSchema({
      doi: { type: 'string', description: 'DOI, with or without the https://doi.org/ prefix' },
      title: { type: 'string', description: 'paper title, used when there is no DOI' },
      authors: { type: 'string', description: 'author list or first author, e.g. "Vaswani" or "Ashish Vaswani"' },
      year: { type: 'string', description: 'publication year' },
      venue: { type: 'string', description: 'journal, conference, or publisher' },
    }),
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const provided = {
        doi: cleanDoi(args.doi),
        title: String(args.title || '').trim(),
        year: String(args.year || '').trim(),
        firstAuthor: splitAuthors(args.authors)[0] || String(args.authors || '').trim(),
        venue: String(args.venue || '').trim(),
      }
      if (!provided.doi && !provided.title) {
        return { text: 'ref_verify needs at least a doi or a title.' }
      }

      const result = await verifyOne(provided, exec && exec.signal ? exec.signal : undefined)
      const lines = [`status: ${result.status}`]
      if (result.source) lines.push(`source: ${result.source}`)
      if (result.record) lines.push('authoritative record:', formatRecord(result.record, result.source))

      if (result.differences.length > 0) {
        lines.push('', 'differences:')
        for (const difference of result.differences) {
          const similarity = difference.similarity === undefined ? '' : ` (title similarity ${difference.similarity})`
          lines.push(`  - ${difference.field} [${difference.severity}]${similarity}`)
          lines.push(`      yours: ${difference.yours}`)
          lines.push(`      found: ${difference.found}`)
        }
      }

      if (result.via === 'title') {
        lines.push(
          `matched by: title only (no DOI)${result.weakMatch ? ' — WEAK match, the title is merely similar' : ''}`,
        )
      }

      if (result.via === 'title' && result.alternatives.length > 0) {
        lines.push('', 'other candidates in the index (duplicates and mis-indexed records are common):')
        for (const alternative of result.alternatives) {
          lines.push(`  - ${alternative.title} (${alternative.year ?? '?'}) ${alternative.doi || 'no doi'}`)
        }
      }

      if (result.status === 'service_error') {
        lines.push('', 'No source could be reached. This reference is UNCHECKED, not valid — retry before relying on it.')
      } else if (result.status === 'not_found') {
        lines.push('', 'No record found in Crossref, DataCite, or OpenAlex.')
        if (result.closest) {
          lines.push(
            `Closest candidate was "${result.closest.title}" (${result.closest.year ?? '?'}), which is not close enough to count.`,
          )
        }
        lines.push(
          'For a DOI-less entry this is a strong signal of a fabricated or badly mistyped reference — but title matching is weak, so confirm with a DOI before concluding.',
        )
      } else if (result.status === 'updated') {
        lines.push('', 'Same work, later publication year and a venue: the preprint has probably been published. Update the entry.')
      } else if (result.status === 'verified') {
        lines.push('', 'Exists with matching metadata. Support for any specific claim is still unverified.')
      } else if (result.status === 'mismatch' && result.weakMatch) {
        lines.push(
          '',
          'The only candidate found has a SIMILAR title, not the same title. Do not treat this as a finding against the reference — resolve the DOI or the publisher page and retry.',
        )
      } else if (result.status === 'mismatch' && result.indexSuspect) {
        lines.push(
          '',
          'Exact title found, but the year is far off and the only disagreement is the year. Free indexes carry duplicate and mis-indexed records for well-known papers, so this is more likely the index than your reference. Confirm with a DOI or the publisher page.',
        )
      } else if (result.status === 'mismatch' && result.via === 'title') {
        lines.push(
          '',
          'This check matched on TITLE ONLY. Free indexes are unreliable for exact-title lookup — duplicates and mis-indexed records are common, so a field disagreement here may be the index rather than the reference. Confirm with a DOI or the publisher page.',
        )
      }

      return { text: lines.join('\n') }
    },
  })

  ctx.tools.register({
    name: 'bib_check',
    description:
      'Audit a .bib file: verify every entry against authoritative registries and report a table of key / status / source / issue. Optionally pass a .tex file to check only the entries actually cited, and to report undefined keys and unused entries. Never reports an unreachable service as passing.',
    parameters: toJsonSchema({
      path: { type: 'string', required: true, description: 'path to the .bib file, relative to the working directory' },
      texPath: { type: 'string', description: 'optional .tex file; limits the audit to cited entries and adds cross-reference checks' },
    }),
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return { text: await runBibCheck(args, exec) }
    },
  })
}

/**
 * Audit one .bib file and render the table.
 *
 * Split out of the tool definition so the `/refs` command imports the same
 * implementation instead of duplicating it, and so this path is directly
 * testable without going through the tool registry.
 */
async function runBibCheck(args, exec) {
  const fs = process.getBuiltinModule('node:fs')
  const path = process.getBuiltinModule('node:path')
  const cwd = (exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd) || process.cwd()
  const resolve = (value) => (path.isAbsolute(value) ? value : path.join(cwd, value))

  const bibPath = resolve(String(args.path || ''))
  if (!fs.existsSync(bibPath)) return `No such file: ${bibPath}`

  let entries = parseBibEntries(fs.readFileSync(bibPath, 'utf8'))
  if (entries.length === 0) return `No BibTeX entries parsed from ${bibPath}.`

  let texPath = null
  let used = null
  if (args.texPath) {
    texPath = resolve(String(args.texPath))
    if (!fs.existsSync(texPath)) return `No such tex file: ${texPath}`
    used = citedKeys(fs.readFileSync(texPath, 'utf8'))
    entries = entries.filter((entry) => used.has(entry.key))
    if (entries.length === 0) {
      return `None of the ${used.size} cited key(s) in ${texPath} appear in ${bibPath}.`
    }
  }

  const truncated = entries.length > MAX_ENTRIES
  const batch = truncated ? entries.slice(0, MAX_ENTRIES) : entries
  const results = new Array(batch.length)

  // Bounded concurrency: these are public APIs with polite-pool expectations.
  let cursor = 0
  const workers = new Array(Math.min(CONCURRENCY, batch.length)).fill(null).map(async () => {
    while (cursor < batch.length) {
      const index = cursor
      cursor += 1
      const entry = batch[index]
      try {
        const outcome = await verifyOne(providedFromEntry(entry), exec && exec.signal ? exec.signal : undefined)
        results[index] = { entry, outcome }
      } catch (error) {
        results[index] = {
          entry,
          outcome: { status: 'service_error', record: null, source: null, differences: [], error: String((error && error.message) || error) },
        }
      }
    }
  })
  await Promise.all(workers)

  const counts = {}
  for (const result of results) counts[result.outcome.status] = (counts[result.outcome.status] || 0) + 1

  const rows = results.map(({ entry, outcome }) => {
    const differences = outcome.differences
      .map((difference) => `${difference.field}: "${difference.yours}" -> "${difference.found}"`)
      .join('; ')
    const issue =
      outcome.status === 'mismatch'
        ? `${
            outcome.weakMatch
              ? 'WEAK title match, may be the index — '
              : outcome.indexSuspect
                ? 'exact title, year far off — likely an index duplicate — '
                : ''
          }${differences}`
        : outcome.status === 'updated'
          ? `preprint appears published (${outcome.record ? outcome.record.year : '?'})`
          : outcome.status === 'not_found'
            ? 'no record in Crossref/DataCite/OpenAlex'
            : outcome.status === 'service_error'
              ? 'source unreachable — UNCHECKED'
              : ''
    return `| ${entry.key} | ${outcome.status} | ${outcome.source || '-'} | ${issue || '-'} |`
  })

  const header = '| key | status | source | issue |\n|---|---|---|---|'
  const summary = Object.entries(counts).map(([status, count]) => `${status}=${count}`).join(', ')
  const version = installedVersion()
  const label = version === 'unknown' ? 'unversioned' : `v${version}`
  const lines = [`bib_check (paper preset ${label}): ${batch.length} entr${batch.length === 1 ? 'y' : 'ies'} in ${bibPath}`, summary, '', header, ...rows]

  if (used) {
    const defined = new Set(parseBibEntries(fs.readFileSync(bibPath, 'utf8')).map((entry) => entry.key))
    const undefinedKeys = [...used].filter((key) => !defined.has(key))
    const unusedKeys = [...defined].filter((key) => !used.has(key))
    if (undefinedKeys.length > 0) lines.push('', `cited but NOT defined in the .bib: ${undefinedKeys.join(', ')}`)
    if (unusedKeys.length > 0) lines.push('', `defined but never cited: ${unusedKeys.join(', ')}`)
  }

  if (truncated) lines.push('', `Only the first ${MAX_ENTRIES} entries were checked.`)

  const titleOnly = results.filter(
    (result) => result.outcome.via === 'title' && result.outcome.status !== 'service_error',
  ).length
  if (titleOnly > 0) {
    lines.push(
      '',
      `${titleOnly} entr${titleOnly === 1 ? 'y was' : 'ies were'} checked by TITLE ONLY (no DOI). Free indexes are unreliable for exact-title lookup — add DOIs to those entries to raise confidence.`,
    )
  }
  if ((counts.not_found || 0) + (counts.mismatch || 0) > 0) {
    lines.push('', 'not_found or mismatch entries must not be cited until resolved.')
  }
  if (counts.service_error) {
    lines.push('', 'service_error entries are UNCHECKED, not valid — retry them.')
  }
  return lines.join('\n')
}

/** Shared with the `/refs` command so both paths use one implementation. */
export { verifyOne, providedFromEntry, parseBibEntries, citedKeys, runBibCheck, MAX_ENTRIES, CONCURRENCY }
