/**
 * The site as a machine sees it: one list, read by everything that recites it.
 *
 * `llms.txt` writes it out, `websiteNode()` turns it into a `SiteNavigationElement`
 * table of contents, and the Layout emits `<link rel>` relations from it. Three
 * hand-kept copies of one list is how a page ends up in one of them and
 * invisible in the other two, and an agent-facing index that disagrees with
 * itself is worse than none, because the wrong half still gets followed.
 *
 * Every page route carries a TRAILING SLASH. Astro builds directories and
 * Netlify's pretty URLs 301 `/about` to `/about/`, so the slashless form is a
 * redirect hop on every entry.
 *
 * The studio routes (/type, /stereo, /email, /stereo-colours) are deliberately
 * absent: they are noindexed, they are not for strangers, and the sitemap
 * leaves them out for the same reason.
 */
export interface ContentPage {
  path: string;
  label: string;
  /** One line, descriptive — never marketing. */
  what: string;
  /** The IANA link relation for this page, when it has one. */
  rel?: 'author' | 'help' | 'privacy-policy';
}

export const CONTENT_PAGES: ContentPage[] = [
  {
    path: '/',
    label: 'Home',
    what: 'The glizzy itself: what it is, what it is made of, and how to get one.',
  },
  {
    path: '/about/',
    label: 'About',
    what: 'What Old Vinton Glizzys are, who makes them, and the thing they are not.',
    rel: 'author',
  },
  {
    path: '/contact/',
    label: 'Contact',
    what: 'The message form, what it is for, and where a message goes afterwards.',
    rel: 'help',
  },
  {
    path: '/privacy/',
    label: 'Privacy',
    what: 'What the site collects, which is almost nothing, and what the form does with an email address.',
    rel: 'privacy-policy',
  },
  {
    path: '/colophon/',
    label: 'Colophon',
    what: 'Typefaces, tools and hosting, and who writes the site.',
  },
];
