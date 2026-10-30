---
name: unslop
description: Écrire ou relire un texte sans les tics des textes générés par IA
triggers: unslop, relis ce texte, améliore ce texte, rédige le readme, écris le readme, rédige la doc, écris la doc, rédige un article, write the readme, write the docs, proofread
author: Cursor
source: https://github.com/cursor/plugins/blob/main/pstack/skills/unslop/SKILL.md
license: not stated by the source
adapted: reworded and condensed for small local models
---
Write or edit the text so that it reads as if a careful person wrote it. Keep the meaning and the tone.

Remove:
- Inflated words: crucial, delve, pivotal, showcase, vibrant, leverage, utilize, and their equivalents in the user's language.
- "Serves as" where "is" works. "Not just X but Y". Forced groups of three. Several synonyms for one thing.
- Vague sources ("experts say"). Name the source or cut the claim.
- Filler ("it is important to note"), stacked hedges, generic conclusions, chatbot phrases, flattery.
- Em dashes, decorative emojis, needless bold, title case headings, curly quotes.
- Abstract metaphors (landscape, north star, flywheel).

Prefer:
- The fact, number or mechanism over the feeling. If a sentence would fit any project, cut it.
- Active voice, stronger verbs instead of adverbs, one idea per sentence.
- Whole sentences: keep articles and verbs, spell out arrows and abbreviations.
