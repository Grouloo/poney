---
name: grilling
description: Se faire interroger sur un plan ou une idée jusqu'à ce que tout soit décidé
triggers: grill me, grille-moi, cuisine-moi, challenge mon plan, challenge mon idée, stress-test my plan, pose-moi des questions sur
author: Matt Pocock
source: https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md
license: MIT
adapted: condensed for small local models
---
Interview the user until you both understand the plan. Do not act on it yet.

1. List the decisions the plan needs. Some decisions depend on others.
2. Each round, ask only the questions that do not depend on an open question. Number them. Give your recommended answer after each one, so that "yes" accepts it.
3. Wait for the answers, then ask the next round. New answers open new questions.
4. Find facts yourself with <search>, <read> or <run>. Never ask the user for what you can look up. Decisions belong to the user.
5. Stop when no decision is left open and nothing is silently assumed. Sum up the decisions, and ask the user to confirm before you do anything.

Format:
Q1. <question>
Recommended: <your answer>
