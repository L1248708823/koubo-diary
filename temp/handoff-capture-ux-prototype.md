# Handoff: 口播日记 · 捕捉端 UX prototype

## Goal for the next session

Build a **throwaway prototype** of the mobile capture page and answer one design question:

> 这套手感我愿不愿意在「灵感稍纵即逝」和「晚上冥想前连续倒几段」时每天用？

Keep the answer; delete or ignore the code afterward. Do **not** implement the processor, AI 整理, diary merge, or real GitHub writes in this session.

## Suggested skills

Invoke these at session start:

1. **`/prototype`** — primary. Throwaway code to settle the capture UX.
2. **`/domain-modeling`** (read-only first) — load glossary from `CONTEXT.md` before naming anything in the UI.
3. Optionally **`/ask-matt`** if you need to re-orient where this sits in the main flow.

When the prototype question is answered, **`/handoff`** conclusions back so the original grill thread can nail 问题 5b and continue. **Write handoff files under this repo's `temp/`**, not the OS temp directory.

## Where we are

Mid **`/grill-with-docs`** on a personal (not commercial) tool. Repo is nearly empty; setup and early domain docs already exist.

**Repo root:** `D:\前端\需求开发文件夹\口播日记`

**Already written (do not re-litigate; read them):**

- `CONTEXT.md` — glossary
- `docs/adr/0001-capture-inbox-processor-writes.md` — capture only creates inbox files; processor owns body writes
- `docs/agents/issue-tracker.md` — local markdown under `.scratch/`
- `docs/agents/domain.md`, `docs/agents/triage-labels.md`
- `CLAUDE.md` — Agent skills index

**Not a git repo yet** in this working folder (user’s real Obsidian vault + Git lives elsewhere on PC; this folder is the design/dev home for the tool idea).

## Project convention (from user)

- Handoff / 交接 files live under **`temp/`** in this project, not the OS temporary directory.
- Create `temp/` if missing.

## Decisions already locked

1. **Scope:** personal tool only (自己开发自己用). Not a multi-user product.
2. **No custom STT.** System speech-to-text / 语音输入法 produces text; our AI may later do a second pass of 整理.
3. **Architecture:** same GitHub-backed vault conceptually:
   - **捕捉端** only **creates** files under 收件箱 (e.g. `_inbox/`)
   - **处理端** (prefer PC, co-located with Obsidian Git auto pull/commit/push) reads inbox → AI 整理 → merge 日记 or file 想法 → clean inbox
4. **Capture shell for v1:** PWA / single-page HTML (add to home screen), not native app, not share-sheet-only.
5. **STT interaction:** text field + system IME voice input; **not** hold-to-talk / in-page recording.

## Open decision this prototype must inform (问题 5b)

Proposed capture UX (user said direction is OK, wants solid submit affordance and UX thought-through from their scenarios):

```
┌─────────────────────────┐
│  口播                    │
├─────────────────────────┤
│  large textarea          │  open → autofocus
│  placeholder ~ 说就行…   │
├─────────────────────────┤
│  [  送进收件箱  ]        │  fixed bottom, full width,
└─────────────────────────┘  high contrast; disabled when empty but always visible
```

Rules under test:

1. Submit control always fixed in thumb zone; disabled-when-empty without layout jump.
2. Success: clear field + brief “已投递” + refocus field (continuous capture).
3. Failure: **never** clear the text; show why.
4. v1: **no** manual 日记/想法分类 on capture (processor decides later) — unless prototype proves user hates this.
5. Optional low-emphasis paste-from-clipboard when empty.
6. No auto-mic, no hold-to-talk.

**User scenarios to validate against:**

- Fleeting inspiration: one-handed, ~5 seconds, open → speak → submit.
- Pre-meditation review: longer, several sequential dumps, same UI, no context switch.

## Prototype brief (keep tight)

**In scope**

- One mobile-first HTML page (PWA shell optional: manifest + standalone display is nice-to-have, not required for the answer).
- Big textarea, autofocus, fixed bottom primary button labeled **送进收件箱**.
- Mock submit: `localStorage` or in-memory list is enough; **do not** wire GitHub API unless it stays trivial and does not distract.
- Success / failure states (failure can be a forced mock toggle).
- Optional: empty-state “粘贴剪贴板” control that does not compete with the primary button.
- After trying it (or walking through interaction), write a short **Answer** section: keep / change what, especially around submit affordance and whether classification belongs on device.

**Out of scope**

- Processor, Claude/API 整理, diary merge, idea folders, background research agents.
- Real vault paths, Obsidian plugins, auth beyond a fake success path.
- Native app, hold-to-talk STT, auto-listen on open.

**Done when**

You can state in one paragraph: “问题 5b 结论是 …；下一回合 grill 应锁定 / 修改 ….”

## Glossary (use these words)

From `CONTEXT.md`: **口播**, **收件箱**, **捕捉端**, **处理端**, **日记**, **想法**, **整理**. Avoid 录音/语音笔记 as names for 口播; avoid calling the inbox temp in product language if the glossary sticks to 收件箱.

## What not to do

- Do not resume full grill of processor/AI/merge rules here.
- Do not treat prototype code as production.
- Do not invent a product/business framing; scope is personal tool.
- Do not re-open ADR-0001 unless the prototype somehow proves capture must write diary bodies (unlikely; push back).

## Return path

After the prototype answer exists, `/handoff` a short conclusions file under `temp/` so the grill session can:

1. Lock 问题 5b
2. Continue with processor trigger (manual vs near-real-time), AI 整理 rules, 日记 vs 想法 classification, whether background research is v1, and low-cost build vs buy leftovers

## Conversation arc (compressed)

User arrived unsure product vs existing methods; has Obsidian knowledge base + 日记 with Git auto sync on PC. Pain: evening reflection / sudden ideas via voice IME → AI clean-up → route to 想法 folder + diary link, or merge into today’s 日记. Optional later: background research after口播. Evaluated existing stack vs build; chose personal minimum loop. Settled capture/processor split because of Obsidian Git conflict risk. Chose PWA capture. Paused at capture UX detail to prototype.
