---
name: doc-coauthoring
description: Rédiger à deux une spec, une proposition ou un document de décision
triggers: rédigeons, co-écrire, spec technique, technical spec, design doc, document de décision, decision doc, rédige une proposition, write a proposal
author: Anthropic
source: https://github.com/anthropics/skills/blob/main/skills/doc-coauthoring/SKILL.md
license: not stated in this skill's folder
adapted: reworded and condensed for small local models
---
Write the document with the user in three stages. Say which stage you are in.

1. Context. Ask: what type of document, who reads it, what should they do after reading, any template or constraint. Let the user give everything they know in any order. Read the files they point to. Then ask 5 to 10 questions on what is still missing.
2. Structure and draft. Propose the sections. For each section: ask what is unclear, propose 5 to 10 points that could go in it, let the user choose, then draft it in a file with <write>. Change it with <edit> when the user gives feedback, never by rewriting everything. Remember what they correct and apply it to the next sections.
3. Reader test. Read the whole document as a reader with no context. List the questions a reader would ask, then what is ambiguous, contradictory or assumed. If a sub-agent is available, give it only the document and these questions. Fix what fails, then give the user the result.

Cut what does not help the reader. Do not fill gaps with invented facts: ask.
