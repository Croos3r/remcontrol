---
name: spec-formatting
description: Use when writing or reviewing a design spec under docs/superpowers/specs/ — keeps markdown tables, lists, and code blocks readable in GitHub rendering.
---

# Spec formatting

Design specs in this repo are read in GitHub's markdown renderer and in the
terminal. Keep them clean so both are scannable.

## Rules

**Prefer definition lists over tables when any cell holds a paragraph.**
A markdown table forces pipe-alignment and column-width fighting; a
"Reasoning" column with a full sentence makes the table unreadable. Use a
table only when every cell is a short phrase (a few words) and columns are
genuinely parallel. Otherwise render the same content as a bold term followed
by the detail:

```markdown
**Decision — choice.**
Reasoning, one or more lines.
```

**Keep tables only when they fit.** A table is fine for compact, parallel
data (gesture -> action, message -> fields, severity -> count). If you find
a cell wrapping past two short lines, convert the table to a definition list
or plain bullets.

**Align table pipes when you do use a table.** Pad cells so the `|` columns
line up vertically. The separator row uses `|---|`; pad header and data rows
to match. Example of a clean compact table:

```markdown
| Gesture | Action |
|---|---|
| 1-finger pan | Move pointer |
| Tap | Left click |
```

**Code blocks over inline for multi-line structure.** Type signatures,
wire formats, and JSON payloads go in fenced code blocks with a language tag.
Never let a multi-line structure dangle inline in a paragraph.

**Diagrams in fenced code blocks.** ASCII architecture diagrams go in a
fenced block (no language tag, or `text`), not in prose. Keep box-drawing
characters aligned within the block.

## Self-check before committing a spec

- Any table with a paragraph-length cell? Convert to definition list.
- Any table with unaligned pipes? Re-pad or convert.
- Any multi-line type/format/payload not in a fenced block? Fence it.
- Diagrams aligned inside their fence?

Fix inline. No separate review pass needed.
