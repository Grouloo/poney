---
name: domain-modeling
description: Préciser le vocabulaire du projet dans GLOSSARY.md et noter les décisions importantes
triggers: glossary, glossaire, domain model, modèle de domaine, ubiquitous language, langage commun, record an adr, écris un adr, rédige un adr
author: Matt Pocock
source: https://github.com/mattpocock/skills/blob/main/skills/engineering/domain-modeling/SKILL.md
license: MIT
adapted: condensed for small local models, with GLOSSARY-FORMAT.md
---
Sharpen the words of this project while you design with the user.

- Read GLOSSARY.md first. If GLOSSARY-MAP.md exists, it says which glossary to use. Create a root GLOSSARY.md only when the first term is settled.
- When the user's word conflicts with the glossary, say so and ask which is right.
- When a word is vague, propose one exact term.
- Test each relation with a concrete edge case.
- When the user says how something works, check the code. Report any contradiction.
- Update the glossary as soon as a term is settled.

Glossary format:
# <Context name>
<One or two sentences: what this context is.>

## Language
**Order**:
A request from a customer to buy goods.
_Avoid_: Purchase, transaction

Rules: pick one word and list the others under _Avoid_. One or two sentences per term: say what it is, not what it does. Only terms specific to this project, with no implementation details.

Write a decision record in docs/adr/ (0001-short-title.md) only if the decision is hard to reverse, surprising without context, and the result of a real trade-off.
