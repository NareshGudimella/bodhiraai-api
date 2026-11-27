// shortcut: sanitize-html is pinned to 2.17.0 because 2.18+ pulls the ESM-only htmlparser2 12,
// which Jest (and a worker on Node < 22.12) cannot load. Its moderate advisory (javascript: in
// action/formaction) does not apply: forms, buttons and those attributes are not allowed below.
// Upgrade when the worker and CI run Node >= 22.12 and Jest loads ESM dependencies.
import sanitizeHtml from 'sanitize-html';

/**
 * security: not in legacy (fixes a legacy stored-XSS bug: CMS HTML was saved and rendered
 * as sent). Allowlist sanitiser for the CMS fields the web renders as HTML: blog post and
 * page section bodies (`sanitizeCms`) and the contact page's map embed (`sanitizeMap`).
 * Applied on save and by `npm run cms:sanitize` for existing rows; idempotent.
 * No `style`, no `data:` URLs (the CMS stores no inline images), no script/object/embed/form,
 * no `on*` attributes: none of them is in the allowlist.
 */
const common: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'hr',
    'div',
    'span',
    'blockquote',
    'pre',
    'code',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'sub',
    'sup',
    'small',
    'mark',
    'ul',
    'ol',
    'li',
    'dl',
    'dt',
    'dd',
    'a',
    'img',
    'figure',
    'figcaption',
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'th',
    'td',
    'caption',
    'colgroup',
    'col',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    th: ['colspan', 'rowspan', 'scope'],
    td: ['colspan', 'rowspan'],
    '*': ['class'],
  },
  allowedSchemes: ['http', 'https'],
  allowedSchemesByTag: { a: ['http', 'https', 'mailto'] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard', // script/style contents are dropped, never shown as text
  transformTags: {
    a: (tag, attribs) => ({
      tagName: tag,
      attribs:
        attribs.target === '_blank'
          ? { ...attribs, rel: 'noopener noreferrer' }
          : attribs,
    }),
  },
};

const MAP_SRC = 'https://www.google.com/maps/embed';

export const sanitizeCms = (html: string) => sanitizeHtml(html, common);

/** The map embed: the same allowlist plus an iframe whose `src` is a Google Maps embed. */
export const sanitizeMap = (html: string) =>
  sanitizeHtml(html, {
    ...common,
    allowedTags: [...(common.allowedTags as string[]), 'iframe'],
    allowedAttributes: {
      ...(common.allowedAttributes as Record<string, string[]>),
      iframe: [
        'src',
        'width',
        'height',
        'title',
        'loading',
        'referrerpolicy',
        'allowfullscreen',
      ],
    },
    allowedIframeHostnames: ['www.google.com'],
    exclusiveFilter: (f) =>
      f.tag === 'iframe' && !(f.attribs.src ?? '').startsWith(MAP_SRC),
  });

/** Settings rendered as HTML by the web, by `group.key`. */
export const HTML_SETTINGS: Record<
  string,
  ((html: string) => string) | undefined
> = {
  'contact.map_embed': sanitizeMap,
};
