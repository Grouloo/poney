---
name: skill-creator
description: Créer un nouveau skill Poney ou améliorer un skill existant
triggers: crée un skill, créer un skill, nouveau skill, create a skill, write a skill, améliore ce skill
author: Anthropic
source: https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md
license: Apache-2.0
adapted: rewritten for Poney's skill format
---
A skill is one Markdown file: `.poney/skills/<name>.md` for this project.

Ask what the skill must do and when it applies, then write:

---
name: short-name
description: one line for the skill menu, in the user's language
triggers: phrase, another phrase
---
Instructions.

Rules:
- `name`: lowercase letters, digits and hyphens. The user calls it with /short-name.
- `triggers`: exact phrases, in each language the user writes. Poney adds the skill to a message that contains one of them. Pick phrases that appear only when the skill applies: a common word adds it by mistake. Without triggers, or with `auto: false`, only /short-name adds it.
- If it comes from elsewhere, add `author`, `source` (URL) and `license`.
- Keep the instructions under 1500 characters. They use the context of a small model.
- Write direct orders in simple sentences. Give the steps and one short example. Explain a rule only when the reason changes what to do.
- Do not invent a tool: use those of your system prompt.

Test it: write two or three requests a user would really type, and check that each one contains a trigger.
