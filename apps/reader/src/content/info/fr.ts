/**
 * About, Privacy and Terms in French: the same pages, facts and section ids as `en.ts`, written
 * for French readers rather than line by line. Interface names follow the fr catalogue
 * (Paramètres → Confidentialité, Tableau de bord, Découvrir); French spacing (a no-break space
 * before : and inside « », a narrow one before ; ? !) is typed into the strings.
 */
import type { InfoContent } from './types'

const CONTACT = 'me@hutu.si'
const ISSUES = 'https://github.com/hutusi/tela/issues'

export const fr = {
  about: {
    kicker: 'À propos de Tela',
    title: 'Un lecteur pour le Web indépendant.',
    lede: 'Tela rassemble les blogs indépendants et les sites personnels en une seule liste de lecture paisible, traduit les articles dans la langue que vous lisez (chinois simplifié ou traditionnel, anglais ou français), et permet aux auteurs et aux lecteurs de se trouver par ce que chacun recommande, pas par un algorithme d’engagement.',
    short: [
      'Un lecteur gratuit pour les blogs et les sites personnels qui publient un flux.',
      'Votre liste de lecture va du plus récent au plus ancien, rien n’y est classé pour vous faire défiler sans fin, et il n’y a pas de publicité.',
      'Un projet personnel et non commercial, porté par un seul développeur.',
    ],
    sections: {
      why: {
        heading: 'Pourquoi Tela existe',
        blocks: [
          {
            p: 'Les blogs n’ont jamais disparu. Des gens écrivent toujours sur leur propre site, avec leur propre voix et dans leur propre langue, et la plupart de ces sites publient encore un flux.',
          },
          {
            p: 'Ce qui s’est perdu, c’est l’habitude de les lire : une liste choisie soi-même, lue dans l’ordre, où les bonnes choses arrivent par des personnes en qui l’on a confiance.',
          },
          {
            p: 'Tela ramène cette habitude. Vous vous abonnez aux blogs que vous aimez et vous les lisez dans l’ordre de publication. Les articles dans d’autres langues arrivent traduits : les titres tout de suite, le texte complet quand vous l’ouvrez. Les auteurs ont une page qui montre les blogs qu’ils écrivent, les articles qu’ils recommandent et, s’ils le veulent, ce qu’ils lisent. Ce qui circule, c’est ce que les gens choisissent de recommander.',
          },
        ],
      },
      built: {
        heading: 'Comment Tela est conçu',
        blocks: [
          {
            numbered: true,
            entries: [
              {
                name: 'Des personnes, pas de l’engagement',
                text: 'Votre liste suit l’ordre de publication. Ce qui se répand, c’est ce que les gens recommandent, pas ce qui vous fait défiler.',
              },
              {
                name: 'Le Web reste ouvert',
                text: 'Tela lit les flux que publient les blogs, et chaque article renvoie au site de son auteur.',
              },
              {
                name: 'Aucune publicité, nulle part',
                text: 'Rien n’est vendu à côté des textes de qui que ce soit, et vos lectures ne servent pas à vous vendre quoi que ce soit.',
              },
              {
                name: 'À emporter avec vous',
                text: 'Importez vos abonnements en OPML et repartez avec de la même façon, quand vous voulez.',
              },
            ],
          },
        ],
      },
      maker: {
        heading: 'Qui fait Tela',
        blocks: [
          {
            p: 'Tela est conçu par [AI Naive](https://ainaive.com), la signature de [hutusi](https://hutusi.com) : un développeur qui fabrique de petits logiciels avec l’IA.',
          },
          {
            p: 'Tela est un projet personnel et non commercial. Il est gratuit, il n’y a rien à acheter ni d’investisseur à qui rendre des comptes : c’est pourquoi il peut rester calme, sans publicité, et sans hâte de vous faire défiler. Son code est sur [GitHub](https://github.com/hutusi/tela).',
          },
          {
            p: '[ainaive.com](https://ainaive.com) · [hutusi.com](https://hutusi.com) · [GitHub](https://github.com/hutusi)',
          },
        ],
      },
      more: {
        heading: 'Aussi chez AI Naive',
        blocks: [
          {
            entries: [
              {
                name: '[Amytis](https://amytis.vercel.app)',
                text: 'Un framework de jardin numérique : des notes Markdown qui deviennent des articles, des séries et des livres.',
              },
              {
                name: '[Ovid](https://github.com/hutusi/ovid)',
                text: 'Un éditeur Markdown de bureau, local-first, avec Git intégré.',
              },
            ],
          },
        ],
      },
      hello: {
        heading: 'Écrivez-nous',
        blocks: [
          {
            p: `Une question, une idée, un bug, ou un blog que Tela devrait connaître ? Écrivez à ${CONTACT}, ou ouvrez un ticket sur [github.com/hutusi/tela](${ISSUES}). Les tickets sont publics : pour tout ce qui est privé, passez par l’e-mail.`,
          },
        ],
      },
    },
  },

  privacy: {
    title: 'Confidentialité',
    short: [
      'Tela garde ce dont il a besoin pour faire fonctionner votre liste de lecture, et rien pour la publicité.',
      'Nous ne vendons pas vos données, n’affichons pas de publicité et n’utilisons aucun outil de mesure d’audience.',
      'Ce que vous lisez, aimez et surlignez reste privé, sauf si vous choisissez de le montrer. Votre profil, vos recommandations, les blogrolls que vous rendez publiques et les blogs que vous revendiquez sont publics, et les moteurs de recherche peuvent les trouver.',
      'Vous pouvez emporter vos abonnements et vos données quand vous voulez, et supprimer votre compte dans Paramètres → Compte.',
    ],
    sections: {
      collect: {
        heading: 'Ce que nous collectons',
        blocks: [
          { h: 'Votre compte' },
          {
            list: [
              'Votre adresse e-mail.',
              'Votre identifiant et, si vous les ajoutez, un nom affiché, une bio et une photo.',
              'Si vous définissez un mot de passe, seulement son empreinte, jamais le mot de passe lui-même.',
              'Si vous vous connectez avec Google ou GitHub, le compte qui est le vôtre chez eux. Nous ne gardons aucun jeton de leur part, ni le nom ou la photo qu’ils nous envoient.',
              'Si vous vous êtes inscrit avec un code d’invitation, ce code, et donc la personne qui vous l’a donné. Si vous distribuez des codes, les codes que vous avez créés et les personnes qui s’en sont servies.',
              'Si vous commencez à vous inscrire avec un code sans aller au bout, votre adresse e-mail reste associée au code pendant un jour.',
            ],
          },
          { h: 'Votre lecture' },
          {
            list: [
              'Vos abonnements aux blogs, les dossiers où vous les rangez, les flux que vous ajoutez, et ceux qu’une importation n’a pas encore ajoutés.',
              'Les articles que vous avez lus, aimés et recommandés, et les mots joints à vos recommandations.',
              'Vos surlignages et les notes qui les accompagnent.',
              'Les personnes que vous suivez.',
              'Vos blogrolls, avec leur nom et leur description, les blogs qu’elles contiennent, vos notes sur ces blogs, et si elles sont publiques ou non.',
              'Vos paramètres : langues, thème, taille du texte, etc.',
              'Les traductions que vous demandez et ce que chacune a coûté, et le nombre de blogs nouveaux pour Tela que vous ajoutez chaque jour, pour que chacun reste dans les [limites quotidiennes](/terms#limits).',
              'Les articles que vous ouvrez en entier depuis des blogs auxquels vous n’êtes pas abonné, comptés pour la [limite quotidienne](/terms#limits) et gardés deux jours.',
            ],
          },
          { h: 'Les blogs que vous revendiquez' },
          {
            list: [
              'Les blogs que vous revendiquez, la façon dont vous l’avez prouvé, et le résultat de chaque vérification.',
            ],
          },
          { h: 'Vos signalements' },
          {
            list: [
              'Ce que vous avez signalé, pourquoi, ce que vous avez écrit avec, et l’adresse de la page d’où vous l’avez signalé.',
            ],
          },
          { h: 'Les applications que vous connectez' },
          {
            list: [
              'Chaque application que vous connectez : ce que vous lui avez permis, quand vous l’avez connectée, et quand elle a agi pour vous pour la dernière fois ([voir plus bas](#apps)).',
            ],
          },
          { h: 'Données techniques' },
          {
            list: [
              'Chaque session connectée garde l’adresse IP et le navigateur depuis lesquels elle a commencé.',
              'Pour empêcher les abus, les tentatives de connexion, les codes et les inscriptions sont comptés par adresse IP et par adresse e-mail, que cette adresse ait un compte ou non, et certaines actions par compte.',
              'Cloudflare, qui fait tourner Tela, journalise chaque requête : l’adresse demandée, l’heure, votre navigateur et des informations réseau comme votre adresse IP.',
              'Tela n’utilise aucun outil de mesure d’audience.',
            ],
          },
        ],
      },
      public: {
        heading: 'Ce qui est public',
        blocks: [
          {
            p: 'Tout le monde peut voir votre profil à l’adresse telaread.com/@votreidentifiant. Il montre votre identifiant, votre nom affiché, votre bio et votre photo, le mois de votre arrivée, combien de personnes vous suivez et combien vous suivent, combien d’articles vous avez recommandés, les blogs que vous avez revendiqués, les articles que vous recommandez avec vos mots, et vos blogrolls publiques. Il porte aussi le numéro de compte aléatoire que Tela utilise pour les suivis.',
          },
          {
            list: [
              'Vos recommandations parviennent aussi aux personnes qui vous suivent, et apparaissent dans Découvrir à côté des articles recommandés, avec leur mot. Une recommandation accompagnée d’un mot apparaît également sur la page du blog dans Tela et dans le tableau de bord de son auteur, avec votre nom et votre identifiant.',
              'Dès que vous recommandez des articles, ou que vous montrez les blogs que vous lisez, Découvrir peut vous suggérer comme lecteur à suivre, à quiconque le parcourt, en disant pourquoi : un article que vous avez recommandé, ou un blog que vous montrez. Tela rapproche ces suggestions de ce que chaque membre aime et lit sur son propre appareil ; rien de privé ne sert à vous suggérer.',
              'Une blogroll reste privée tant que vous ne la rendez pas publique. Une blogroll publique, avec son nom, sa description, ses blogs et vos notes sur eux, est visible de tous, sur sa propre page, sur votre profil, et dans Découvrir dès que trois de ses blogs sont visibles des autres. Une blogroll privée n’est visible que de vous. La personne qui gère Tela peut retirer une blogroll publique de Découvrir. Elle garde alors sa page et sa place sur votre profil.',
              'Les articles que vous aimez et les blogs que vous lisez ne sont montrés que si vous l’activez dans Paramètres → Confidentialité. Ils apparaissent alors sur votre profil et aux personnes qui vous suivent, y compris sur la page d’un blog, parmi les lecteurs qu’elles suivent.',
              'Votre photo est celle que vous envoyez. Sans elle, c’est votre Gravatar, actif jusqu’à ce que vous le désactiviez dans Paramètres → Profil. Sans l’une ni l’autre, c’est votre initiale.',
              'Une photo que vous supprimez ou désactivez peut rester jusqu’à 30 jours dans les caches des navigateurs et du réseau, à une adresse vers laquelle plus rien ne pointe.',
              'Le nombre de membres qui lisent un blog est public à partir de trois ; en dessous, aucun nombre n’est affiché. Le nombre de personnes qui ont aimé ou recommandé chaque article est public. Un blog lu par trois membres est référencé dans Découvrir.',
              'La personne qui gère Tela examine les blogs que les membres ajoutent, et peut les référencer dans Découvrir. Elle voit chaque blog et le nombre de membres qui le lisent, jamais qui ils sont.',
              'Les auteurs voient des nombres dans leur tableau de bord, pas des noms. Qui a lu ou aimé quoi n’apparaît que là où la personne concernée l’a rendu public.',
              'Jamais public : votre adresse e-mail, ce que vous avez lu, vos surlignages et leurs notes, et vos paramètres.',
              'Les pages publiques peuvent mettre quelques minutes à refléter un changement, et les moteurs de recherche peuvent les trouver ([voir plus bas](#search)).',
            ],
          },
        ],
      },
      search: {
        heading: 'Moteurs de recherche et IA',
        blocks: [
          {
            list: [
              'Les pages publiques de Tela peuvent être indexées par les moteurs de recherche : la page d’accueil, Découvrir, les pages des blogs, les blogrolls publiques et les profils des membres.',
              'Les outils d’IA qui cherchent sur le Web pour répondre à une question peuvent aussi lire ces pages, les citer ou y renvoyer.',
              'Tela demande aux robots d’IA qui collectent des données d’entraînement de ne pas utiliser les pages qui montrent le travail des auteurs. Il le demande dans son robots.txt, sans pouvoir obliger chaque robot à l’écouter.',
              'Un nouveau profil n’est pas proposé aux moteurs de recherche pendant ses premiers jours.',
              'Rien de ce qui demande une connexion n’est public : votre liste de lecture, vos paramètres et tout ce qui est privé restent hors de portée des robots.',
              'Un moteur de recherche garde sa propre copie un certain temps : un changement ou une suppression peut mettre un moment à apparaître dans ses résultats.',
            ],
          },
        ],
      },
      use: {
        heading: 'Ce que nous en faisons',
        blocks: [
          {
            list: [
              'Faire fonctionner Tela : récupérer vos flux, garder votre liste de lecture à jour sur tous vos appareils et afficher votre profil.',
              'Traduire des articles (voir plus bas).',
              'Vous écrire, uniquement au sujet de votre compte : pour vous connecter, confirmer ce que vous avez demandé, ou le protéger.',
              'Empêcher les abus, et examiner les signalements.',
            ],
          },
          {
            p: 'Nous n’affichons jamais de publicité, ne vendons ni ne louons vos données, et ne nous en servons pas pour établir votre profil. Tela n’entraîne pas de modèles d’IA.',
          },
          { h: 'E-mails' },
          {
            list: [
              'Un code de connexion, avec un lien, quand vous en demandez un.',
              'Une invitation, si la personne qui gère Tela vous invite.',
              'Un code pour réinitialiser votre mot de passe, quand vous en demandez un.',
              'Un code de confirmation, quand vous demandez à supprimer votre compte.',
              'Un avis quand vos moyens de connexion changent.',
            ],
          },
          { p: 'Pas de lettre d’information, pas de récapitulatif.' },
        ],
      },
      translation: {
        heading: 'Traduction',
        blocks: [
          {
            list: [
              'Tela traduit les articles dans la langue que vous lisez : chinois simplifié ou traditionnel, anglais ou français. Les titres et les extraits sont traduits à l’arrivée des articles, et le texte complet quand quelqu’un ouvre l’article ou le demande. Le chinois traditionnel est converti à partir de la traduction en chinois simplifié, sans nouvelle traduction.',
              'Ce qui est envoyé, c’est le texte de l’article, avec son titre et le nom du blog pour le contexte. Rien ne vous concerne : ni votre nom, ni votre adresse e-mail, ni votre identifiant, ni ce que vous lisez.',
              'La traduction est assurée par Alibaba Cloud Model Studio (Bailian, dashscope.aliyuncs.com), en Chine continentale.',
              'Une traduction est conservée et partagée : toutes les personnes qui lisent cet article dans cette langue voient la même.',
              'Chaque compte a un nombre quotidien de nouvelles traductions, et Tela un budget quotidien pour tout le site. Au-delà de l’un ou de l’autre, une traduction attend le lendemain ([Conditions](/terms#limits)).',
              'L’auteur d’un blog qui l’a revendiqué peut y désactiver la traduction depuis le tableau de bord.',
            ],
          },
        ],
      },
      others: {
        heading: 'Qui d’autre traite vos données',
        blocks: [
          {
            entries: [
              {
                name: 'Cloudflare',
                text: 'Fait tourner Tela : ses Workers, sa base de données (D1, à Singapour), son stockage de fichiers (R2), ses files d’attente et ses journaux de requêtes.',
              },
              {
                name: 'Resend',
                text: 'Achemine les e-mails de Tela, et traite donc votre adresse et le contenu de chaque message.',
              },
              {
                name: 'Alibaba Cloud Model Studio (Bailian)',
                text: 'Reçoit le texte des blogs à traduire, et jamais rien qui vous concerne.',
              },
              {
                name: 'Gravatar',
                text: 'Tant que votre Gravatar est actif, les serveurs de Tela demandent votre photo à Gravatar à partir d’une empreinte de votre adresse e-mail. Votre navigateur ne contacte jamais Gravatar, et l’empreinte n’est jamais publiée.',
              },
              {
                name: 'Google et GitHub',
                text: 'Uniquement si vous vous connectez avec eux. Ils sauront que vous vous connectez à Tela. Quand vous revendiquez un blog avec GitHub associé à votre compte, les serveurs de Tela demandent aussi à GitHub l’identifiant public et le site web de ce compte, et ne conservent ni l’un ni l’autre.',
              },
              {
                name: 'Les blogs',
                text: 'Tela récupère lui-même les flux et les images des articles : un blog ne vous voit donc pas quand vous le lisez sur Tela. Ouvrir l’original vous emmène directement sur le blog.',
              },
            ],
          },
          {
            p: 'La personne qui gère Tela peut voir sa base de données, pour la maintenir en état et traiter les signalements. Personne d’autre, sauf si la loi l’exige.',
          },
        ],
      },
      apps: {
        heading: 'Les applications que vous connectez',
        blocks: [
          {
            p: 'Des applications faites par d’autres développeurs peuvent se connecter à votre compte Tela si vous le leur permettez. Tela approuve chaque application avant que quiconque puisse la connecter. Vous la connectez sur une page de Tela, qui montre ce que l’application demande, et l’application n’obtient jamais votre mot de passe.',
          },
          { h: 'Ce qu’une application voit' },
          {
            list: [
              'Lecture seule : vos abonnements et vos dossiers, les articles et leur texte en entier, vos coups de cœur, recommandations et surlignages, votre historique de lecture, les personnes que vous suivez, vos préférences de lecture, et les pages publiques de Tela. Elle ne peut rien modifier.',
              'Lecture et écriture : tout cela, et elle peut faire des changements pour vous : marquer des articles comme lus, donner un coup de cœur, recommander, surligner, s’abonner, ajouter des flux, classer des blogs dans des dossiers, suivre des personnes, changer vos préférences de lecture, et demander des traductions, qui comptent dans vos traductions du jour ([Conditions](/terms#limits)).',
              'Votre adresse e-mail, seulement si l’application la demande, que Tela le lui permet et que vous l’acceptez en la connectant.',
              'Aucune application ne peut supprimer votre compte, changer votre façon de vous connecter, télécharger vos données, ni faire ce que seule la personne qui gère Tela peut faire.',
            ],
          },
          { h: 'Ce que Tela garde, et ce que l’application garde' },
          {
            list: [
              'Tela garde une trace de chaque connexion : l’application, ce que vous lui avez permis, quand vous l’avez connectée, et quand elle a servi pour la dernière fois. Tela note cette dernière utilisation à l’heure près ; Paramètres → Apps connectées, où vous retrouvez chaque connexion tant qu’elle dure, en affiche le jour.',
              'Cette trace est gardée jusqu’à la fin de la connexion, quand vous déconnectez l’application ou pour l’une des raisons ci-dessous, puis supprimée 30 jours plus tard.',
              'Ce qu’une application conserve relève de sa propre responsabilité, selon sa politique de confidentialité, que la page où vous la connectez indique.',
              'Déconnecter une application l’arrête aussitôt, sur tous vos appareils. Ce qu’elle a déjà conservé n’est pas supprimé pour autant : demandez-le à l’application.',
              'Toutes les connexions prennent fin quand vous définissez, changez ou réinitialisez votre mot de passe, associez Google ou GitHub, vous déconnectez partout, ou supprimez votre compte. La personne qui gère Tela peut aussi mettre fin aux connexions d’une application, ou l’arrêter pour tout le monde.',
            ],
          },
        ],
      },
      cookies: {
        heading: 'Cookies et votre appareil',
        blocks: [
          { h: 'Cookies' },
          {
            list: [
              'Deux maintiennent votre connexion : un jeton de session, et une copie signée de votre session, adresse e-mail comprise, à laquelle Tela se fie pendant cinq minutes pour charger les pages sans interroger la base de données. Elle est signée, pas chiffrée : elle peut donc être lue sur votre appareil.',
              'Un autre retient la langue de l’interface.',
              'Un dernier, de courte durée, protège une connexion via Google ou GitHub.',
              'Aucun cookie publicitaire, de mesure d’audience ou tiers.',
            ],
          },
          { h: 'Sur votre appareil' },
          {
            list: [
              'Tela garde une copie de votre liste de lecture, et des articles que vous avez ouverts avec leurs traductions, dans le stockage de votre navigateur, pour s’ouvrir instantanément et fonctionner hors ligne. La déconnexion l’efface.',
              'Votre thème et les panneaux affichés y sont aussi gardés, et les fichiers de l’application dans le cache d’un service worker.',
              'Le cache du navigateur lui-même peut garder les articles que vous avez ouverts jusqu’à ce qu’il les efface.',
            ],
          },
        ],
      },
      keep: {
        heading: 'Combien de temps nous les gardons',
        blocks: [
          {
            list: [
              'Quand une session prend fin, son enregistrement, avec l’adresse IP et le navigateur, est supprimé dans la journée. Une session prend fin quand vous vous déconnectez, ou après 60 jours sans utilisation.',
              'Les compteurs qui empêchent les abus, qui contiennent une adresse IP, une adresse e-mail ou un numéro de compte, sont supprimés au bout d’un jour.',
              'Cloudflare garde ses journaux de requêtes 7 jours.',
              'Une recommandation, un surlignage ou une blogroll que vous retirez, ou un blog que vous enlevez d’une blogroll, reste dans la base de données, marqué comme retiré et avec son texte, pour que vos autres appareils se mettent à jour. La suppression de votre compte les efface ([voir plus bas](#delete)).',
              'La trace des articles que vous avez ouverts depuis des blogs auxquels vous n’êtes pas abonné est supprimée au bout de deux jours.',
              'La trace d’une application que vous avez connectée est gardée jusqu’à la fin de la connexion, puis supprimée 30 jours plus tard. Ses jetons ne sont gardés que sous forme d’empreintes, et supprimés dès qu’ils ne peuvent plus jamais servir.',
              'Cloudflare conserve un point de restauration de toute la base de données sur 30 jours, et Tela copie la base chaque nuit en gardant chaque copie 30 jours. Ce que vous modifiez ou retirez peut subsister aussi longtemps dans l’un ou l’autre. La copie nocturne exclut les sessions, les codes de connexion, les compteurs d’abus, les jetons des applications et les articles que vous avez ouverts.',
            ],
          },
        ],
      },
      delete: {
        heading: 'Supprimer votre compte',
        blocks: [
          {
            p: 'Vous pouvez supprimer votre compte dans Paramètres → Compte. Tela vous envoie un code par e-mail pour le confirmer ; une fois le code saisi, le compte est fermé, sans retour possible.',
          },
          {
            list: [
              'Tout de suite, ou en quelques minutes, Tela efface votre adresse e-mail, vos moyens de connexion, votre profil et vos photos, vos abonnements et vos dossiers, votre historique de lecture, vos coups de cœur, recommandations et mots, vos surlignages, vos blogrolls, et vos suivis dans les deux sens.',
              'Tous vos appareils sont déconnectés, et la copie de votre liste de lecture gardée dans un navigateur est effacée la prochaine fois que Tela s’y ouvre.',
              'Votre identifiant est conservé, inutilisé, pour que personne ne puisse le prendre et se faire passer pour vous.',
              'Les blogs que vous avez revendiqués sont libérés. Leurs réglages, comme la traduction, restent tels quels.',
              'Les codes d’invitation que vous avez créés ne fonctionnent plus. Les personnes qui s’en sont servies gardent leur compte.',
              'Les relevés de ce qu’ont coûté les traductions sont conservés, sans lien avec vous. Les blogs que vous avez ajoutés restent sur Tela pour ceux qui les lisent.',
              'Les sauvegardes en gardent une copie jusqu’à 30 jours ([Combien de temps nous les gardons](#keep)). Les caches peuvent montrer votre ancienne photo jusqu’à 30 jours, et votre page de profil quelques minutes.',
            ],
          },
        ],
      },
      choices: {
        heading: 'Vos choix',
        blocks: [
          {
            list: [
              'Exportez vos abonnements, avec leurs dossiers, en OPML dans Paramètres → Abonnements.',
              'Téléchargez vos données en un seul fichier dans Paramètres → Confidentialité → Vos données : votre profil, vos paramètres, abonnements, historique de lecture, coups de cœur, recommandations, surlignages, blogrolls, les personnes que vous suivez, les blogs que vous avez revendiqués et vos codes d’invitation.',
              'Choisissez ce que les autres voient dans Paramètres → Confidentialité. Votre photo et votre Gravatar sont dans Paramètres → Profil ; une photo envoyée que vous retirez est supprimée.',
              'Définissez ou changez un mot de passe, associez ou dissociez Google et GitHub, et déconnectez-vous partout dans Paramètres → Compte.',
              'Retrouvez les applications que vous avez connectées, et déconnectez celle que vous voulez, dans Paramètres → Apps connectées.',
              'Tant que l’inscription à Tela demande une invitation, retrouvez les codes d’invitation que vous avez créés et les personnes qui s’en sont servies dans Paramètres → Invitations, et révoquez-en un que personne n’a utilisé.',
              'Changez votre identifiant, votre nom et votre bio quand vous voulez.',
              'Retirez une recommandation, un surlignage, un coup de cœur, un suivi ou une blogroll à tout moment. Chacun disparaît aussitôt de Tela, et des pages publiques en quelques minutes. Rendre une blogroll privée la retire des pages publiques de la même façon.',
              'Libérez un blog que vous avez revendiqué, depuis le tableau de bord.',
              'Supprimez votre compte dans Paramètres → Compte ([ce qui se passe alors](#delete)).',
              `Pour toute autre question sur vos données, écrivez à ${CONTACT}.`,
            ],
          },
        ],
      },
      age: {
        heading: 'Âge',
        blocks: [
          {
            p: `Tela s’adresse aux personnes de 16 ans et plus. Si vous savez qu’un compte appartient à quelqu’un de plus jeune, écrivez à ${CONTACT} et nous le supprimerons.`,
          },
        ],
      },
      changes: {
        heading: 'Modifications',
        blocks: [
          {
            p: 'La date en haut de page change quand cette page change.',
          },
        ],
      },
      contact: {
        heading: 'Contact',
        blocks: [
          {
            p: `Tela est un projet personnel et non commercial, tenu par une seule personne, hutusi (AI Naive). Pour toute question sur vos données, écrivez à ${CONTACT}. Les bugs et les idées sont les bienvenus sous forme de [tickets sur GitHub](${ISSUES}), mais ceux-ci sont publics.`,
          },
        ],
      },
    },
  },

  terms: {
    title: 'Conditions',
    short: [
      'Toute personne de 16 ans ou plus peut s’inscrire, et utiliser Tela pour lire, suivre et recommander.',
      'Les auteurs gardent tous leurs droits sur leurs textes. Tela les affiche, renvoie vers leur source, et s’en tient à l’écart quand ils le demandent.',
      'Respectez les autres : ni spam, ni usurpation d’identité, rien d’illégal.',
      'Tela est gratuit, tenu par une seule personne, avec des limites quotidiennes, et fourni tel quel.',
    ],
    sections: {
      who: {
        heading: 'Qui nous sommes',
        blocks: [
          {
            p: `Tela (telaread.com) est un projet personnel et non commercial tenu par une seule personne, [hutusi](https://hutusi.com), sous le nom d’[AI Naive](https://ainaive.com). Il est gratuit. « Nous », sur ces pages, désigne cette personne, que vous pouvez joindre à ${CONTACT}.`,
          },
        ],
      },
      account: {
        heading: 'Votre compte',
        blocks: [
          {
            list: [
              'Il faut avoir 16 ans ou plus pour utiliser Tela.',
              'Tout le monde peut s’inscrire avec une adresse e-mail à laquelle il reçoit du courrier. Si besoin, face à une vague de spam par exemple, nous pouvons de nouveau demander une invitation : l’inscription demande alors un code d’invitation, d’un membre ou de nous. Un jour où les nouveaux comptes sont très nombreux, les inscriptions peuvent aussi s’interrompre jusqu’au lendemain.',
              'Connectez-vous avec un code envoyé par e-mail, un mot de passe, ou Google ou GitHub, et gardez vos moyens de connexion en lieu sûr.',
              'Un compte est destiné à une seule personne. Merci de ne pas le partager, le vendre ou le céder.',
              'Vous pouvez supprimer votre compte à tout moment dans Paramètres → Compte. La page [Confidentialité](/privacy#delete) dit ce qui disparaît, et quand.',
            ],
          },
        ],
      },
      handle: {
        heading: 'Votre @identifiant',
        blocks: [
          {
            list: [
              'Vous pouvez changer d’identifiant dans Paramètres → Profil.',
              'Un identifiant compte 3 à 30 lettres minuscules, chiffres ou tirets bas, au premier arrivé, premier servi. Quelques mots sont réservés.',
              'Si vous changez le vôtre, l’adresse de votre ancien profil cesse de fonctionner, et quelqu’un d’autre peut prendre l’ancien identifiant.',
              'L’identifiant d’un compte supprimé reste attaché à ce compte : personne ne peut le reprendre.',
              'Nous pouvons changer un identifiant qui usurpe l’identité de quelqu’un ou reprend un nom que vous n’avez pas le droit d’utiliser.',
            ],
          },
        ],
      },
      writers: {
        heading: 'Les textes des auteurs',
        blocks: [
          {
            list: [
              'Tela lit les flux que publient les blogs, comme tout lecteur de flux. Quand un flux ne contient qu’un résumé, Tela récupère la page publique de l’article pour en obtenir le texte complet.',
              'Le texte reste celui de son auteur, avec tous les droits qui s’y attachent. Les membres connectés le lisent sur Tela. Les pages publiques n’en montrent que les titres et de courts extraits, et chaque article renvoie vers son propre site.',
              'Les traductions sont faites par une machine et signalées comme telles. L’original est ce que l’auteur a écrit.',
              'Si vous tenez un blog, vous pouvez le revendiquer pour voir combien de personnes le lisent, choisir ses thèmes, désactiver la traduction, ou choisir « N’utiliser que ce que fournit mon flux » : Tela ne lit alors que votre flux et ne récupère plus aucune de vos pages.',
              'Vous pouvez aussi tenir Tela à l’écart de vos pages avec robots.txt. Chaque fois qu’il s’apprête à récupérer une page, Tela suit les règles écrites pour « User-agent: Tela », ou à défaut celles écrites pour tous les robots. Votre flux reste lu, comme le font les lecteurs de flux.',
              `Si vous préférez que votre blog ne figure pas du tout sur Tela, écrivez à ${CONTACT}. Nous le retirerons de Découvrir, supprimerons sa page sur Tela et cesserons de le récupérer.`,
              'La page [Pour les auteurs](/writers) en dit plus.',
            ],
          },
        ],
      },
      claims: {
        heading: 'Revendiquer un blog',
        blocks: [
          {
            list: [
              'Ne revendiquez qu’un blog que vous écrivez ou que vous contrôlez. Vous le prouvez avec une balise ou un lien sur sa page d’accueil, ou avec votre compte GitHub, quand le blog et ce compte renvoient l’un vers l’autre.',
              'Un blog revendiqué est référencé dans Découvrir, avec votre nom et votre bio sur sa page.',
              'Vous pouvez libérer un blog revendiqué à tout moment, depuis le tableau de bord. Ses réglages restent tels que vous les avez laissés.',
              'Si une revendication se révèle fausse, nous l’annulerons.',
            ],
          },
        ],
      },
      posts: {
        heading: 'Ce que vous publiez',
        blocks: [
          {
            p: 'Votre bio, vos mots, vos blogrolls et vos surlignages vous appartiennent. En ajoutant une bio, un mot à une recommandation, ou une blogroll publique avec son nom, sa description et ses notes, vous permettez à Tela de les afficher sur Tela, aux endroits qu’indique la [page Confidentialité](/privacy#public). Les surlignages et leurs notes, comme les blogrolls privées, restent privés.',
          },
        ],
      },
      limits: {
        heading: 'Limites',
        blocks: [
          {
            p: 'Tela est partagé, et la traduction est ce qui lui coûte le plus : les comptes ordinaires ont donc des limites. Les chiffres peuvent changer, et Tela vous prévient quand vous en atteignez une.',
          },
          {
            list: [
              'Un nombre quotidien de nouvelles traductions. Un article déjà traduit pour quelqu’un d’autre, ou le chinois traditionnel tiré du simplifié, ne compte pas. Paramètres → Langue indique combien vous en avez utilisé aujourd’hui.',
              'Un nombre quotidien de blogs nouveaux pour Tela. S’abonner à un blog que Tela connaît déjà ne compte pas, et une importation ajoute ses autres nouveaux blogs les jours suivants.',
              'Un plafond d’abonnements par compte.',
              'Un nombre quotidien d’articles que vous pouvez ouvrir en entier depuis des blogs auxquels vous n’êtes pas abonné, sur le Web et dans les applications ensemble. Les blogs auxquels vous êtes abonné ne comptent jamais.',
              'Au-delà de votre limite de traductions, une traduction attend au lieu d’échouer : Tela la fait après minuit UTC (8 h à Pékin), et l’article l’indique.',
              'Tela a aussi un budget quotidien de traduction pour tout le site. Une fois qu’il est épuisé, les traductions attendent le lendemain de la même façon, et les nouveaux titres peuvent rester dans leur langue d’origine jusque-là.',
            ],
          },
        ],
      },
      dont: {
        heading: 'Merci de ne pas',
        blocks: [
          {
            list: [
              'Envoyer du spam, harceler ou malmener qui que ce soit.',
              'Usurper l’identité d’une personne ou d’un blog.',
              'Publier quoi que ce soit d’illégal, ou qui porte atteinte aux droits d’autrui.',
              'Créer des comptes automatiquement ou en masse, aspirer Tela à grande échelle, ou contourner ses limites.',
              'Chercher à casser Tela, ou à entrer dans un compte qui n’est pas le vôtre.',
            ],
          },
          {
            p: 'Nous pouvons masquer ce qui enfreint ces règles, annuler les revendications qui les enfreignent, et suspendre ou supprimer un compte qui les enfreint. Un compte suspendu ne peut plus se connecter, et son profil, ses mots et ses blogrolls sont masqués.',
          },
        ],
      },
      reports: {
        heading: 'Signalements',
        blocks: [
          {
            list: [
              `Si un profil, une blogroll, un blog ou le mot d’une recommandation enfreint ces conditions, les membres peuvent le signaler depuis sa page, et tout le monde peut écrire à ${CONTACT}.`,
              'Nous examinons chaque signalement et décidons de la suite : masquer ce qui a été signalé, suspendre ou supprimer le compte concerné, ou ne rien faire.',
              'Nous seuls savons qui a envoyé un signalement. Ce n’est jamais montré à la personne signalée, ni à personne d’autre.',
            ],
          },
        ],
      },
      service: {
        heading: 'Le service',
        blocks: [
          {
            p: 'Tela est géré par une seule personne, gratuitement, et fourni tel quel. Il peut être indisponible par moments, changer, ou mal traduire. Vos abonnements peuvent toujours être exportés en OPML.',
          },
        ],
      },
      responsibility: {
        heading: 'Responsabilité',
        blocks: [
          {
            p: 'Les blogs sont responsables de ce qu’ils publient, pas Tela. Tela est fourni sans garantie d’aucune sorte et, dans les limites permises par la loi, nous ne sommes pas responsables des pertes liées à son utilisation.',
          },
          {
            p: 'Les applications faites par d’autres que vous connectez à Tela n’appartiennent pas à Tela : leurs auteurs en sont responsables, comme de ce qu’elles conservent.',
          },
        ],
      },
      changes: {
        heading: 'Modifications',
        blocks: [
          {
            p: 'Nous pouvons mettre à jour ces conditions. La date en haut de page change quand elles changent.',
          },
        ],
      },
      contact: {
        heading: 'Contact',
        blocks: [
          {
            p: `Écrivez à ${CONTACT}, ou ouvrez un [ticket sur GitHub](${ISSUES}), qui sera public.`,
          },
        ],
      },
    },
  },
} satisfies InfoContent
