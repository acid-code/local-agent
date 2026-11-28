import type { GallerySkill } from './gallery.js';

const s = (slug: string, name: string, description: string, body: string): GallerySkill => ({ slug, name, description, body: body.trim() });

/** Skills shipped with the gallery. Several personas share some of them (they live in one catalog). */
export const SK = {
  // ── Slides ──
  slides: s('hebrew-slides', 'Presentation Design (Hebrew & English)', 'Design executive, visually rich .pptx presentations and slide decks (מצגת / שקפים) with make_slides and slide_draft: storyboarding, themes, layout variety, real imagery, charts/tables/timelines, RTL Hebrew, and design QA.', `
## When
Use whenever the user asks for a presentation, slide deck, pitch, lecture, or PowerPoint (.pptx), in English or Hebrew (מצגת / שקפים).

## Core Principle (No Text Dumps)
Every slide should look like a magazine spread or keynote slide designed by a visual director — **35–45% clean whitespace**, clear visual hierarchy, and scannable phrasing. Put detailed narration in \`notes\`, NEVER on the slide canvas.

## Step 1 — Storyboard & Palette
1. For decks > 6 slides, propose a quick 1-line slide plan first if scope is ambiguous; otherwise build directly.
2. Pick ONE theme tailored to the topic:
   - **clinical**: Medicine, biotech, pharma, research (teal + deep navy).
   - **ocean**: Business, SaaS, cloud, strategy (cyan + slate).
   - **midnight**: Executive tech, AI, hardware, product launches (dark navy + sky blue).
   - **editorial**: Magazine storytelling, culture, architecture, essays (warm cream + terracotta).
   - **forest**: Sustainability, biology, climate, health (sage green + amber).
   - **royal**: Finance, education, creative keynotes (deep indigo + violet/rose).
   - **warm** / **dark** / **light**: General alternatives.

## Step 2 — Visual Rhythm & Layout Variety
Never put 3 bullets-style slides in a row. Alternate purposefully across these 12 layouts:
- **title**: Hero opening slide — ALWAYS include a striking background photo (\`image: { query: "..." }\` or \`prompt\`).
- **section**: Bold numbered chapter divider to structure multi-part lectures cleanly.
- **split**: Full-height photo/diagram on one half + 3–4 short bullets on the other (workhorse layout!).
- **image**: Full-bleed photographic moment with headline overlay & bottom caption.
- **stats**: 2–4 big-number KPI tiles (\`stats: [{ value: "35%", label: "..." }]\`) + 1–2 takeaway bullets max.
- **comparison**: 2–3 side-by-side columns (\`columns: [{ heading, bullets, accent?: true }]\`) for pros/cons, before/after, or options.
- **timeline**: 3–5 horizontal milestones (\`steps: [{ label?: "Q1", title, detail? }]\`) for roadmaps, mechanisms, or history.
- **table**: Native styled table (\`table: { headers: [...], rows: [[...]] }\`) for specs, pricing, or structured matrices.
- **cards**: 3–6 numbered cards — format each bullet as \`**Short Heading:** concise 6-10 word explanation\` so each card renders with a bold title + clean muted body.
- **chart**: Native PowerPoint chart (\`bar\`, \`line\`, \`pie\`, \`doughnut\`) from REAL verified numbers only, paired with short takeaways.
- **quote**: One powerful pull-quote or thesis statement.
- **bullets**: Clean open-canvas bullets with a subtle accent rail — use sparingly when nothing more visual fits.

## Step 3 — Typography & Image Craft
- **Bullets**: Max **3–4 bullets per slide**, each **≤ 12 words**. Use bold lead-ins (\`**Key driver:** short fact\`) so a viewer grasps the point in 2 seconds.
- **Headlines**: Short, active noun phrases or takeaways (≤ 60 chars). Add \`kicker\` (chapter label above the title) and \`source\` (citation line at the bottom of fact/data slides).
- **Imagery**: At least **60%+ of content slides** should carry a real picture or structured graphic. Use short descriptive **English** keywords for \`image: { query: "semiconductor cleanroom wafer close up" }\` (even on Hebrew decks, because Wikimedia/SearXNG image search returns far better photos in English!), or \`image: { prompt: "..." }\` for conceptual illustrations (specify "no text"). Add \`image.caption\`.
- **Hebrew**: Set \`lang: "he"\` (or \`"auto"\`). Keep modern natural Hebrew, plural audience address, digits for numbers/dates/₪, and right-to-left flow.
- **Large decks (6+ slides)**: Call \`slide_draft\` (\`action: "start"\`, then \`action: "add"\` in batches of 3–5 slides via \`slides: [...]\`), then render once with \`make_slides({ draft_id })\`.

## Step 4 — Mandatory Design QA Loop
Read the \`DESIGN CHECK\` output returned by \`make_slides\`. If ANY slide is flagged bare, repetitive, text-heavy, or missing a picture, call \`read_slides\`, improve the weak slides (split dense points, swap \`bullets\` to \`split\`/\`comparison\`/\`timeline\`/\`cards\`/\`stats\`, add \`image.query\` or \`source\`), and call \`make_slides({ revise_file_id })\` BEFORE giving your final answer.

## Never
- Write raw Python/JS pptxgenjs shell scripts or call localhost HTTP endpoints instead of \`make_slides\`.
- Dump paragraphs onto slides, exceed 5 bullets, or fabricate numbers/charts/sources.
- Ship a plain text-only deck without resolving \`DESIGN CHECK\` warnings.`),
  // ── Research ──
  triangulate: s('source-triangulation', 'Source triangulation', 'Verify a claim with three independent sources of different types before stating it as fact.', `
## When
Any factual claim that matters to a decision: numbers, dates, quotes, "X is the market leader", legal or medical facts.

## Steps
1. Write the claim as one checkable sentence. Split compound claims.
2. Find **three independent sources**, at least one primary:
   - Primary: official site, filing, dataset, paper, statute, the person's own words.
   - Secondary: reputable press or analyst that cites a primary.
   - Independent: a source with no stake (not the vendor, not their PR).
3. Check independence: do two "sources" quote the same press release? Then they count as one.
4. Check freshness: note each source's date. Anything older than 12 months on a fast-moving topic is flagged.
5. Record agreement: all agree / minor differences (state them) / conflict (state both sides).
6. Never fill a gap with a guess. If only one source exists, say "single source".

## Output
| Claim | Source 1 | Source 2 | Source 3 | Agreement |
then the confidence rating (see confidence-rating).`),
  citation: s('citation-format', 'Citation format', 'Cite every claim inline with a numbered source list: title, publisher, date, URL, quote.', `
## Inline
Put [1], [2] right after the sentence the source supports. One claim can carry two numbers.
For files in this app use [file:<id>#<anchor>]; for earlier chat messages use [msg:<id>].

## Source list (end of answer)
[n] Title — Publisher/Author, YYYY-MM-DD. URL
    > "The exact sentence that supports the claim."

## Rules
- Quote, do not paraphrase, in the source list.
- Link the deepest page (the article, not the home page).
- If a page has no date, write "undated" and lower confidence.
- Never cite a page you did not open this turn.`),
  confidence: s('confidence-rating', 'Confidence rating', 'Rate how sure an answer is (High / Medium / Low) with the reason, so readers know what to double-check.', `
## Scale
- **High**: 3+ independent sources agree, at least one primary, recent.
- **Medium**: 2 sources agree, or sources are older/secondary, or minor conflicts.
- **Low**: single source, conflicting sources, undated pages, or inference beyond the sources.

## Format
End the answer with one line:
**Confidence: Medium** — two recent secondary sources agree; no primary filing found.

## Rules
- Rate each key claim separately when they differ.
- Low confidence on anything used for money, health, or legal decisions → say so in the first line, not only at the end.
- Say what would raise confidence ("the 10-K for 2026 would confirm this").`),
  factcheck: s('fact-check', 'Fact-check a claim', 'Check a claim against primary sources and rate it true, mostly true, mixed, false or unproven.', `
1. Quote the claim exactly and say where it came from.
2. Split it into atomic parts (who, what, how much, when).
3. For each part run source-triangulation.
4. Verdict per part and overall: True / Mostly true / Mixed / Mostly false / False / Unproven.
5. Explain the verdict in two sentences, including what is missing or misleading (cherry-picked dates, wrong base, out of context).
6. Cite with citation-format; end with confidence-rating.`),
  summarize: s('summarize-doc', 'Summarize a document', 'Summarize a file, page or transcript into gist, key points, decisions and open questions.', `
## Output template
**Gist** (2 sentences)
**Key points** (3–7 bullets; keep numbers, names and dates exact)
**Decisions / conclusions**
**Open questions / what is unclear**
**Sources**: [file:id#anchor] or URL per point

## Rules
- Do not add facts that are not in the document.
- Keep the document's language unless asked.
- For long documents, summarize per section first, then merge.
- If the document is a meeting transcript, add **Action items** with owner and date.`),
  // ── Planning / ops ──
  plan: s('plan-steps', 'Plan in steps', 'Break a goal into 3–7 ordered steps with owner, date, risk and a first action under 15 minutes.', `
1. Restate the goal and deadline in one line; ask one question if the goal is ambiguous.
2. List 3–7 steps, each "verb + outcome" (e.g. "Draft pricing page copy").
3. For each: owner (you / me / a teammate persona), due date, dependency, risk.
4. Mark the critical path and anything blocked on someone else.
5. Pick a first action that takes under 15 minutes and say it plainly.
6. Offer check-ins with manage_timer (the user approves each timer).

## Output
| # | Step | Owner | Due | Depends on | Risk |
**First action:** …`),
  weeklyReview: s('weekly-review', 'Weekly review', 'Run a weekly review: done, slipped, dropped, lessons and next week\'s top 3.', `
1. Recall last week's goals (memory_file NOTES or search_chats "top 3").
2. Sort into Done / Slipped (why) / Dropped (on purpose).
3. One lesson: what to repeat or stop.
4. Next week's top 3, each with a first step and a day.
5. Save the top 3 to NOTES so next week's review can find them.
6. Offer a Friday timer to repeat this review.`),
  // ── Coding ──
  pet: s('plan-edit-test', 'Plan → edit → test loop', 'Change code safely: read rules and code, plan, make small edits with checkpoints, run tests, report.', `
1. **Read the rules first**: the project rule files in your context (AGENTS.md, .cursor/rules, CLAUDE.md…). They override your habits.
2. **Locate**: grep/glob for the symbols involved; read the files fully before editing.
3. **Plan**: 2–5 bullets — files to touch, the change, how you will test. Use the plan tool for multi-step work.
4. **Edit small**: one logical change per apply_patch. Every edit is checkpointed; the user can roll back a whole reply.
5. **Test**: run the narrowest test first (single test/file), then the package suite, then the typecheck/linter the rules name.
6. **Fix forward** up to 3 tries; then stop and report what fails and why.
7. **Report**: what changed (files), why, what you ran and the result, anything left.`),
  commits: s('commit-hygiene', 'Commit hygiene', 'Make clean commits: one purpose, a clear message, no secrets or generated files, never on main.', `
- Work on a branch: \`git checkout -b feature/<short-name>\` (never commit or push to main; pushes need approval).
- Stage only related files; review \`git diff --staged\` before committing.
- Never commit secrets (.env, keys, tokens), build output, or lockfile churn you did not intend.
- Message: imperative summary ≤ 72 chars ("Fix login redirect loop"), blank line, then why and how in 1–3 lines.
- Follow the repo's convention if the rules name one (Conventional Commits, ticket prefixes).
- One commit per logical change; squash fixups before asking for review.`),
  readRules: s('read-project-rules', 'Read project rules', 'Find and apply a repo\'s rule files before coding: AGENTS.md, .cursor/rules, CLAUDE.md, CONVENTIONS.md and friends.', `
1. Rule files from attached workspaces are already in your context under "Project rules". Read them before the first edit.
2. Glob-scoped rules (".cursor/rules/*.mdc" with globs) apply only when you touch matching files; folder rules (nested CLAUDE.md/AGENTS.md) apply inside that folder.
3. Rules listed as "read when relevant" are not loaded: open them with read_file when the task touches their topic.
4. If no rules are loaded, look for: AGENTS.md, CLAUDE.md, .cursorrules, .cursor/rules/, .github/copilot-instructions.md, GEMINI.md, .windsurfrules, .clinerules, CONVENTIONS.md, CONTRIBUTING.md, package.json scripts.
5. Extract: build/test commands, style rules, forbidden actions, review rules. Follow them over your defaults.
6. If two rules conflict, the more specific (glob/folder) wins; if still unclear, ask.`),
  fixTest: s('fix-failing-test', 'Fix a failing test', 'Reproduce a failing test, find the root cause, fix it minimally and prove it passes.', `
1. Run only the failing test; copy the exact error and stack.
2. Read the test and the code under test. State the root cause in one sentence (not the symptom).
3. Decide: is the code wrong or the test wrong? Change the test only if the behaviour change is intended — say so.
4. Minimal fix with apply_patch; no drive-by refactors.
5. Rerun the test, then its file, then the suite.
6. Report: cause, fix, commands run, results.`),
  reviewDiff: s('review-diff', 'Review a diff', 'Review a change for correctness, security, tests and clarity, with file:line findings.', `
Check in order and stop at nothing:
1. **Correctness**: edge cases (empty, null, large, concurrent), error paths, off-by-one.
2. **Security**: untrusted input, path traversal, injection, secrets in code or logs, auth checks.
3. **Tests**: is the new behaviour covered? Would the test fail without the change?
4. **Clarity**: names, dead code, comments that lie.
Output: list of findings as "file:line — problem — suggested fix", grouped Blocker / Should fix / Nit. Do not restyle code that works.`),
  // ── Writing / outreach ──
  tighten: s('edit-tighten', 'Tighten a draft', 'Edit a draft for clarity and length while keeping the author\'s voice.', `
1. Read the whole draft; note its goal and audience in one line.
2. Cut: filler ("just", "really", "in order to"), hedges, repeated points, throat-clearing intros.
3. Prefer short sentences, active voice, concrete nouns and numbers.
4. Keep the author's words where they work; do not make it sound generic.
5. Never add facts or claims.
Output: the edited text, then 3 bullets on the biggest changes and the new word count vs old.`),
  emailReply: s('email-reply', 'Reply to an email', 'Draft a short reply: the answer first, context if needed, the next step with a date.', `
Template:
- Line 1: the answer or decision.
- 1–3 sentences of context only if the reader needs it.
- Next step, owner and date ("I'll send the draft by Thursday").
- Sign-off matching the sender's formality.
Also offer a one-line variant. Never send it yourself; the user sends.`),
  coldEmail: s('cold-email-framework', 'Personalised cold email', 'Write a cold email that earns a reply: researched hook, one problem, proof, a small ask.', `
## Research first (5 minutes)
Recipient role, company, one recent specific thing (post, launch, hire, funding, talk). No specific hook → do not send yet.

## Structure (≤ 120 words)
1. **Subject**: 3–6 words, specific, lowercase ok ("idea for acme's onboarding").
2. **Hook** (1 sentence): the specific thing you noticed and why it made you write.
3. **Problem** (1–2 sentences): a pain people in their role have, in their words.
4. **Proof** (1 sentence): a concrete result for a similar company, with a number.
5. **Ask** (1 sentence): small and easy — "worth a 15-minute look next week?" Not a demo, not a calendar link in email 1.
6. Sign-off with name and one line of who you are.

## Don'ts
No "I hope this finds you well", no feature lists, no fake familiarity, no attachments in email 1, no claims you cannot back.

## Output
Subject + body, then 2 alternative hooks. Mark any fact that needs checking.`),
  followUp: s('follow-up-cadence', 'Follow-up cadence', 'Plan follow-ups after a cold email: 3 touches over ~2 weeks, each adding something new.', `
| Touch | Day | Channel | Content |
|---|---|---|---|
| 1 | 0 | Email | Cold email (cold-email-framework) |
| 2 | +3 | Email (reply in thread) | One new useful thing: a short insight, case, or resource. ≤ 60 words. |
| 3 | +7 | LinkedIn/other | Light touch: comment or connect with a one-line note. No pitch. |
| 4 | +14 | Email | Break-up: "Should I close the loop on this?" — polite, easy no. |

Rules: stop on any reply (positive or negative) or an unsubscribe request; never send more than 4 touches; log each touch with date in NOTES or the CRM sheet; offer manage_timer reminders for each touch (user approves).`),
  // ── Sales / growth ──
  icp: s('icp-definition', 'Define the ICP', 'Write an ideal customer profile: firmographics, roles, pains, triggers, disqualifiers.', `
Output template:
- **Company**: industry, size (employees/revenue), geography, tech stack signals.
- **Buyer and user roles**: titles, who signs, who uses.
- **Top 3 pains** in their words, with evidence (reviews, posts, calls).
- **Triggers** that make now the right time: funding, hiring for X, new regulation, tool switch.
- **Disqualifiers**: too small, wrong stack, in-house team, competitor contract.
- **Where they hang out**: communities, events, newsletters.
Save the ICP to NOTES so Sell and Outreach use the same one.`),
  leads: s('lead-list-building', 'Build a lead list', 'Find companies and people that match the ICP, with a reason-to-contact for each.', `
1. Load the ICP (NOTES or ask Founder).
2. Search sources: company directories, job posts (hiring signals), launch sites, funding news, community member lists. Respect site terms; no scraping behind logins.
3. For each company: name, site, size, why it fits (1 line), trigger (dated), decision maker role, public profile URL.
4. Score 1–3 on fit and 1–3 on timing; keep only total ≥ 4.
5. Never guess emails; mark "contact: find via site/LinkedIn".
6. Output a table (or write a CSV with write_file) of 10–25 rows, best first. Hand the top 10 to Outreach.`),
  qualify: s('lead-qualification', 'Qualify a lead', 'Qualify a lead with BANT-lite: need, timing, authority, budget signals, next step.', `
For one company or reply:
- **Need**: evidence of the pain (quote/source).
- **Timing**: trigger or deadline, dated.
- **Authority**: who decides; do we have them or an influencer?
- **Budget signals**: funding, team size, current tool spend.
- **Risks**: competitor in place, procurement, security review.
Verdict: Hot / Warm / Nurture / Disqualify, with the next step and date.`),
  experiment: s('growth-experiment', 'Design a growth experiment', 'Turn an idea into a testable experiment: hypothesis, metric, size, duration, decision rule.', `
Template (ICE-scored):
- **Hypothesis**: If we <change> for <audience>, then <metric> will <move> because <reason>.
- **Primary metric** and guardrail metric (one each).
- **Baseline** (current value, source) and **minimum detectable effect**.
- **Audience and size**; duration (at least one full weekly cycle).
- **Decision rule** written before launch: ship / iterate / kill thresholds.
- **ICE**: Impact 1–10, Confidence 1–10, Ease 1–10 → average.
- **Owner and launch date**.
Log it in NOTES; Insights tracks the result in the weekly scorecard.`),
  funnel: s('funnel-audit', 'Audit a funnel', 'Find the biggest leak from visit to paid: step conversion, drop-off reasons, top 3 fixes.', `
1. List funnel steps (visit → signup → activation → paid → retained) and the event that marks each.
2. Get counts for the last 4 weeks per step (from the user's data/CSV or Insights).
3. Compute step-to-step conversion and compare with benchmarks you can cite.
4. The step with the largest absolute loss × fixability is the target.
5. Gather reasons: session notes, support tickets, reviews, a 3-question survey.
6. Propose 3 fixes as growth experiments, ICE-scored.`),
  // ── Product / market ──
  productBrief: s('product-brief', 'Write a product brief', 'One-page brief: problem, user, evidence, solution sketch, success metric, scope and risks.', `
Sections (one page max):
1. **Problem** — who has it, how often, cost of not solving (evidence linked).
2. **Target user** and the job they hire this for.
3. **Solution sketch** — the smallest version that solves the core job; what it is NOT.
4. **Success metric** and target; how it will be measured.
5. **Scope**: must / should / later.
6. **Risks and open questions**; how to de-risk each cheaply.
7. **Launch**: positioning line, channel, owner, date.`),
  positioning: s('positioning-statement', 'Positioning and messaging', 'Write positioning (for/who/unlike/we) and a message house with proof points.', `
1. Positioning: For <target> who <need>, <product> is a <category> that <key benefit>. Unlike <alternative>, we <differentiator>.
2. Message house: one headline promise; 3 pillars, each with 2 proof points (numbers, customer quotes, demos).
3. Words to use / words to avoid (from customer language in reviews and calls).
4. Three headline variants for the landing page and one 10-word elevator line.
Check every claim is provable today.`),
  competitorTeardown: s('competitor-teardown', 'Competitor teardown', 'Tear down a competitor: offer, pricing, landing page, ads, channels, strengths and gaps.', `
For each competitor (max 5):
- **Offer**: core promise, plans, free trial/freemium, guarantees.
- **Pricing**: tiers, price points, value metric, annual discount — with URL and date seen.
- **Landing page**: headline, subhead, primary CTA, proof (logos, numbers), objections handled.
- **Ads**: check public ad libraries (e.g. Meta Ad Library, Google Ads Transparency) — themes, formats, how long running (long-running = likely working).
- **Channels**: SEO keywords they rank for, social presence, communities, partnerships.
- **Reviews**: top praise and top complaints (G2/Capterra/app stores).
Output: comparison table + "Gaps we can own" (3 bullets) + sources list.`),
  pricingResearch: s('pricing-research', 'Pricing research', 'Map market pricing and recommend a structure: value metric, tiers, anchors and tests.', `
1. Collect 5–10 comparable products' public pricing (URL + date): tiers, price, value metric, limits.
2. Normalize to a common unit (per seat/month, per 1k events…).
3. Note packaging patterns: what is gated to higher tiers.
4. Recommend: value metric, 3 tiers (anchor, target, entry), and price points with rationale.
5. Propose one pricing test (growth-experiment) and what would change your mind.`),
  // ── Data / insights ──
  scorecard: s('weekly-scorecard', 'Weekly scorecard', 'Build the weekly metrics scorecard: 5–8 KPIs, target, actual, trend, owner and a one-line why.', `
Template:
| KPI | Target | This week | Last week | 4-wk trend | Status | Owner | Note |
Status: 🟢 on track (≥ target) / 🟡 within 10% / 🔴 off.
Rules:
- Same KPIs and definitions every week (save them in NOTES); change definitions only with a note.
- Every number links to its source (file, sheet, dashboard export).
- Under the table: 3 bullets — biggest win, biggest miss and its likely cause, one decision needed.
- Offer a Monday 9:00 timer to produce it (user approves).`),
  metricDefs: s('metric-definitions', 'Define metrics', 'Write unambiguous metric definitions: formula, source, filters, owner, and gaming risks.', `
For each metric:
- **Name** and one-line meaning.
- **Formula** (numerator / denominator), unit, time window, timezone.
- **Source** table/sheet/event and filters (exclude test accounts, refunds…).
- **Owner** and review cadence.
- **Gaming risk**: how it could be inflated without real progress, and the guardrail metric.
Store the definitions in NOTES so Insights and Growth agree.`),
  anomaly: s('anomaly-check', 'Explain a metric change', 'When a number jumps or drops, check data issues first, then segments, then causes.', `
1. Confirm it is real: tracking changes, missing days, timezone, duplicates, definition change.
2. Size it: absolute and % vs last week and same week last month.
3. Segment: channel, country, device, plan, new vs returning — find where the change lives.
4. Line up events: releases, campaigns, outages, pricing changes, holidays.
5. State the most likely cause with confidence-rating and what data would confirm it.`),
  chartChoice: s('chart-type-selection', 'Choose the right chart', 'Pick a chart from the question being asked: comparison, trend, distribution, part-to-whole, relationship.', `
| Question | Use | Avoid |
|---|---|---|
| Trend over time | Line (≤ 5 series), area for totals | Pie, 3D |
| Compare categories | Horizontal bar, sorted | Radar for > 5 axes |
| Part of a whole | Stacked bar, 100% bar; pie only for 2–3 parts | Donuts with 8 slices |
| Distribution | Histogram, box plot, strip plot | Bar of means only |
| Relationship | Scatter (+ trend line), bubble for a 3rd value | Dual y-axes |
| Ranking | Sorted bar / dot plot | Unsorted bars |
| Geography | Choropleth (normalized per capita) | Raw counts on maps |
Rules: start bar axes at zero; label directly instead of legends when possible; one message per chart, stated in the title ("Signups doubled after launch").`),
  palette: s('accessible-palette', 'Accessible colours', 'Use colour-blind-safe palettes, enough contrast and redundant encodings in every chart.', `
- Categorical (≤ 8): Okabe–Ito — #E69F00 #56B4E9 #009E73 #F0E442 #0072B2 #D55E00 #CC79A7 #000000.
- Sequential: viridis / cividis; diverging: a two-hue palette with a neutral midpoint (e.g. #2166AC → #F7F7F7 → #B2182B).
- Text contrast ≥ 4.5:1 (WCAG AA); lines ≥ 2px; markers distinguishable by shape too.
- Never encode meaning by red/green alone; add labels, patterns or icons.
- Highlight one series in a strong colour and grey out the rest when telling one story.
- Check in grayscale before sharing.`),
  vegaRecipe: s('vega-lite-recipes', 'Vega-Lite and matplotlib recipes', 'Ready recipes for common charts in Vega-Lite (JSON) and matplotlib (Python), accessible by default.', `
## Vega-Lite line chart
\`\`\`json
{"$schema":"https://vega.github.io/schema/vega-lite/v5.json","title":"Weekly signups","data":{"url":"data.csv"},
 "mark":{"type":"line","point":true,"strokeWidth":2},
 "encoding":{"x":{"field":"week","type":"temporal","title":null},
  "y":{"field":"signups","type":"quantitative","title":"Signups"},
  "color":{"field":"channel","type":"nominal","scale":{"range":["#0072B2","#E69F00","#009E73","#CC79A7"]}}}}
\`\`\`
## Vega-Lite sorted bar
\`"mark":"bar","encoding":{"y":{"field":"name","type":"nominal","sort":"-x"},"x":{"field":"value","type":"quantitative"}}\`
## matplotlib bar (sorted, labeled)
\`\`\`python
import matplotlib.pyplot as plt
d = sorted(zip(names, values), key=lambda t: t[1])
fig, ax = plt.subplots(figsize=(7, 4), dpi=150)
ax.barh([n for n, _ in d], [v for _, v in d], color="#0072B2")
for i, (_, v) in enumerate(d): ax.text(v, i, f" {v:,}", va="center")
ax.spines[["top", "right"]].set_visible(False); ax.set_title("Revenue by plan")
fig.tight_layout(); fig.savefig("chart.png")
\`\`\`
Always: title states the takeaway, axis units, source note under the chart, save PNG + the spec/script.`),
  dashboard: s('dashboard-layout', 'Lay out a dashboard', 'Design a dashboard: one question per tile, KPIs top-left, trends next, details last.', `
1. Write the 3 questions the viewer must answer in 10 seconds.
2. Top row: 3–5 KPI tiles (value, delta vs last period, sparkline).
3. Middle: trend charts for those KPIs; bottom: breakdowns and tables.
4. Consistent time range and filters at the top; same colours mean the same thing everywhere.
5. ≤ 9 tiles; anything more goes to a second tab.
Deliver as a wireframe table plus chart specs (vega-lite-recipes).`),
  // ── Everyday ──
  imagePrompt: s('image-prompt', 'Write an image prompt', 'Write a strong image prompt: subject, style, composition, light, palette and negatives.', `
## Template
1. **Subject** doing **action**, **setting**.
2. **Style**: flat vector / watercolor / 35mm photo / 3D clay / pixel art.
3. **Composition**: close-up, centered, rule of thirds, isometric, wide shot.
4. **Lighting**: soft daylight, golden hour, studio, neon.
5. **Palette**: 3–5 colours or a mood.
6. **Avoid**: text, watermarks, extra fingers, clutter.
Then 2 variations that each change one thing (style or composition). Keep the final prompt so the user can reuse it.`),
  iconSet: s('icon-and-logo-brief', 'Icon and logo brief', 'Design icons or logo ideas that read at 32px: one shape, two colours, no text.', `
1. Ask for name, audience, 3 adjectives, colours to avoid.
2. Generate 3 directions: literal symbol, abstract mark, mascot/character.
3. Each must read at 32×32: one silhouette, ≤ 2 colours, no fine lines or text.
4. Show on light and dark backgrounds.
5. Note which direction you recommend and why.`),
  compare: s('compare-products', 'Compare products', 'Compare 2–4 products: price (store, date), key specs, review score, best-for and a pick.', `
1. Confirm the use case and budget in one line; pick the 3 specs that matter for it (not the spec sheet).
2. Find each product's price at 2–3 stores (link + date seen); note shipping and return window.
3. Read reviews: score and count, plus the most common complaint.
4. Fill the table:
| Product | Price (store, date) | Spec 1 | Spec 2 | Spec 3 | Reviews (score, count) | Best for |
5. **Pick** in one line and why; **watch out** (refurbished, third-party seller, warranty, older model year).
Link every price. Never buy anything.`),
  priceWatch: s('price-watch', 'Watch a price', 'Track a product price over time and alert on a drop below a target, using a timer.', `
1. Confirm product, store URL, current price (with date) and target price.
2. Save to NOTES: product | URL | target | last price | date.
3. Offer a timer (e.g. daily 9:00) that re-checks the page with web_fetch and compares.
4. On a drop below target: report old → new price, link, and whether it is the lowest seen.
5. Remove the watch when bought or asked.`),
  correct: s('correct-gently', 'Correct gently', 'Reply naturally in the target language, then list corrections with a one-line rule each.', `
1. Answer the learner's message naturally, at their level (CEFR estimate saved in NOTES).
2. **Corrections**: mistake → correct form → one-line rule. Max 3 per message; prioritize meaning-changing errors.
3. Recycle: reuse one corrected form in your next reply.
4. Save repeated mistakes to NOTES and revisit them weekly.`),
  phrases: s('phrase-drills', 'Phrase drills', 'Teach useful phrases with spaced review: 5 new, 5 review, quick recall test.', `
1. Pick 5 new phrases for the learner's situation (travel, work, family) + 5 due for review from NOTES.
2. Show phrase, translation, one example; ask the learner to use each in a sentence.
3. Quick recall test: translate 5 prompts both directions.
4. Mark each phrase easy/hard; schedule hard ones sooner (save to NOTES with next date).`),
  mealPlan: s('meal-plan', 'Plan meals', 'Plan meals from what is on hand, diet and time, with one shopping list grouped by aisle.', `
1. Ask (or recall) diet, allergies, servings, minutes per meal, and what is in the fridge.
2. Plan 3–7 days; reuse ingredients across meals to cut waste.
3. Each recipe ≤ 8 steps, with prep time and one swap option.
4. One shopping list grouped by aisle, minus what is on hand.
Always respect allergies saved in USER memory.`),
  workout: s('workout-plan', 'Plan a workout', 'Build a safe workout for the person\'s level, time and equipment, with progression.', `
1. Ask level, time, equipment, injuries/limits (not medical advice; suggest a professional for pain or conditions).
2. Structure: warm-up 5 min → main block (3–5 exercises, sets × reps or time) → cool-down.
3. Give form cues (1 line each) and an easier/harder option.
4. Progression for next week (one variable at a time: reps, sets, or load).`),
  categorize: s('categorize-spending', 'Categorize spending', 'Sort transactions into categories with totals, month-over-month changes and flagged charges.', `
1. Read the CSV/statement; detect date, description, amount, currency.
2. Categories: Housing, Utilities, Groceries, Dining, Transport, Subscriptions, Health, Shopping, Travel, Income, Other.
3. Totals per category; compare with last month if known (NOTES).
4. Flag: new subscriptions, duplicates, unusually large charges, foreign fees.
5. Output table + 3 bullets; write a summary CSV with write_file if asked. Keep data local; never upload statements.`),
  budget: s('budget-plan', 'Make a budget', 'Build a simple monthly budget (needs / wants / savings) from income and actual spending.', `
1. Monthly net income (ask; do not guess).
2. Last 1–3 months of categorized spending (categorize-spending).
3. Propose targets: needs, wants, savings/debt — start from actuals, move 5–10% at a time.
4. Show the gap per category and 3 concrete cuts with monthly savings.
5. Save targets to NOTES; offer a monthly check-in timer. Not financial advice.`),
  triage: s('triage-inbox', 'Triage messages', 'Sort messages into Reply today / This week / FYI / Archive with one-line reasons and drafts.', `
1. For each message: sender, topic, what they want, deadline.
2. Bucket: **Reply today** (deadline/VIP/blocking), **This week**, **FYI**, **Archive**.
3. Draft replies only for Reply today (email-reply skill).
4. List anything that needs a calendar slot.
Never send, delete or unsubscribe yourself; the user does.`),
  quiz: s('quiz-me', 'Quiz me', 'Quiz from study material one question at a time, explain answers, track weak topics.', `
1. Build 5–10 questions from the material: mix recall, application and one "explain why".
2. Ask one at a time; wait for the answer.
3. Mark right/partly/wrong; give the correct answer with a one-line why and the source [file:id#anchor].
4. End: score, weak topics, and 3 flashcards for them; save weak topics to NOTES for spaced review.`),
  explain: s('explain-step-by-step', 'Explain step by step', 'Explain a concept from what the learner knows, with an example, a check question and a summary.', `
1. Ask (or infer) what the learner already knows; start one level below.
2. Explain in 3–5 small steps, each with a concrete example or analogy.
3. Check understanding with one question before going deeper.
4. Close with a 2-line summary and one practice problem.`),
  diagnose: s('diagnose-service', 'Diagnose a service', 'Find why a service or container is down: status, logs, resources, config, then a reversible fix.', `
1. Status: docker_ps / docker_inspect (restarts, exit code, health).
2. Logs: last 100 lines; find the first error, not the last.
3. Resources: disk (df -h), memory, port conflicts (ss -ltnp).
4. Config: env vars present (never print secret values), mounts, recent changes.
5. Cause in one line; propose the smallest reversible fix and how to undo it. Destructive steps wait for approval.
6. Verify healthy afterwards and report.`),
  healthCheck: s('box-health-check', 'Box health check', 'Run a routine health check of the machine and services with a traffic-light summary.', `
## Checklist (read-only commands first)
1. Disk per volume: \`df -h\` — warn above 80%, critical above 90%; name the biggest folders with \`du -xh --max-depth=1\`.
2. Memory and swap: \`free -h\` — warn if swap is in steady use.
3. Load: \`uptime\` vs CPU count (\`nproc\`).
4. Services: \`systemctl --failed\`.
5. Containers: docker_ps — anything unhealthy, restarting or exited unexpectedly.
6. Certificates: expiry under 14 days.
7. Updates: pending security updates (\`apt list --upgradable\`).
8. Backups: age of the newest backup; warn if older than 2 days.

## Output
| Check | Status 🟢🟡🔴 | Detail | Fix |
Fixes are proposals; anything destructive waits for approval. Offer a weekly timer for this check (user approves).`),
  businessProfile: s('business-profile', 'Build the business profile', 'Interview the founder and write a one-page business profile the whole team uses.', `
Ask in small batches (max 3 questions at a time):
1. Product in one sentence; who it is for; price.
2. Top 3 customer pains; current alternatives.
3. Traction: customers, revenue/MRR, growth rate, best channel so far.
4. Goals for the next 90 days and constraints (budget, time, team).
5. Voice and tone; words to avoid.
Write the profile (≤ 1 page) and save the core to NOTES so every teammate reads the same facts. Confirm with the founder before saving.`),
  delegate: s('team-delegation', 'Delegate to the team', 'Split a goal across teammate personas with clear briefs, then merge their results.', `
1. Break the goal into workstreams and map each to a teammate:
   Market Researcher (competitors, pricing, channels) · Sell (lead lists) · Outreach (emails, cadences) · Growth (experiments, funnel) · Product (brief, positioning) · Insights (metrics, scorecard) · Visualization (charts) · Researcher (fact checks).
2. Write each brief: goal, inputs (business profile), output format, deadline.
3. Start them with spawn_agent (background) or consult_agent (quick question). Max 3 helpers at once.
4. If a teammate is missing, suggest adding it from the persona gallery (one click) — do not nag.
5. Merge results into one plan with owners and next steps; flag conflicts between teammates.`),
};
