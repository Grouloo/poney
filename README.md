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
- **Garde-fou contre les réécritures de mémoire** : `<write>` sur un fichier existant est refusé si son contenu
  n'est pas visible dans l'historique (lu avec `<read>` ou écrit par le modèle, et pas effacé par un compactage).
  Une forte réduction d'un fichier (plus de la moitié des lignes) déclenche un avertissement.
- **Barrière de test** : l'agent ne peut pas conclure tant qu'il a du code modifié non exécuté
  avec succès. Si une *commande de test* est configurée, elle est lancée automatiquement et doit passer.
- **Arrêt anticipé** de la génération dès qu'une action nécessite un résultat (pas de résultats inventés).
- **Gestion du contexte** : sorties d'outils bornées, `num_ctx` réglable (Ollama natif), et **compactage** :
  le plus tard possible, quand l'appel suivant ne tiendrait plus dans la fenêtre (réponse minimale + marge
  d'estimation, ~80-84 % d'une fenêtre de 16k), les anciens messages sont remplacés par un résumé (généré par le modèle, validé, avec repli)
  plus des faits extraits mécaniquement (fichiers modifiés, dernières commandes). Compacter rarement mais beaucoup
  garde le début du prompt stable, donc le cache du serveur reste utilisable. L'estimation des tokens est
  calibrée sur les comptes réels renvoyés par le serveur. La taille de réponse demandée s'adapte à la place restante
  (jamais de dépassement de la fenêtre) ; une réponse coupée par la limite n'exécute jamais d'action inachevée,
  et si la coupure vient du manque de place, le contexte est compacté puis l'étape relancée.
- Détection de boucles, relance si le modèle colle du code au lieu de l'écrire.
- Notes de projet lues depuis `AGENTS.md` / `LOCAL_CODEX.md` / `CLAUDE.md`.

## Interface

- **Conversations sauvegardées et renommables** (✎ ou double-clic) par dossier de projet (`~/Library/Application Support/local-codex/conversations/`) :
  on peut les rouvrir après redémarrage, l'agent reprend avec son historique.
- **Navigateur de fichiers** qui se met à jour quand l'agent écrit, et révèle le fichier modifié.
- **Interrupteurs Web / Terminal** sous la zone de saisie (et `--no-web` / `--no-shell` en CLI) : un outil désactivé
  disparaît du prompt système (prompt plus court) et est refusé si le modèle l'utilise quand même.
- **Prompt système éditable par conversation** (bouton « Prompt système ») : on voit le prompt généré, on peut le
  modifier, il est enregistré avec la conversation. Un badge « modifié » signale un prompt personnalisé.
- **Jauge de contexte** sous la saisie (le trait marque le seuil de compactage) ; un clic compacte à la demande.
  Les résumés apparaissent dans le fil, dépliables.
- **Visualiseur** avec coloration syntaxique et aperçu d'images ; les chemins dans les actions de l'agent sont cliquables.

## Structure

- `src/agent/` — cœur indépendant de l'UI (boucle, protocole, outils, client LLM, web)
- `src/main.js`, `src/preload.cjs`, `src/renderer/` — app Electron
- `src/conversations.js`, `src/files.js` — sauvegarde des conversations, accès fichiers pour le visualiseur
- `src/cli.js` — runner en ligne de commande
