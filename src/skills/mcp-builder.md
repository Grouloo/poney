---
name: mcp-builder
description: Créer un serveur MCP avec des outils utilisables par un LLM
triggers: mcp server, serveur mcp, model context protocol
author: Anthropic
source: https://github.com/anthropics/skills/blob/main/skills/mcp-builder/SKILL.md
license: Apache-2.0
adapted: condensed for small local models
---
Build an MCP server in four steps.

1. Plan. Read the current protocol and SDK docs with <fetch> (modelcontextprotocol.io), and the API you wrap. List the operations users need. TypeScript is a good default.
2. Implement. Put the API client, error handling and pagination in shared code. For each tool:
   - A clear name with a common prefix (github_create_issue).
   - A short description of what it does and returns.
   - A strict input schema, with an example for each field.
   - Focused output that does not fill the context: filters and pagination.
   - Error messages that say what to do next.
   - Annotations: read-only, destructive, idempotent.
3. Test. Build it, and call each tool with the MCP Inspector. A server that waits on stdio never returns: run it in the background or with a timeout.
4. Evaluate. Write about 10 realistic read-only questions that need several tool calls, with one checkable answer each. Check that a model can answer them with your tools only.
