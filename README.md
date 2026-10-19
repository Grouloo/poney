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
  calibrée sur les comptes réels renvoyés par le serveur. La taille de contexte réellement chargée par le serveur
  (LM Studio, llama.cpp server, vLLM) est détectée et plafonne le réglage. Si le modèle n'arrive pas à écrire le
  résumé, un résumé de secours est construit (demandes, résumé précédent, dernières notes) et la raison est affichée. La taille de réponse demandée s'adapte à la place restante
  (jamais de dépassement de la fenêtre) ; une réponse coupée par la limite n'exécute jamais d'action inachevée,
  et si la coupure vient du manque de place, le contexte est compacté puis l'étape relancée.
- **Raisonnement conservé en note courte** : la fin de la réflexion du modèle (~600 caractères, texte simple) est
  gardée devant ses messages, pour qu'il ne reparte pas de zéro après chaque résultat d'outil. Pas la réflexion
  entière : avec Gemma, elle faisait produire au modèle uniquement des tokens invisibles.
- **Outils déclarés nativement** aux modèles LM Studio qui le supportent (`tool_use`).
- **Mode brut pour Gemma dans LM Studio** : le prompt est mis en forme avec le gabarit du modèle (SDK) et généré via
  `/v1/completions`, qui renvoie chaque token. L'endpoint chat de LM Studio retenait tout ce qui suivait un début
  d'appel d'outil (parfois ouvert dans la réflexion) : la génération continuait sans que rien ne sorte. La réflexion
  (`<|channel>thought…<channel|>`) est séparée par l'app.
- **Appel en fin de réflexion puis silence** : si le modèle termine sa réflexion (ou sa réponse) par un appel complet
  et que plus rien de visible ne sort pendant 10 s, la génération est arrêtée et l'appel exécuté. Un plan qui cite
  une commande puis continue n'est pas interrompu.
- **Garde-fou** : si le modèle génère sans rien produire de visible, l'app le détecte (45 s après la lecture du
  prompt) et réessaie sans les notes de raisonnement.
- **Cache du serveur préservé** : le début du prompt ne change jamais d'un appel à l'autre (sauf au compactage),
  donc le serveur ne relit que les nouveaux tokens. Le résumé de compactage est demandé dans la continuité de la
  conversation déjà en cache (quelques secondes au lieu de plusieurs minutes de relecture sur du matériel modeste).
- Détection de boucles, relance si le modèle colle du code au lieu de l'écrire.
- Notes de projet lues depuis `AGENTS.md` / `LOCAL_CODEX.md` / `CLAUDE.md`.

## Interface

- **Modifier un message précédent et relancer** (« ✎ Modifier » au survol) : l'agent revient à son état d'avant ce
  message, même à travers un compactage (l'historique remplacé est archivé), et la suite est supprimée. Les fichiers
  déjà modifiés par l'agent ne sont pas restaurés. Les anciennes conversations sont migrées à l'ouverture : point de
  reprise exact si le message est encore dans l'historique, sinon historique reconstruit depuis le fil sauvegardé.
- **Conversations sauvegardées et renommables** (✎ ou double-clic) par dossier de projet (`~/Library/Application Support/local-codex/conversations/`) :
  on peut les rouvrir après redémarrage, l'agent reprend avec son historique.
- **Navigateur de fichiers** qui se met à jour quand l'agent écrit, et révèle le fichier modifié.
- **Interrupteurs Web / Terminal** sous la zone de saisie (et `--no-web` / `--no-shell` en CLI) : un outil désactivé
  disparaît du prompt système (prompt plus court) et est refusé si le modèle l'utilise quand même.
- **Prompt système éditable par conversation** (bouton « Prompt système ») : on voit le prompt généré, on peut le
  modifier, il est enregistré avec la conversation. Un badge « modifié » signale un prompt personnalisé.
- **Jauge de contexte** sous la saisie (le trait marque le seuil de compactage) ; un clic compacte à la demande.
  Les résumés apparaissent dans le fil, dépliables.
- **Progression de la lecture du prompt** (LM Studio) : pourcentage et temps restant estimé dans la barre d'état
  avant le premier token. LM Studio est détecté automatiquement derrière « Compatible OpenAI » : le prompt est lu via
  son SDK (qui donne la progression) puis la réponse est générée en HTTP en réutilisant ce cache. La génération ne
  passe pas par le SDK, que LM Studio coupe après ~5 min. Les autres serveurs n'exposent pas cette information.
- **Flux coupé par le serveur** : ce qui était déjà écrit est conservé et les actions complètes sont exécutées.
- **Appels d'outils natifs compris** : si le modèle utilise son format natif (Gemma `<|tool_call>…`, Hermes/Qwen
  `<tool_call>{json}`, champs `tool_calls` des API OpenAI/Ollama), l'appel est converti dans nos balises.
- **Temps et vitesse** : chronomètre dans la barre d'état pendant la réponse, puis une ligne sous la réponse finale :
  durée totale, tokens et tokens/s sur l'ensemble des appels au modèle (comptes du serveur, ou estimés « ≈ »).
- **Tor (option)** : recherche web et lecture de pages via le proxy SOCKS de Tor (démon `tor` sur 9050 ou Tor Browser
  sur 9150, détectés automatiquement), noms résolus par Tor (`socks5h`), recherche via le service .onion de
  DuckDuckGo. Si Tor est injoignable, la requête est refusée, jamais envoyée en clair. En option, les commandes du
  terminal reçoivent les variables de proxy (efficace pour curl, git, wget… pas une garantie générale). Le serveur
  de modèles local n'est pas concerné. Bouton de test (IP de sortie vue par check.torproject.org) ; CLI : `--tor`.
  État en direct à côté de l'interrupteur (vert connecté, orange « connexion 45 % », rouge arrêté ou bloqué) : via le
  port de contrôle de Tor (9051 / 9151, authentification par cookie) s'il est activé, sinon par une connexion de test
  au plus toutes les 30 s.
- **Visualiseur** avec coloration syntaxique et aperçu d'images ; les chemins dans les actions de l'agent sont cliquables.

## Structure

- `src/agent/` — cœur indépendant de l'UI (boucle, protocole, outils, client LLM, web)
- `src/main.js`, `src/preload.cjs`, `src/renderer/` — app Electron
- `src/conversations.js`, `src/files.js` — sauvegarde des conversations, accès fichiers pour le visualiseur
- `src/cli.js` — runner en ligne de commande

## Tor sur un réseau qui bloque Tor

Si le service `tor` reste bloqué à 10 % (« Connecting to a relay »), le réseau bloque les relais Tor : il faut des
ponts. Avec Tor Browser installé, on peut réutiliser ses transports et ses ponts intégrés :

```bash
brew install tor
mkdir -p /opt/homebrew/etc/tor/pt
ln -sf "/Applications/Tor Browser.app/Contents/MacOS/Tor/PluggableTransports/lyrebird" /opt/homebrew/etc/tor/pt/lyrebird
```

Puis, dans `/opt/homebrew/etc/tor/torrc` : `ControlPort 127.0.0.1:9051` et `CookieAuthentication 1` (pour l'état de
connexion dans l'app), `UseBridges 1`, les lignes `ClientTransportPlugin … exec
/opt/homebrew/etc/tor/pt/lyrebird` et les lignes `Bridge …` (snowflake, meek, obfs4) de Tor Browser
(`chrome/toolkit/content/global/pt_config.json` dans `Contents/Resources/omni.ja`), puis `brew services restart tor`.
