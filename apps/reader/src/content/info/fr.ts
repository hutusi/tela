/**
 * About, Privacy and Terms in French: the English pages (`en.ts`), translated, with the same
 * section ids. Interface names follow the fr catalogue (Paramètres → Confidentialité, Tableau de
 * bord, Découvrir); French spacing (a no-break space before : and inside « », a narrow one before
 * ; ? !) is typed into the strings.
 */
import type { InfoContent } from './types'

const CONTACT = '[hutusi.com/about](https://hutusi.com/about) (en chinois)'
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
            p: `Une question, une idée, un bug, ou un blog que Tela devrait connaître ? Ouvrez un ticket sur [github.com/hutusi/tela](${ISSUES}), ou prenez contact via ${CONTACT}. Les tickets sont publics : pour tout ce qui est privé, passez par hutusi.com/about.`,
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
      'Ce que vous lisez, aimez et surlignez reste privé, sauf si vous choisissez de le montrer. Votre profil, vos recommandations et les blogs que vous revendiquez sont publics.',
      'Vous pouvez exporter vos abonnements en OPML, et télécharger votre profil, vos paramètres, abonnements, coups de cœur, recommandations, surlignages et suivis en un seul fichier, quand vous voulez.',
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
              'Votre inscription : le code d’invitation utilisé, et donc la personne qui vous l’a donné. Si vous distribuez des codes, les codes que vous avez créés et les personnes qui s’en sont servies.',
              'Si vous commencez à vous inscrire sans aller au bout, votre adresse e-mail reste associée au code pendant un jour.',
            ],
          },
          { h: 'Votre lecture' },
          {
            list: [
              'Vos abonnements aux blogs et les flux que vous ajoutez.',
              'Les articles que vous avez lus, aimés et recommandés, et les mots joints à vos recommandations.',
              'Vos surlignages et les notes qui les accompagnent.',
              'Les personnes que vous suivez.',
              'Vos paramètres : langues, thème, taille du texte, etc.',
              'Les traductions que vous demandez et ce que chacune a coûté, pour que tout le monde reste dans un quota quotidien.',
            ],
          },
          { h: 'Les blogs que vous revendiquez' },
          {
            list: [
              'Les blogs que vous revendiquez, la façon dont vous l’avez prouvé, et le résultat de chaque vérification.',
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
            p: 'Tout le monde peut voir votre profil à l’adresse telaread.com/@votreidentifiant. Il montre votre identifiant, votre nom affiché, votre bio et votre photo, le mois de votre arrivée, combien de personnes vous suivez et combien vous suivent, combien d’articles vous avez recommandés, les blogs que vous avez revendiqués, et les articles que vous recommandez avec vos mots. Il porte aussi le numéro de compte aléatoire que Tela utilise pour les suivis.',
          },
          {
            list: [
              'Vos recommandations parviennent aussi aux personnes qui vous suivent, et apparaissent dans Découvrir à côté des articles recommandés, avec leur mot. Une recommandation accompagnée d’un mot apparaît également sur la page du blog dans Tela et dans le tableau de bord de son auteur, avec votre nom et votre identifiant.',
              'Dès que vous recommandez des articles, ou que vous montrez les blogs que vous lisez, Découvrir peut vous suggérer comme lecteur à suivre, à quiconque le parcourt, en disant pourquoi : un article que vous avez recommandé, ou un blog que vous montrez. Tela rapproche ces suggestions de ce que chaque membre aime et lit sur son propre appareil ; rien de privé ne sert à vous suggérer.',
              'Les articles que vous aimez et les blogs que vous lisez ne sont montrés que si vous l’activez dans Paramètres → Confidentialité. Ils apparaissent alors sur votre profil et aux personnes qui vous suivent, y compris sur la page d’un blog, parmi les lecteurs qu’elles suivent.',
              'Votre photo est celle que vous envoyez. Sans elle, c’est votre Gravatar, actif jusqu’à ce que vous le désactiviez dans Paramètres → Profil. Sans l’une ni l’autre, c’est votre initiale.',
              'Une photo que vous supprimez ou désactivez peut rester jusqu’à 30 jours dans les caches des navigateurs et du réseau, à une adresse vers laquelle plus rien ne pointe.',
              'Le nombre de membres qui lisent un blog est public à partir de trois ; en dessous, aucun nombre n’est affiché. Le nombre de personnes qui ont aimé ou recommandé chaque article est public. Un blog lu par trois membres est référencé dans Découvrir.',
              'La personne qui gère Tela examine les blogs que les membres ajoutent, et peut les référencer dans Découvrir. Elle voit chaque blog et le nombre de membres qui le lisent, jamais qui ils sont.',
              'Les auteurs voient des nombres dans leur tableau de bord, pas des noms. Qui a lu ou aimé quoi n’apparaît que là où la personne concernée l’a rendu public.',
              'Jamais public : votre adresse e-mail, ce que vous avez lu, vos surlignages et leurs notes, et vos paramètres.',
              'Les pages publiques peuvent mettre quelques minutes à refléter un changement.',
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
              'Vous écrire, uniquement pour vous connecter ou protéger votre compte.',
              'Empêcher les abus.',
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
                text: 'Uniquement si vous vous connectez avec eux. Ils sauront que vous vous connectez à Tela.',
              },
              {
                name: 'Les blogs',
                text: 'Tela récupère lui-même les flux et les images des articles : un blog ne vous voit donc pas quand vous le lisez sur Tela. Ouvrir l’original vous emmène directement sur le blog.',
              },
            ],
          },
          {
            p: 'La personne qui gère Tela peut voir sa base de données, pour la maintenir en état. Personne d’autre, sauf si la loi l’exige.',
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
              'Une recommandation ou un surlignage que vous retirez reste dans la base de données, marqué comme retiré et avec son texte, pour que vos autres appareils se mettent à jour.',
              'Cloudflare conserve un point de restauration de toute la base de données sur 30 jours, et Tela copie la base chaque nuit en gardant chaque copie 30 jours. Ce que vous modifiez ou retirez peut subsister aussi longtemps dans l’un ou l’autre. La copie nocturne exclut les sessions, les codes de connexion et les compteurs d’abus.',
            ],
          },
        ],
      },
      choices: {
        heading: 'Vos choix',
        blocks: [
          {
            list: [
              'Exportez vos abonnements en OPML dans Paramètres → Abonnements.',
              'Téléchargez votre profil, vos paramètres, abonnements, coups de cœur, recommandations, surlignages et les personnes que vous suivez en un seul fichier dans Paramètres → Confidentialité → Vos données.',
              'Choisissez ce que les autres voient dans Paramètres → Confidentialité. Votre photo et votre Gravatar sont dans Paramètres → Profil ; une photo envoyée que vous retirez est supprimée.',
              'Définissez ou changez un mot de passe, associez ou dissociez Google et GitHub, et déconnectez-vous partout dans Paramètres → Compte.',
              'Retrouvez les codes d’invitation que vous avez créés et les personnes qui s’en sont servies dans Paramètres → Invitations, et révoquez-en un que personne n’a utilisé.',
              'Changez votre identifiant, votre nom et votre bio quand vous voulez.',
              'Retirez une recommandation, un surlignage, un coup de cœur ou un suivi à tout moment. Il disparaît aussitôt de Tela, et des pages publiques en quelques minutes.',
              'Pour toute autre question sur vos données, [contactez-nous](#contact).',
            ],
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
            p: `Tela est un projet personnel et non commercial de hutusi (AI Naive). Pour toute question sur vos données, utilisez les coordonnées indiquées sur ${CONTACT}. Les bugs et les idées sont les bienvenus sous forme de [tickets sur GitHub](${ISSUES}), mais ceux-ci sont publics.`,
          },
        ],
      },
    },
  },

  terms: {
    title: 'Conditions',
    short: [
      'Utilisez Tela pour lire, suivre et recommander.',
      'Les auteurs gardent tous leurs droits sur leurs textes. Tela les affiche et renvoie vers leur source.',
      'Respectez les autres : n’usurpez l’identité de personne, et ne cassez rien.',
      'Tela est un projet personnel et gratuit, fourni tel quel.',
    ],
    sections: {
      who: {
        heading: 'Qui nous sommes',
        blocks: [
          {
            p: 'Tela (telaread.com) est un projet personnel et non commercial réalisé par [hutusi](https://hutusi.com) sous le nom d’[AI Naive](https://ainaive.com). Il est gratuit. « Nous », sur ces pages, désigne la personne qui le gère.',
          },
        ],
      },
      account: {
        heading: 'Votre compte',
        blocks: [
          {
            list: [
              'Tela fonctionne sur invitation pour l’instant : vous vous inscrivez avec un code d’invitation, ou avec une invitation de la personne qui gère Tela.',
              'Connectez-vous avec un code envoyé par e-mail, un mot de passe, ou Google ou GitHub. Utilisez une adresse à laquelle vous recevez du courrier, et gardez vos moyens de connexion en lieu sûr.',
              'Un compte est destiné à une seule personne. Merci de ne pas le partager, le vendre ou le céder.',
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
              'Tela lit les flux que publient les blogs. Quand un flux ne contient qu’un résumé, Tela récupère la page publique de l’article pour en obtenir le texte complet.',
              'Le texte reste celui de son auteur, avec tous les droits qui s’y attachent. Les membres connectés le lisent sur Tela. Les pages publiques n’en montrent que les titres et de courts extraits, et chaque article renvoie vers son propre site.',
              'Les traductions sont faites par une machine et signalées comme telles. L’original est ce que l’auteur a écrit.',
              'Si vous tenez un blog, vous pouvez le revendiquer pour voir combien de personnes le lisent, choisir ses thèmes ou désactiver la traduction.',
              'Si vous préférez que votre blog ne figure pas sur Tela, dites-le-nous via les [coordonnées ci-dessous](#contact). Nous le retirerons de Découvrir, supprimerons sa page sur Tela et cesserons de le récupérer.',
            ],
          },
        ],
      },
      claims: {
        heading: 'Revendiquer un blog',
        blocks: [
          {
            list: [
              'Ne revendiquez qu’un blog que vous écrivez ou que vous contrôlez. Vous le prouvez avec une balise ou un lien sur sa page d’accueil.',
              'Un blog revendiqué est référencé dans Découvrir, avec votre nom et votre bio sur sa page.',
              'Si une revendication se révèle fausse, nous l’annulerons.',
            ],
          },
        ],
      },
      posts: {
        heading: 'Ce que vous publiez',
        blocks: [
          {
            p: 'Votre bio, vos mots et vos surlignages vous appartiennent. En ajoutant une bio, ou un mot à une recommandation, vous permettez à Tela de les afficher sur Tela, aux endroits qu’indique la [page Confidentialité](/privacy#public). Les surlignages et leurs notes restent privés.',
          },
        ],
      },
      dont: {
        heading: 'Merci de ne pas',
        blocks: [
          {
            list: [
              'Envoyer du spam ou harceler qui que ce soit.',
              'Usurper l’identité d’une personne ou d’un blog.',
              'Aspirer Tela à grande échelle, ou contourner ses limites.',
              'Utiliser Tela à des fins illégales, ou publier ce qui porte atteinte aux droits d’autrui.',
            ],
          },
          {
            p: 'Nous pouvons retirer tout ce qui enfreint ces règles, et annuler les revendications qui les enfreignent.',
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
            p: `Utilisez les coordonnées indiquées sur ${CONTACT}, ou ouvrez un [ticket sur GitHub](${ISSUES}).`,
          },
        ],
      },
    },
  },
} satisfies InfoContent
