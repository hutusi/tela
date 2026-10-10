/**
 * About, Privacy and Terms in English. Every statement here is checked against what the code does
 * (ADR 0035); change the copy with the code it describes, and `INFO_UPDATED` with the copy.
 */
import type { InfoContent } from './types'

const CONTACT = '[hutusi.com/about](https://hutusi.com/about) (in Chinese)'
const ISSUES = 'https://github.com/hutusi/tela/issues'

export const en = {
  about: {
    kicker: 'About Tela',
    title: 'A reader for the independent web.',
    lede: 'Tela gathers independent blogs and personal sites into one calm reading list, translates posts into the language you read (Simplified or Traditional Chinese, English or French), and lets writers and readers find each other through what people recommend, not an engagement algorithm.',
    short: [
      'A free reader for blogs and personal sites that publish a feed.',
      'Your reading list runs newest first, nothing is ranked to keep you scrolling, and there are no ads.',
      'A personal, non-commercial project by one developer.',
    ],
    sections: {
      why: {
        heading: 'Why Tela exists',
        blocks: [
          {
            p: 'Blogs never went away. People still write on sites of their own, in their own voice and their own language, and most of those sites still publish a feed.',
          },
          {
            p: 'What faded was the habit of reading them: a list you chose yourself, read in order, with the good things passed on by people you trust.',
          },
          {
            p: 'Tela brings that habit back. You subscribe to the blogs you like and read them in the order they were published. Posts in other languages come translated: titles right away, the full text when you open it. Writers get a page that shows the blogs they write and the posts they recommend, and, if they choose, what they read. What travels is whatever people choose to recommend.',
          },
        ],
      },
      built: {
        heading: 'How Tela is built',
        blocks: [
          {
            numbered: true,
            entries: [
              {
                name: 'People, not engagement',
                text: 'Your list runs in the order things were published. What spreads is what people recommend, not what keeps you scrolling.',
              },
              {
                name: 'The web stays open',
                text: "Tela reads the feeds blogs publish, and each post links back to the writer's own site.",
              },
              {
                name: 'No ads, anywhere',
                text: "Nothing is sold next to anyone's writing, and your reading isn't used to sell to you.",
              },
              {
                name: 'Yours to take with you',
                text: 'Bring your subscriptions in as OPML and take them out the same way, whenever you like.',
              },
            ],
          },
        ],
      },
      maker: {
        heading: 'Who makes Tela',
        blocks: [
          {
            p: "Tela is made by [AI Naive](https://ainaive.com), the maker's mark of [hutusi](https://hutusi.com): one developer, building small software with AI.",
          },
          {
            p: "Tela is a personal, non-commercial project. It's free, there's nothing to buy and no investor to answer to, which is why it can stay quiet, ad-free and in no hurry to keep you scrolling. Its code is on [GitHub](https://github.com/hutusi/tela).",
          },
          {
            p: '[ainaive.com](https://ainaive.com) · [hutusi.com](https://hutusi.com) · [GitHub](https://github.com/hutusi)',
          },
        ],
      },
      more: {
        heading: 'Also from AI Naive',
        blocks: [
          {
            entries: [
              {
                name: '[Amytis](https://amytis.vercel.app)',
                text: 'A digital-garden framework: Markdown notes that grow into articles, series and books.',
              },
              {
                name: '[Ovid](https://github.com/hutusi/ovid)',
                text: 'A local-first desktop Markdown editor, with Git built in.',
              },
            ],
          },
        ],
      },
      hello: {
        heading: 'Say hello',
        blocks: [
          {
            p: `Questions, ideas, a bug, or a blog Tela should know about? Open an issue at [github.com/hutusi/tela](${ISSUES}), or get in touch through ${CONTACT}. Issues are public, so for anything private, use hutusi.com/about.`,
          },
        ],
      },
    },
  },

  privacy: {
    title: 'Privacy',
    short: [
      'Tela keeps what it needs to run your reading list, and nothing for advertising.',
      "We don't sell your data, show ads or use analytics.",
      'What you read, like and highlight stays private unless you choose to show it. Your profile, your recommendations and the blogs you claim are public.',
      'You can export your subscriptions as OPML, and download your profile, settings, subscriptions, likes, recommendations, highlights and follows as one file, whenever you like.',
    ],
    sections: {
      collect: {
        heading: 'What we collect',
        blocks: [
          { h: 'Your account' },
          {
            list: [
              'Your email address.',
              'Your handle, and if you add them, a display name, a bio and a picture.',
              'If you set a password, only a hash of it, never the password itself.',
              'If you sign in with Google or GitHub, which account there is yours. We keep no tokens from them, and not the name or picture they send.',
              'How you joined: the invite code you used, and so who invited you. If you hand out codes, the codes you made and who joined with them.',
              "If you start to join and don't finish, your email address is held against the code for a day.",
            ],
          },
          { h: 'Your reading' },
          {
            list: [
              'The blogs you subscribe to and the feeds you add.',
              "Which posts you've read, liked and recommended, and the notes on your recommendations.",
              'Your highlights and the notes on them.',
              'The people you follow.',
              'Your settings: languages, theme, text size and the like.',
              'The translations you ask for and what each cost, to keep everyone within a daily allowance.',
            ],
          },
          { h: 'Blogs you claim' },
          { list: ['Which blogs you claim, how you proved it, and the result of each check.'] },
          { h: 'Technical records' },
          {
            list: [
              'Each signed-in session keeps the IP address and browser it started from.',
              'To stop abuse, sign-in attempts, codes and joins are counted per IP address and per email address, whether or not that address has an account, and some actions per account.',
              'Cloudflare, which runs Tela, logs each request: the address asked for, the time, your browser, and network details such as your IP address.',
              'Tela uses no analytics.',
            ],
          },
        ],
      },
      public: {
        heading: "What's public",
        blocks: [
          {
            p: "Anyone can see your profile at telaread.com/@yourhandle. It shows your handle, display name, bio and picture, the month you joined, how many people you follow and how many follow you, how many posts you've recommended, the blogs you've claimed, and the posts you recommend with your notes. It also carries the random account number Tela uses for follows.",
          },
          {
            list: [
              "Your recommendations also reach the people who follow you, and appear in Discover beside the posts you recommend, notes included. A recommendation with a note also appears on the blog's page on Tela and in its writer's Dashboard, with your name and handle.",
              'Once you recommend posts, or show the blogs you read, Discover may suggest you as a reader to follow, to anyone browsing it, saying why: a post you recommended, or a blog you show. Tela matches suggestions to what each member likes and reads on their own device; nothing private of yours is used to suggest you.',
              "The posts you like and the blogs you read are shown only if you turn them on in Settings → Privacy. Then they appear on your profile and to the people who follow you, including on a blog's page as a reader they follow.",
              "Your picture is the one you upload. Without one, it's your Gravatar, which stays on until you turn it off in Settings → Profile. Without either, it's your initial.",
              'A picture you remove or turn off can stay in browser and network caches for up to 30 days, at an address nothing links to any more.',
              'How many members read a blog is public once three of them do; below three, no number is shown. How many liked or recommended each post is public. A blog that three members read is listed in Discover.',
              'The person who runs Tela reviews the blogs members add, and may list them in Discover. The review shows each blog and how many members read it, never who.',
              'Writers see counts in their Dashboard, not names. Who read or liked something shows only where that member made it public.',
              "Never public: your email address, what you've read, your highlights and their notes, and your settings.",
              'Public pages can take a few minutes to catch up with a change.',
            ],
          },
        ],
      },
      use: {
        heading: 'How we use it',
        blocks: [
          {
            list: [
              'To run Tela: fetch your feeds, keep your reading list in step across your devices, and show your profile.',
              'To translate posts (below).',
              'To email you, only to sign you in or keep your account safe.',
              'To stop abuse.',
            ],
          },
          {
            p: "We never show ads, sell or rent your data, or use it to profile you. Tela doesn't train AI models.",
          },
          { h: 'Email' },
          {
            list: [
              'A sign-in code, with a link, when you ask for one.',
              'An invitation, if the person who runs Tela invites you.',
              'A code to reset your password, when you ask for one.',
              'A notice when your sign-in methods change.',
            ],
          },
          { p: 'No newsletters, no digests.' },
        ],
      },
      translation: {
        heading: 'Translation',
        blocks: [
          {
            list: [
              'Tela translates posts into the language you read in: Simplified or Traditional Chinese, English or French. Titles and excerpts are translated as posts arrive, and the full text when someone opens the post or asks for it. Traditional Chinese is converted from the Simplified translation, not translated again.',
              "What is sent is the post's own text, with the post's title and the blog's name for context. Nothing about you is sent: not your name, email address, handle or what you read.",
              'Translation is done by Alibaba Cloud Model Studio (Bailian, dashscope.aliyuncs.com), in mainland China.',
              'A translation is kept and shared: everyone who reads that post in that language sees the same one.',
              'A writer who claims their blog can turn translation off for it in the Dashboard.',
            ],
          },
        ],
      },
      others: {
        heading: 'Who else handles your data',
        blocks: [
          {
            entries: [
              {
                name: 'Cloudflare',
                text: 'Runs Tela: its Workers, its database (D1, in Singapore), its file storage (R2), its queues and its request logs.',
              },
              {
                name: 'Resend',
                text: "Delivers Tela's emails, so it handles your address and what each email says.",
              },
              {
                name: 'Alibaba Cloud Model Studio (Bailian)',
                text: 'Receives blog text to translate, and never anything about you.',
              },
              {
                name: 'Gravatar',
                text: "While your Gravatar is on, Tela's servers ask Gravatar for your picture using a hash of your email address. Your browser never contacts Gravatar, and the hash is never published.",
              },
              {
                name: 'Google and GitHub',
                text: "Only if you sign in with them. They will know you signed in to Tela. When you claim a blog with GitHub on your account, Tela's servers also ask GitHub for that account's public username and website, and keep neither.",
              },
              {
                name: 'Blogs',
                text: "Tela fetches feeds and post images itself, so a blog doesn't see you when you read it on Tela. Opening the original takes you to the blog directly.",
              },
            ],
          },
          {
            p: 'The person who runs Tela can see its database, to keep it working. No one else does, unless the law requires it.',
          },
        ],
      },
      cookies: {
        heading: 'Cookies and your device',
        blocks: [
          { h: 'Cookies' },
          {
            list: [
              'Two keep you signed in: a session token, and a signed copy of your session, including your email address, that Tela trusts for five minutes so pages load without a database lookup. It is signed, not encrypted, so it can be read on your device.',
              'One remembers your interface language.',
              'A short-lived one protects a sign-in through Google or GitHub.',
              'No advertising, analytics or third-party cookies.',
            ],
          },
          { h: 'On your device' },
          {
            list: [
              "Tela keeps a copy of your reading list, and the posts you've opened with their translations, in your browser's storage, so it opens at once and works offline. Signing out clears it.",
              "Your theme and which panes show are kept there too, and the app's own files in a service worker's cache.",
              "The browser's own cache may keep posts you opened until it clears them.",
            ],
          },
        ],
      },
      keep: {
        heading: 'How long we keep it',
        blocks: [
          {
            list: [
              'When a session ends, its record, with its IP address and browser, is deleted within a day. A session ends when you sign out, or after 60 days without use.',
              'The counters that stop abuse, which hold an IP address, an email address or an account number, are deleted after a day.',
              'Cloudflare keeps its request logs for 7 days.',
              'A recommendation or highlight you remove stays in the database marked as removed, with its text, so your other devices catch up.',
              'Cloudflare keeps a 30-day restore point of the whole database, and Tela copies the database every night, keeping each copy 30 days. Something you change or remove can stay in either that long. The nightly copy leaves out sessions, sign-in codes and abuse counters.',
            ],
          },
        ],
      },
      choices: {
        heading: 'Your choices',
        blocks: [
          {
            list: [
              'Export your subscriptions as OPML in Settings → Subscriptions.',
              'Download your profile, settings, subscriptions, likes, recommendations, highlights and the people you follow as one file in Settings → Privacy → Your data.',
              'Choose what others see in Settings → Privacy. Your picture and Gravatar are in Settings → Profile; an uploaded picture you remove is deleted.',
              'Set or change a password, link or unlink Google and GitHub, and sign out everywhere in Settings → Account.',
              'See the invite codes you made and who joined with them in Settings → Invites, and revoke one nobody has used.',
              'Change your handle, name and bio whenever you like.',
              'Remove a recommendation, highlight, like or follow at any time. It disappears from Tela at once, and from public pages within a few minutes.',
              'For anything else about your data, [get in touch](#contact).',
            ],
          },
        ],
      },
      changes: {
        heading: 'Changes',
        blocks: [
          {
            p: 'The date at the top changes when this page does.',
          },
        ],
      },
      contact: {
        heading: 'Contact',
        blocks: [
          {
            p: `Tela is a personal, non-commercial project by hutusi (AI Naive). For anything about your data, use the contact details at ${CONTACT}. Bugs and ideas are welcome as [issues on GitHub](${ISSUES}), but those are public.`,
          },
        ],
      },
    },
  },

  terms: {
    title: 'Terms',
    short: [
      'Use Tela to read, follow and recommend.',
      'Writers keep every right to their work. Tela shows it and links back.',
      "Be decent: don't impersonate anyone, and don't break things.",
      'Tela is a free, personal project and comes as it is.',
    ],
    sections: {
      who: {
        heading: 'Who we are',
        blocks: [
          {
            p: 'Tela (telaread.com) is a personal, non-commercial project made by [hutusi](https://hutusi.com) under the name [AI Naive](https://ainaive.com). It\'s free. "We" on these pages means the person who runs it.',
          },
        ],
      },
      account: {
        heading: 'Your account',
        blocks: [
          {
            list: [
              'Tela is invite-only for now: you join with an invite code, or with an invitation from the person who runs Tela.',
              'Sign in with a code sent to your email, a password, or Google or GitHub. Use an address you can receive mail at, and keep your sign-in safe.',
              "An account is for one person. Please don't share, sell or hand it over.",
            ],
          },
        ],
      },
      handle: {
        heading: 'Your @handle',
        blocks: [
          {
            list: [
              'You can change your handle in Settings → Profile.',
              'Handles are 3 to 30 lowercase letters, digits or underscores, first come, first served. A few words are reserved.',
              'If you change yours, your old profile address stops working, and someone else can take the old handle.',
              "We may change a handle that impersonates someone or uses a name that isn't yours to use.",
            ],
          },
        ],
      },
      writers: {
        heading: "Writers' work",
        blocks: [
          {
            list: [
              "Tela reads the feeds blogs publish. When a feed carries only a summary, Tela fetches the post's public page for the full text.",
              "The writing stays the writer's, with every right to it. Signed-in members read it on Tela. Public pages show only titles and short excerpts, and each post links back to its own site.",
              'Translations are made by a machine and labelled as translations. The original is what the writer said.',
              'If you write a blog, you can claim it to see how many people read it, choose its topics, or turn translation off.',
              "If you'd rather your blog weren't on Tela, tell us through the [contact details below](#contact). We'll take it out of Discover, remove its page on Tela and stop fetching it.",
            ],
          },
        ],
      },
      claims: {
        heading: 'Claiming a blog',
        blocks: [
          {
            list: [
              'Claim only a blog you write or control. You prove it with a tag or a link on its home page, or with your GitHub account, when the blog and the account link to each other.',
              'A claimed blog is listed in Discover, with your name and bio on its page.',
              "If a claim turns out to be false, we'll release it.",
            ],
          },
        ],
      },
      posts: {
        heading: 'What you post',
        blocks: [
          {
            p: 'Your bio, notes and highlights are yours. By adding a bio, or a note to a recommendation, you let Tela show it on Tela, where the [Privacy page](/privacy#public) says it appears. Highlights and their notes stay private.',
          },
        ],
      },
      dont: {
        heading: "Please don't",
        blocks: [
          {
            list: [
              'Spam or harass anyone.',
              'Impersonate a person or a blog.',
              'Scrape Tela at scale, or get around its limits.',
              "Use Tela for anything illegal, or post what infringes someone else's rights.",
            ],
          },
          { p: 'We may remove anything that breaks these rules, and release claims that do.' },
        ],
      },
      service: {
        heading: 'The service',
        blocks: [
          {
            p: 'Tela is run by one person, for free, and comes as it is. It may be down at times, change, or translate badly. Your subscriptions can always be exported as OPML.',
          },
        ],
      },
      responsibility: {
        heading: 'Liability',
        blocks: [
          {
            p: "Blogs are responsible for what they publish, not Tela. Tela comes without warranties of any kind, and as far as the law allows, we aren't liable for losses from using it.",
          },
        ],
      },
      changes: {
        heading: 'Changes',
        blocks: [
          {
            p: 'We may update these terms. The date at the top changes when they do.',
          },
        ],
      },
      contact: {
        heading: 'Contact',
        blocks: [
          {
            p: `Use the contact details at ${CONTACT}, or open an [issue on GitHub](${ISSUES}).`,
          },
        ],
      },
    },
  },
} satisfies InfoContent
