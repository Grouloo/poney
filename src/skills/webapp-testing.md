---
name: webapp-testing
description: Tester une application web locale dans un vrai navigateur avec Playwright
triggers: playwright, test in the browser, teste dans le navigateur, teste l'interface, test the ui, test the web app, capture d'écran de la page, screenshot of the page
author: Anthropic
source: https://github.com/anthropics/skills/blob/main/skills/webapp-testing/SKILL.md
license: Apache-2.0
adapted: condensed for small local models, without its helper scripts
---
Test the web app with a short Python Playwright script.

- Static HTML: read the file to find the selectors, then write the script.
- Dynamic app: look first, then act.
  1. Start the server in the background, with its output in a file: `npm run dev > /tmp/server.log 2>&1 &`. A command that never returns times out.
  2. Open the page and wait with `page.wait_for_load_state('networkidle')`. Before that, the DOM is not ready.
  3. Take a screenshot, or print `page.content()`, to find the real selectors.
  4. Act with these selectors, and print what you check.

```python
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto('http://localhost:5173')
    page.wait_for_load_state('networkidle')
    page.screenshot(path='/tmp/page.png', full_page=True)
    browser.close()
```

Always run headless and close the browser. Stop the server when you finish. If Playwright is missing, ask before you install it.
