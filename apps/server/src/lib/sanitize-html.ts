import sanitizeHtmlLib from "sanitize-html";

// A deliberately small allow-list of static-content tags — enough to render
// a typical model-listing page (Thingiverse/Printables/MakerWorld/etc.)
// legibly, nothing that can execute code or load active content. Notably
// absent: script, style, iframe, object, embed, form, link, meta, base —
// all discarded (sanitize-html's default `nonTextTags` also drops the text
// content of script/style specifically, not just the tags).
const ALLOWED_TAGS = [
  "a",
  "abbr",
  "b",
  "blockquote",
  "br",
  "caption",
  "code",
  "div",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
];

const ALLOWED_ATTRIBUTES: sanitizeHtmlLib.IOptions["allowedAttributes"] = {
  // target/rel are stamped onto every <a> by the transformTags rule below,
  // not attacker-controlled — still need to be allow-listed or sanitize-html
  // strips its own output.
  a: ["href", "title", "target", "rel"],
  img: ["src", "alt", "title", "width", "height"],
  "*": ["class"],
};

/**
 * Strips scripts, event handlers, and every other executable/active-content
 * surface from a fetched source page's raw HTML before it's stored. This is
 * the primary XSS defense for the source-URL snapshot feature (see
 * source-snapshot/generate.ts, which calls this before ever writing to
 * `models.sourceSnapshotHtml`) — the render path (a script-less sandboxed
 * `<iframe>` in the web app) is defense in depth on top of this, not a
 * substitute for it, in case this allow-list ever has a gap.
 */
export function sanitizeSnapshotHtml(rawHtml: string): string {
  return sanitizeHtmlLib(rawHtml, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    // No javascript:/vbscript:/data:-with-html schemes on links; images may
    // use data: for inline base64 (can't execute script) alongside http(s).
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https", "data"] },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    transformTags: {
      // Outbound links open in a new tab without handing the opened page a
      // `window.opener` back-reference or leaking a Referer.
      a: sanitizeHtmlLib.simpleTransform("a", {
        target: "_blank",
        rel: "noopener noreferrer nofollow",
      }),
    },
  });
}
