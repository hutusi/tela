/**
 * About, Privacy and Terms in English. Every statement here is checked against what the code does
 * (ADR 0035); change the copy with the code it describes, and `INFO_UPDATED` with the copy.
 */
import type { InfoContent } from './types'

/** The one address for anything, private or not. Plain text: the pages link https only. */
const CONTACT = 'me@hutu.si'
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
            p: `Questions, ideas, a bug, or a blog Tela should know about? Write to ${CONTACT}, or open an issue at [github.com/hutusi/tela](${ISSUES}). Issues are public, so for anything private, use email.`,
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
      'What you read, like and highlight stays private unless you choose to show it. Your profile, your recommendations, the blogrolls you make public and the blogs you claim are public, and search engines can find them.',
      'You can take your subscriptions and your data with you whenever you like, and delete your account in Settings → Account.',
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
              'If you joined with an invite code, that code, and so who invited you. If you hand out codes, the codes you made and who joined with them.',
              "If you start to join with a code and don't finish, your email address is held against the code for a day.",
            ],
          },
          { h: 'Your reading' },
          {
            list: [
              'The blogs you subscribe to, the folders you put them in, the feeds you add, and any an import is still adding.',
              "Which posts you've read, liked and recommended, and the notes on your recommendations.",
              'Your highlights and the notes on them.',
              'The people you follow.',
              'Your blogrolls: their names and descriptions, the blogs in them, your notes on those blogs, and whether each is public.',
              'Your settings: languages, theme, text size and the like.',
              'The translations you ask for and what each cost, and how many blogs new to Tela you add each day, to keep everyone within the [daily limits](/terms#limits).',
              "Which posts you open in full from blogs you don't subscribe to, counted for the [daily limit](/terms#limits) and kept for two days.",
            ],
          },
          { h: 'Blogs you claim' },
          { list: ['Which blogs you claim, how you proved it, and the result of each check.'] },
          { h: 'Reports you send' },
          {
            list: [
              'What you reported, why, anything you wrote with it, and the address of the page you reported it from.',
            ],
          },
          { h: 'Apps you connect' },
          {
            list: [
              'Each app you connect: what you allowed it, when you connected it, and when it last acted for you ([below](#apps)).',
            ],
          },
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
            p: "Anyone can see your profile at telaread.com/@yourhandle. It shows your handle, display name, bio and picture, the month you joined, how many people you follow and how many follow you, how many posts you've recommended, the blogs you've claimed, the posts you recommend with your notes, and your public blogrolls. It also carries the random account number Tela uses for follows.",
          },
          {
            list: [
              "Your recommendations also reach the people who follow you, and appear in Discover beside the posts you recommend, notes included. A recommendation with a note also appears on the blog's page on Tela and in its writer's Dashboard, with your name and handle.",
              'Once you recommend posts, or show the blogs you read, Discover may suggest you as a reader to follow, to anyone browsing it, saying why: a post you recommended, or a blog you show. Tela matches suggestions to what each member likes and reads on their own device; nothing private of yours is used to suggest you.',
              'A blogroll is private until you make it public. A public blogroll, with its name, description, blogs and your notes on them, is open to anyone: on its own page, on your profile, and in Discover once it has three blogs others can see. A private blogroll only you see. The person who runs Tela can hide a public blogroll from Discover; it keeps its page and its place on your profile.',
              "The posts you like and the blogs you read are shown only if you turn them on in Settings → Privacy. Then they appear on your profile and to the people who follow you, including on a blog's page as a reader they follow.",
              "Your picture is the one you upload. Without one, it's your Gravatar, which stays on until you turn it off in Settings → Profile. Without either, it's your initial.",
              'A picture you remove or turn off can stay in browser and network caches for up to 30 days, at an address nothing links to any more.',
              'How many members read a blog is public once three of them do; below three, no number is shown. How many liked or recommended each post is public. A blog that three members read is listed in Discover.',
              'The person who runs Tela reviews the blogs members add, and may list them in Discover. The review shows each blog and how many members read it, never who.',
              'Writers see counts in their Dashboard, not names. Who read or liked something shows only where that member made it public.',
              "Never public: your email address, what you've read, your highlights and their notes, and your settings.",
              'Public pages can take a few minutes to catch up with a change, and search engines can find them ([below](#search)).',
            ],
          },
        ],
      },
      search: {
        heading: 'Search engines and AI',
        blocks: [
          {
            list: [
              "Tela's public pages can be indexed by search engines: the front page, Discover, blogs' pages, public blogrolls and members' profiles.",
              'AI tools that search the web to answer a question may read those pages too, and quote them or link to them.',
              "Tela asks AI crawlers that collect training data to stay off the pages that show writers' work. It asks in its robots.txt, and can't make every crawler listen.",
              "A new profile isn't offered to search engines for its first days.",
              "Nothing that needs you to sign in is public: your reading list, your settings and everything private stay out of every crawler's reach.",
              'A search engine keeps its own copy for a while, so a change or a removal can take time to reach its results.',
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
              'To email you, only about your account: to sign you in, to confirm what you asked for, or to keep it safe.',
              'To stop abuse, and to look into reports.',
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
              'A code to confirm, when you ask to delete your account.',
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
              'Each account has a daily number of new translations, and Tela a daily budget for the whole site. Past either, a translation waits for the next day ([Terms](/terms#limits)).',
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
            p: 'The person who runs Tela can see its database, to keep it working and to act on reports. No one else does, unless the law requires it.',
          },
        ],
      },
      apps: {
        heading: 'Apps you connect',
        blocks: [
          {
            p: "Apps made by other developers can connect to your Tela account if you let them. Tela approves each app before anyone can connect it. You connect one on a page of Tela's own, which shows what the app asks for, and the app never gets your password.",
          },
          { h: 'What an app sees' },
          {
            list: [
              "Read only: your subscriptions and folders, posts and their full text, your likes, recommendations and highlights, your reading history, the people you follow, your reading preferences, and Tela's public pages. It can't change anything.",
              'Read and write: all of that, and it can make changes for you: mark posts read, like, recommend, highlight, subscribe, add feeds, file blogs in folders, follow people, change your reading preferences, and ask for translations, which count toward your daily translations ([Terms](/terms#limits)).',
              'Your email address, only when the app asks for it, Tela allows it, and you agree when you connect it.',
              'No app can delete your account, change how you sign in, download your data, or do anything only the person who runs Tela can.',
            ],
          },
          { h: 'What Tela keeps, and what the app keeps' },
          {
            list: [
              'Tela keeps a record of each connection: the app, what you allowed it, when you connected it, and when it was last used. Tela records the hour it was last used; Settings → Connected apps, where you can see each connection while it lasts, shows the day.',
              'The record is kept until the connection ends, when you disconnect the app or for one of the reasons below, and deleted 30 days after that.',
              "What an app stores is that app's responsibility, under its own privacy policy, which the page you connect it on links to.",
              "Disconnecting an app stops it at once, on all your devices. It doesn't delete what the app has already stored: ask the app to delete it.",
              "Every connection ends when you set, change or reset your password, link Google or GitHub, sign out everywhere, or delete your account. The person who runs Tela can also end an app's connections, or stop an app for everyone.",
            ],
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
              'A recommendation, highlight or blogroll you remove, or a blog you take out of a blogroll, stays in the database marked as removed, with its text, so your other devices catch up. Deleting your account removes them ([below](#delete)).',
              "The record of which posts you opened from blogs you don't subscribe to is deleted after two days.",
              'The record of an app you connected is kept until the connection ends, and deleted 30 days after that. Its tokens are kept only as hashes, and deleted once they can never be used again.',
              'Cloudflare keeps a 30-day restore point of the whole database, and Tela copies the database every night, keeping each copy 30 days. Something you change or remove can stay in either that long. The nightly copy leaves out sessions, sign-in codes, abuse counters, app tokens and the posts you opened.',
            ],
          },
        ],
      },
      delete: {
        heading: 'Deleting your account',
        blocks: [
          {
            p: "You can delete your account in Settings → Account. Tela emails you a code to confirm it, and once you enter the code, the account is closed. That can't be undone.",
          },
          {
            list: [
              "At once, or within minutes, Tela removes your email address, your sign-in methods, your profile and pictures, your subscriptions and folders, what you've read, your likes, recommendations and notes, your highlights, your blogrolls, and your follows both ways.",
              'Every device you use is signed out, and the copy of your reading list in a browser is cleared the next time Tela runs there.',
              'Your handle is kept, unused, so nobody can take it to pass as you.',
              'Blogs you claimed are released. Their switches, such as translation, stay as they were.',
              'Invite codes you made stop working. Anyone who joined with one keeps their account.',
              'Records of what translations cost are kept, no longer tied to you. Blogs you added stay on Tela for the people who read them.',
              'Backups keep a copy for up to 30 days ([How long we keep it](#keep)). Caches can show your old picture for up to 30 days, and your profile page for a few minutes.',
            ],
          },
        ],
      },
      choices: {
        heading: 'Your choices',
        blocks: [
          {
            list: [
              'Export your subscriptions, with their folders, as OPML in Settings → Subscriptions.',
              'Download your data as one file in Settings → Privacy → Your data: your profile, settings, subscriptions, reading history, likes, recommendations, highlights, blogrolls, the people you follow, the blogs you claimed and your invite codes.',
              'Choose what others see in Settings → Privacy. Your picture and Gravatar are in Settings → Profile; an uploaded picture you remove is deleted.',
              'Set or change a password, link or unlink Google and GitHub, and sign out everywhere in Settings → Account.',
              'See the apps you have connected, and disconnect any of them, in Settings → Connected apps.',
              'While joining Tela needs an invitation, see the invite codes you made and who joined with them in Settings → Invites, and revoke one nobody has used.',
              'Change your handle, name and bio whenever you like.',
              'Remove a recommendation, highlight, like, follow or blogroll at any time. It disappears from Tela at once, and from public pages within a few minutes. Making a blogroll private takes it off public pages the same way.',
              'Release a blog you claimed, from the Dashboard.',
              'Delete your account in Settings → Account ([what happens](#delete)).',
              `For anything else about your data, write to ${CONTACT}.`,
            ],
          },
        ],
      },
      age: {
        heading: 'Age',
        blocks: [
          {
            p: `Tela is for people aged 16 and over. If you know of an account that belongs to someone younger, write to ${CONTACT} and we'll delete it.`,
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
            p: `Tela is a personal, non-commercial project run by one person, hutusi (AI Naive). For anything about your data, write to ${CONTACT}. Bugs and ideas are welcome as [issues on GitHub](${ISSUES}), but those are public.`,
          },
        ],
      },
    },
  },

  terms: {
    title: 'Terms',
    short: [
      'Anyone aged 16 or over can join, and use Tela to read, follow and recommend.',
      'Writers keep every right to their work. Tela shows it, links back, and leaves it alone when they ask.',
      'Be decent: no spam, no impersonation, nothing illegal.',
      'Tela is free, run by one person, has daily limits, and comes as it is.',
    ],
    sections: {
      who: {
        heading: 'Who we are',
        blocks: [
          {
            p: `Tela (telaread.com) is a personal, non-commercial project run by one person, [hutusi](https://hutusi.com), under the name [AI Naive](https://ainaive.com). It's free. "We" on these pages means that person, whom you can reach at ${CONTACT}.`,
          },
        ],
      },
      account: {
        heading: 'Your account',
        blocks: [
          {
            list: [
              'You need to be 16 or older to use Tela.',
              'Anyone can join with an email address they receive mail at. When there is reason to, such as a wave of spam, we may ask for invitations again: joining then needs an invite code from a member or from us. On a day with a great many new accounts, joining can also pause until the next day.',
              'Sign in with a code sent to your email, a password, or Google or GitHub, and keep your sign-in safe.',
              "An account is for one person. Please don't share, sell or hand it over.",
              'You can delete your account at any time in Settings → Account. [Privacy](/privacy#delete) says what goes, and when.',
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
              'When an account is deleted, its handle stays with it, and nobody can take it.',
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
              "Tela reads the feeds blogs publish, as any feed reader does. When a feed carries only a summary, Tela fetches the post's public page for the full text.",
              "The writing stays the writer's, with every right to it. Signed-in members read it on Tela. Public pages show only titles and short excerpts, and each post links back to its own site.",
              'Translations are made by a machine and labelled as translations. The original is what the writer said.',
              'If you write a blog, you can claim it to see how many people read it, choose its topics, turn translation off, or choose "Only use what my feed provides": Tela then reads only your feed and fetches none of your pages.',
              'You can also keep Tela off your pages with robots.txt. Whenever Tela would fetch a page, it follows the rules for "User-agent: Tela", or else those for every agent. Your feed is still read, as feed readers do.',
              `If you'd rather your blog weren't on Tela at all, write to ${CONTACT}. We'll take it out of Discover, remove its page on Tela and stop fetching it.`,
              'There is more on the [For writers](/writers) page.',
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
              'You can release a blog you claimed at any time, from the Dashboard. Its switches stay as you left them.',
              "If a claim turns out to be false, we'll release it.",
            ],
          },
        ],
      },
      posts: {
        heading: 'What you post',
        blocks: [
          {
            p: 'Your bio, notes, blogrolls and highlights are yours. By adding a bio, a note to a recommendation, or a public blogroll with its name, description and notes, you let Tela show it on Tela, where the [Privacy page](/privacy#public) says it appears. Highlights and their notes, and private blogrolls, stay private.',
          },
        ],
      },
      limits: {
        heading: 'Limits',
        blocks: [
          {
            p: 'Tela is shared, and translation is what it pays for most, so ordinary accounts have limits. The numbers can change, and Tela tells you when you reach one.',
          },
          {
            list: [
              "A daily number of new translations. A post already translated for someone else, or Traditional Chinese made from Simplified, doesn't count. Settings → Language shows how many you've used today.",
              "A daily number of blogs new to Tela. Subscribing to a blog Tela already has doesn't count, and an import adds the rest of its new blogs on the days after.",
              'A cap on how many blogs one account subscribes to.',
              "A daily number of posts you can open in full from blogs you don't subscribe to, on the web and in apps together. Blogs you subscribe to are never counted.",
              'Past your translation limit, a translation waits instead of failing: Tela makes it after midnight UTC (08:00 in Beijing), and the post says so.',
              'Tela also has a daily translation budget for the whole site. When it is spent, translations wait for the next day in the same way, and new titles may show untranslated until then.',
            ],
          },
        ],
      },
      dont: {
        heading: "Please don't",
        blocks: [
          {
            list: [
              'Spam, harass or abuse anyone.',
              'Impersonate a person or a blog.',
              "Post anything illegal, or anything that infringes someone else's rights.",
              'Sign up automatically or in bulk, scrape Tela at scale, or get around its limits.',
              "Try to break Tela, or to get into an account that isn't yours.",
            ],
          },
          {
            p: "We may hide anything that breaks these rules, release claims that do, and suspend or delete an account that does. A suspended account can't sign in, and its profile, notes and blogrolls are hidden.",
          },
        ],
      },
      reports: {
        heading: 'Reports',
        blocks: [
          {
            list: [
              `If a profile, a blogroll, a blog or a recommendation's note on Tela breaks these terms, members can report it from its page, and anyone can write to ${CONTACT}.`,
              'We look at each report and decide what to do: hide what was reported, suspend or delete the account behind it, or nothing.',
              'Only we see who sent a report. It is never shown to the person reported, or to anyone else.',
            ],
          },
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
          {
            p: "Apps made by others that you connect to Tela aren't Tela's: their makers are responsible for them, and for what they keep.",
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
            p: `Write to ${CONTACT}, or open an [issue on GitHub](${ISSUES}), which is public.`,
          },
        ],
      },
    },
  },
} satisfies InfoContent
