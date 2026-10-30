// What a project's icon can be chosen from: emoji (with French keywords for the
// search) and line icons drawn in a color (16×16, stroked).

export const EMOJIS = [
  ['💻', 'ordinateur code portable'], ['🖥️', 'écran ordinateur bureau'], ['⌨️', 'clavier'], ['📱', 'téléphone mobile app'],
  ['🤖', 'robot ia bot'], ['🧠', 'cerveau ia intelligence'], ['🔧', 'clé outil réparer'], ['🛠️', 'outils bricolage'],
  ['⚙️', 'engrenage réglages config'], ['🔬', 'microscope science recherche'], ['🧪', 'fiole test chimie expérience'], ['🧬', 'adn biologie'],
  ['🔭', 'télescope astronomie'], ['🛰️', 'satellite espace'], ['🚀', 'fusée lancement startup'], ['📦', 'paquet colis package'],
  ['🗄️', 'archive classeur'], ['💾', 'disquette sauvegarde'], ['🔒', 'cadenas sécurité'], ['🔑', 'clé accès'],
  ['📡', 'antenne réseau'], ['🔌', 'prise plugin'], ['🔋', 'batterie énergie'], ['💡', 'ampoule idée'],
  ['🧩', 'puzzle pièce extension'], ['🎛️', 'console réglage audio'], ['📊', 'graphique statistiques données'], ['📈', 'croissance courbe'],
  ['🗂️', 'dossiers classement'], ['📁', 'dossier'], ['📝', 'note texte écrire'], ['📚', 'livres bibliothèque'],
  ['📖', 'livre documentation lecture'], ['✏️', 'crayon écrire'], ['🖌️', 'pinceau peinture'], ['🎨', 'palette design art couleur'],
  ['📷', 'appareil photo'], ['🎬', 'film vidéo cinéma'], ['🎵', 'musique note son'], ['🎮', 'jeu manette'],
  ['🕹️', 'arcade jeu joystick'], ['🎲', 'dé hasard jeu'], ['🧮', 'boulier calcul maths'], ['💰', 'argent finance'],
  ['💳', 'carte paiement banque'], ['🛒', 'panier boutique commerce'], ['🏠', 'maison accueil'], ['🏢', 'bureau entreprise immeuble'],
  ['🏫', 'école éducation'], ['🗺️', 'carte plan géographie'], ['🧭', 'boussole navigation'], ['✈️', 'avion voyage'],
  ['🚗', 'voiture auto'], ['🚲', 'vélo'], ['⚓', 'ancre marine'], ['🛡️', 'bouclier protection sécurité'],
  ['🌱', 'pousse plante jeune'], ['🌿', 'feuille herbe nature'], ['🌳', 'arbre forêt'], ['🌵', 'cactus désert'],
  ['🌸', 'fleur cerisier'], ['🌻', 'tournesol fleur'], ['🍄', 'champignon'], ['🌊', 'vague mer océan'],
  ['🔥', 'feu flamme'], ['⚡', 'éclair rapide électricité'], ['❄️', 'neige flocon froid'], ['☀️', 'soleil'],
  ['🌙', 'lune nuit'], ['⭐', 'étoile favori'], ['🌈', 'arc-en-ciel couleurs'], ['⛅', 'météo nuage soleil'],
  ['🌍', 'terre monde planète'], ['🐍', 'serpent python'], ['🦀', 'crabe rust'], ['🐳', 'baleine docker'],
  ['🐘', 'éléphant postgres php'], ['🦊', 'renard firefox'], ['🐱', 'chat'], ['🐶', 'chien'],
  ['🐝', 'abeille'], ['🦋', 'papillon'], ['🐢', 'tortue lent'], ['🦉', 'hibou chouette sagesse'],
  ['🐙', 'pieuvre poulpe github'], ['🦄', 'licorne'], ['🐴', 'cheval poney'], ['🐧', 'pingouin linux'],
  ['☕', 'café java'], ['🍵', 'thé'], ['🍕', 'pizza'], ['🍔', 'burger'],
  ['🍲', 'marmite recette cuisine'], ['🥐', 'croissant boulangerie'], ['🍰', 'gâteau dessert'], ['🍎', 'pomme fruit'],
  ['🍋', 'citron fruit'], ['🥑', 'avocat'], ['🍺', 'bière'], ['🍷', 'vin'],
  ['⚽', 'football sport ballon'], ['🏀', 'basket sport'], ['🎯', 'cible objectif'], ['🏆', 'trophée victoire'],
  ['🎁', 'cadeau'], ['🎉', 'fête'], ['💬', 'bulle discussion chat'], ['❤️', 'cœur amour'],
  ['💎', 'diamant ruby gemme'], ['🔮', 'boule cristal'], ['🏺', 'vase céramique poterie'], ['🧵', 'fil couture'],
  ['🔔', 'cloche notification'], ['✉️', 'enveloppe mail courrier'], ['📅', 'calendrier agenda date'], ['⏱️', 'chronomètre temps'],
  ['♻️', 'recyclage'], ['✅', 'validé fait'], ['🚧', 'travaux chantier'], ['🧸', 'ours peluche'],
];

export const ICONS = {
  code: ['code', '<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>'],
  terminal: ['terminal console', '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><path d="m4.6 6.4 2 1.7-2 1.7M8.4 10.2h3"/>'],
  branch: ['branche git', '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-3 3-7 4"/>'],
  bug: ['bug insecte', '<rect x="4.5" y="5" width="7" height="8.5" rx="3.5"/><path d="M6 5a2 2 0 0 1 4 0M8 8v5.5M2 8h2.5M11.5 8H14M2.5 12.5l2-1M13.5 12.5l-2-1M2.5 4l2 1.5M13.5 4l-2 1.5"/>'],
  cpu: ['processeur puce matériel', '<rect x="4" y="4" width="8" height="8" rx="1"/><path d="M6.5 1.8V4M9.5 1.8V4M6.5 12v2.2M9.5 12v2.2M1.8 6.5H4M1.8 9.5H4M12 6.5h2.2M12 9.5h2.2"/>'],
  database: ['base de données sql', '<ellipse cx="8" cy="3.8" rx="5" ry="1.8"/><path d="M3 3.8v8.4c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V3.8M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8"/>'],
  server: ['serveur backend', '<rect x="2" y="2.5" width="12" height="4.5" rx="1.2"/><rect x="2" y="9" width="12" height="4.5" rx="1.2"/><path d="M4.5 4.75h.01M4.5 11.25h.01"/>'],
  cloud: ['nuage cloud', '<path d="M4.5 12.5a3 3 0 0 1-.4-6 4 4 0 0 1 7.7-.9 3.2 3.2 0 0 1 .2 6.9z"/>'],
  globe: ['globe web site', '<circle cx="8" cy="8" r="6"/><ellipse cx="8" cy="8" rx="2.6" ry="6"/><path d="M2.3 6h11.4M2.3 10h11.4"/>'],
  cube: ['cube paquet 3d', '<path d="M8 1.8 13.5 5v6L8 14.2 2.5 11V5z"/><path d="M2.5 5 8 8.2 13.5 5M8 8.2v6"/>'],
  book: ['livre documentation', '<path d="M3 2.5h7.5A1.5 1.5 0 0 1 12 4v9.5H4.5A1.5 1.5 0 0 1 3 12z"/><path d="M3 12a1.5 1.5 0 0 1 1.5-1.5H12"/>'],
  pen: ['stylo écrire', '<path d="M10.5 2.5 13.5 5.5 6 13H3v-3z"/><path d="m9 4 3 3"/>'],
  flask: ['fiole science test', '<path d="M6 2h4M6.5 2v4L3 12.5A1 1 0 0 0 3.9 14h8.2a1 1 0 0 0 .9-1.5L9.5 6V2"/><path d="M4.6 10h6.8"/>'],
  rocket: ['fusée lancement', '<path d="M9.5 2.5c2.2.3 3.7 1.8 4 4L9 11 5 7z"/><path d="M5 7 3 7.3 2 9.5l3 .5M9 11l-.3 2-2.2 1-.5-3"/><circle cx="10.5" cy="5.5" r="1"/>'],
  chart: ['graphique données', '<path d="M2.5 2.5v11h11"/><path d="m5 10 2.5-3 2 2 3.5-4.5"/>'],
  bolt: ['éclair rapide', '<path d="M9 1.8 3.6 9h3.6L6.8 14.2 12.4 7H8.7z"/>'],
  leaf: ['feuille nature', '<path d="M3 13c0-6 3.5-9.5 10-10 0 6.5-3.5 10-9 10zM3 13l5.5-5.5"/>'],
  heart: ['cœur', '<path d="M8 13.5S2 10 2 6a3 3 0 0 1 6-1 3 3 0 0 1 6 1c0 4-6 7.5-6 7.5z"/>'],
  star: ['étoile favori', '<path d="m8 2 1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3 4.3 13.3l.8-4.1L2 6.3l4.2-.5z"/>'],
  music: ['musique', '<path d="M6 12V3.5l7-1.5V10"/><circle cx="4.5" cy="12" r="1.5"/><circle cx="11.5" cy="10" r="1.5"/>'],
  camera: ['photo appareil', '<path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h1.8l1-1.5h3.4l1 1.5h1.8A1.5 1.5 0 0 1 14 5.5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/><circle cx="8" cy="8.3" r="2.3"/>'],
  gamepad: ['jeu manette', '<path d="M5 5h6a3 3 0 0 1 3 3v1.5a2 2 0 0 1-3.6 1.2L9.5 9.5h-3l-.9 1.2A2 2 0 0 1 2 9.5V8a3 3 0 0 1 3-3z"/><path d="M5 6.8v2M4 7.8h2M10.5 7.5h.01M11.8 8.5h.01"/>'],
  lock: ['cadenas sécurité', '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/>'],
  mail: ['mail courrier', '<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="m2.5 4.5 5.5 4 5.5-4"/>'],
  home: ['maison accueil', '<path d="M2.5 7.5 8 3l5.5 4.5V13a.5.5 0 0 1-.5.5H9.5v-4h-3v4H3a.5.5 0 0 1-.5-.5z"/>'],
  gear: ['engrenage réglages', '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4"/>'],
  map: ['carte plan', '<path d="M2 4.2 6 2.5l4 1.7 4-1.7v9.3L10 13.5l-4-1.7-4 1.7z"/><path d="M6 2.5v9.3M10 4.2v9.3"/>'],
};

export const ICON_COLORS = ['#8f8e99', '#7fb2ff', '#4cc38a', '#e6b450', '#f78c6c', '#f0616d', '#c792ea', '#89ddff'];

/** An icon of the set as SVG, in its color. */
export function iconSvg(name, color) {
  const icon = ICONS[name];
  if (!icon) return '';
  return `<svg class="proj-icon svg-icon" viewBox="0 0 16 16" style="color:${/^#[0-9a-f]{6}$/i.test(color || '') ? color : 'currentColor'}" aria-hidden="true">${icon[1]}</svg>`;
}
