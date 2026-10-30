---
name: research
description: Enquêter sur une question dans les sources officielles et écrire le résultat dans un fichier
triggers: fais une recherche sur, fais des recherches sur, documente-toi sur, renseigne-toi sur, research this, research how, find out in the docs
author: Matt Pocock
source: https://github.com/mattpocock/skills/blob/main/skills/engineering/research/SKILL.md
license: MIT
adapted: for Poney's tools, without a background agent
---
Research the question and keep the findings in one Markdown file.

1. Use primary sources: official docs, source code, specifications. Follow each claim back to the source that owns it. Use <fetch> to open a page: search results are only snippets.
2. If a sub-agent is available, give it this research as its task, so that the reading stays out of this conversation.
3. Write the findings in one Markdown file, with a source link for each claim. Say what you could not confirm.
4. Save it where the project keeps such notes. If there is no such place, use docs/research/ and say where it is.

If you have no internet access, say so and work only from the local files.
