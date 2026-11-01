/**
 * Declarative schemas from the legacy CMS controllers: global settings
 * (SettingsController::schema), page section types (PageController) and the
 * simple content collections (CmsResourceController subclasses).
 */

export type SettingField = {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'image' | 'color' | 'code' | 'number' | 'boolean';
};

export const SETTINGS_SCHEMA: Record<
  string,
  { label: string; icon: string; fields: SettingField[] }
> = {
  general: {
    label: 'General',
    icon: 'fa-globe',
    fields: [
      { key: 'site_name', label: 'Site name', type: 'text' },
      { key: 'tagline', label: 'Tagline', type: 'text' },
      { key: 'logo_light', label: 'Logo (light bg)', type: 'image' },
      { key: 'logo_dark', label: 'Logo (dark bg)', type: 'image' },
      { key: 'favicon', label: 'Favicon', type: 'image' },
      { key: 'default_og', label: 'Default OG image', type: 'image' },
    ],
  },
  brand: {
    label: 'Brand',
    icon: 'fa-palette',
    fields: [
      { key: 'primary_color', label: 'Primary color', type: 'color' },
      { key: 'secondary_color', label: 'Secondary color', type: 'color' },
      { key: 'accent_color', label: 'Accent color', type: 'color' },
      { key: 'font_display', label: 'Display font', type: 'text' },
      { key: 'font_body', label: 'Body font', type: 'text' },
    ],
  },
  contact: {
    label: 'Contact',
    icon: 'fa-address-book',
    fields: [
      { key: 'email', label: 'Email', type: 'text' },
      { key: 'phone', label: 'Phone', type: 'text' },
      { key: 'whatsapp', label: 'WhatsApp', type: 'text' },
      { key: 'address', label: 'Address', type: 'textarea' },
      { key: 'map_embed', label: 'Google Maps embed', type: 'code' },
    ],
  },
  seo: {
    label: 'SEO & Analytics',
    icon: 'fa-magnifying-glass-chart',
    fields: [
      { key: 'title_suffix', label: 'Meta title suffix', type: 'text' },
      {
        key: 'meta_description',
        label: 'Default meta description',
        type: 'textarea',
      },
      { key: 'robots', label: 'Robots directive', type: 'text' },
      { key: 'ga_id', label: 'Google Analytics ID', type: 'text' },
      { key: 'gtm_id', label: 'Google Tag Manager ID', type: 'text' },
      { key: 'fb_pixel', label: 'Facebook Pixel ID', type: 'text' },
      { key: 'sitemap_enabled', label: 'Enable sitemap.xml', type: 'boolean' },
    ],
  },
  footer: {
    label: 'Footer',
    icon: 'fa-shoe-prints',
    fields: [
      { key: 'about', label: 'About blurb', type: 'textarea' },
      { key: 'copyright', label: 'Copyright line', type: 'text' },
    ],
  },
  theme: {
    label: 'Theme',
    icon: 'fa-paintbrush',
    fields: [
      { key: 'mode', label: 'Default mode (light/dark)', type: 'text' },
      { key: 'radius', label: 'Corner radius (px)', type: 'number' },
    ],
  },
};

/** PageController::SECTION_TYPES. */
export const SECTION_TYPES: Record<string, string> = {
  hero: 'Hero',
  about: 'About',
  stats: 'Stats / Counters',
  services: 'Services grid',
  features: 'Features grid',
  promo: 'Promo banner',
  testimonials: 'Testimonials',
  faq: 'FAQ',
  team: 'Team',
  logos: 'Logo cloud',
  cta: 'Call to action',
  contact_form: 'Contact form',
  rich_text: 'Rich text',
};

export type ResourceField = {
  name: string;
  label: string;
  type:
    'text' | 'textarea' | 'richtext' | 'number' | 'boolean' | 'image' | 'color';
  rules: string[];
  col?: boolean;
  help?: string;
};

const SORT: ResourceField = {
  name: 'sort_order',
  label: 'Sort order',
  type: 'number',
  rules: ['nullable', 'integer', 'min:0', 'max:9999'],
  col: true,
};
const VISIBLE: ResourceField = {
  name: 'is_active',
  label: 'Visible',
  type: 'boolean',
  rules: ['nullable', 'boolean'],
  col: true,
};
const FEATURED: ResourceField = {
  name: 'is_featured',
  label: 'Featured',
  type: 'boolean',
  rules: ['nullable', 'boolean'],
  col: true,
};

export type ResourceDef = {
  /** Table name. */
  table:
    | 'services'
    | 'features'
    | 'faqs'
    | 'testimonials'
    | 'team_members'
    | 'blog_categories'
    | 'social_links';
  /** Eloquent class (audit subject_type). */
  model: string;
  /** Legacy route base (audit action prefix). */
  routeBase: string;
  labels: [string, string];
  softDeletes: boolean;
  fields: ResourceField[];
};

/** The CmsResourceController subclasses, by URL slug. */
export const RESOURCES: Record<string, ResourceDef> = {
  services: {
    table: 'services',
    model: 'Service',
    routeBase: 'cms.services',
    labels: ['Service', 'Services'],
    softDeletes: true,
    fields: [
      {
        name: 'title',
        label: 'Title',
        type: 'text',
        rules: ['required', 'string', 'max:160'],
        col: true,
      },
      {
        name: 'slug',
        label: 'Slug',
        type: 'text',
        rules: ['nullable', 'string', 'max:180'],
        help: 'Leave blank to auto-generate from the title.',
      },
      {
        name: 'icon',
        label: 'Icon (Font Awesome class)',
        type: 'text',
        rules: ['nullable', 'string', 'max:60'],
        help: 'e.g. fa-book-open',
      },
      {
        name: 'excerpt',
        label: 'Short description',
        type: 'textarea',
        rules: ['nullable', 'string', 'max:400'],
      },
      {
        name: 'body',
        label: 'Full content',
        type: 'richtext',
        rules: ['nullable', 'string'],
      },
      {
        name: 'image_url',
        label: 'Image',
        type: 'image',
        rules: ['nullable', 'string', 'max:255'],
      },
      SORT,
      FEATURED,
      VISIBLE,
    ],
  },
  features: {
    table: 'features',
    model: 'Feature',
    routeBase: 'cms.features',
    labels: ['Feature', 'Features'],
    softDeletes: false,
    fields: [
      {
        name: 'title',
        label: 'Title',
        type: 'text',
        rules: ['required', 'string', 'max:160'],
        col: true,
      },
      {
        name: 'icon',
        label: 'Icon (Font Awesome class)',
        type: 'text',
        rules: ['nullable', 'string', 'max:60'],
        help: 'e.g. fa-shield-halved',
      },
      {
        name: 'description',
        label: 'Description',
        type: 'textarea',
        rules: ['nullable', 'string', 'max:500'],
      },
      {
        name: 'color',
        label: 'Accent color',
        type: 'color',
        rules: ['nullable', 'string', 'max:20'],
      },
      SORT,
      VISIBLE,
    ],
  },
  faqs: {
    table: 'faqs',
    model: 'Faq',
    routeBase: 'cms.faqs',
    labels: ['FAQ', 'FAQs'],
    softDeletes: false,
    fields: [
      {
        name: 'question',
        label: 'Question',
        type: 'text',
        rules: ['required', 'string', 'max:320'],
        col: true,
      },
      {
        name: 'answer',
        label: 'Answer',
        type: 'textarea',
        rules: ['required', 'string'],
      },
      {
        name: 'category',
        label: 'Category',
        type: 'text',
        rules: ['nullable', 'string', 'max:80'],
        col: true,
        help: 'Group questions into tabs.',
      },
      SORT,
      VISIBLE,
    ],
  },
  testimonials: {
    table: 'testimonials',
    model: 'Testimonial',
    routeBase: 'cms.testimonials',
    labels: ['Testimonial', 'Testimonials'],
    softDeletes: true,
    fields: [
      {
        name: 'name',
        label: 'Name',
        type: 'text',
        rules: ['required', 'string', 'max:120'],
        col: true,
      },
      {
        name: 'role',
        label: 'Role',
        type: 'text',
        rules: ['nullable', 'string', 'max:120'],
        col: true,
      },
      {
        name: 'company',
        label: 'Company / School',
        type: 'text',
        rules: ['nullable', 'string', 'max:120'],
      },
      {
        name: 'avatar_url',
        label: 'Avatar',
        type: 'image',
        rules: ['nullable', 'string', 'max:255'],
      },
      {
        name: 'quote',
        label: 'Quote',
        type: 'textarea',
        rules: ['required', 'string'],
      },
      {
        name: 'rating',
        label: 'Rating (1-5)',
        type: 'number',
        rules: ['nullable', 'integer', 'min:1', 'max:5'],
        col: true,
      },
      { ...SORT, col: undefined },
      FEATURED,
      VISIBLE,
    ],
  },
  team: {
    table: 'team_members',
    model: 'TeamMember',
    routeBase: 'cms.team',
    labels: ['Team member', 'Team'],
    softDeletes: true,
    fields: [
      {
        name: 'name',
        label: 'Name',
        type: 'text',
        rules: ['required', 'string', 'max:120'],
        col: true,
      },
      {
        name: 'role',
        label: 'Role / Title',
        type: 'text',
        rules: ['nullable', 'string', 'max:120'],
        col: true,
      },
      {
        name: 'photo_url',
        label: 'Photo',
        type: 'image',
        rules: ['nullable', 'string', 'max:255'],
      },
      {
        name: 'bio',
        label: 'Bio',
        type: 'textarea',
        rules: ['nullable', 'string'],
      },
      SORT,
      VISIBLE,
    ],
  },
  categories: {
    table: 'blog_categories',
    model: 'BlogCategory',
    routeBase: 'cms.categories',
    labels: ['Category', 'Categories'],
    softDeletes: false,
    fields: [
      {
        name: 'name',
        label: 'Name',
        type: 'text',
        rules: ['required', 'string', 'max:120'],
        col: true,
      },
      {
        name: 'slug',
        label: 'Slug',
        type: 'text',
        rules: ['nullable', 'string', 'max:140'],
        help: 'Leave blank to auto-generate.',
        col: true,
      },
      {
        name: 'description',
        label: 'Description',
        type: 'textarea',
        rules: ['nullable', 'string', 'max:320'],
      },
      { ...SORT, col: undefined },
      VISIBLE,
    ],
  },
  social: {
    table: 'social_links',
    model: 'SocialLink',
    routeBase: 'cms.social',
    labels: ['Social link', 'Social Links'],
    softDeletes: false,
    fields: [
      {
        name: 'platform',
        label: 'Platform',
        type: 'text',
        rules: ['required', 'string', 'max:40'],
        col: true,
        help: 'facebook, x, instagram, youtube, linkedin',
      },
      {
        name: 'url',
        label: 'URL',
        type: 'text',
        rules: ['required', 'url', 'max:255'],
        col: true,
      },
      {
        name: 'icon',
        label: 'Icon (Font Awesome class)',
        type: 'text',
        rules: ['nullable', 'string', 'max:60'],
        help: 'e.g. fab fa-instagram',
      },
      {
        name: 'label',
        label: 'Label',
        type: 'text',
        rules: ['nullable', 'string', 'max:80'],
      },
      SORT,
      VISIBLE,
    ],
  },
};
