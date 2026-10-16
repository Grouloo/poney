# Local Codex

Agent de code desktop (style Claude Code / Codex) pensé pour les **petits modèles locaux** :
Ollama, LM Studio, llama.cpp server, vLLM.

```bash
npm install
npm start            # app desktop
npm test             # tests unitaires
node src/cli.js --cwd ./mon-projet --model qwen2.5:14b "tâche"   # mode headless
```

## Ce qui est fait pour les petits modèles

- **Prompt système court** (~600 tokens) avec un exemple, au lieu de plusieurs milliers.
- **Outils en balises texte**, pas en JSON : `<write path="a.py">…</write>`, `<run>…</run>`.
  Le code n'a pas besoin d'être échappé. Le parseur est tolérant : alias (`bash`, `read_file`…),
  arguments en attributs ou en sous-balises, guillemets optionnels, blocs ``` retirés.
- **8 outils seulement** : list, read, search, write, edit, run, web_search, fetch.
- **Édition tolérante** : `<old>` peut avoir une indentation fausse (ré-indentation automatique),
  et en cas d'échec l'agent reçoit les lignes les plus proches du fichier.
- **Vérification syntaxique** automatique après chaque écriture (.py, .js, .json).
- **Barrière de test** : l'agent ne peut pas conclure tant qu'il a du code modifié non exécuté
  avec succès. Si une *commande de test* est configurée, elle est lancée automatiquement et doit passer.
- **Arrêt anticipé** de la génération dès qu'une action nécessite un résultat (pas de résultats inventés).
- **Gestion du contexte** : sorties tronquées, anciens résultats compactés, `num_ctx` réglable (Ollama natif).
- Détection de boucles, relance si le modèle colle du code au lieu de l'écrire.
- Notes de projet lues depuis `AGENTS.md` / `LOCAL_CODEX.md` / `CLAUDE.md`.

## Structure

- `src/agent/` — cœur indépendant de l'UI (boucle, protocole, outils, client LLM, web)
- `src/main.js`, `src/preload.cjs`, `src/renderer/` — app Electron
- `src/cli.js` — runner en ligne de commande
