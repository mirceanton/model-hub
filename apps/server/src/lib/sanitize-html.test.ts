import { describe, expect, it } from "vitest";
import { sanitizeSnapshotHtml } from "./sanitize-html.js";

describe("sanitizeSnapshotHtml", () => {
  it("strips <script> tags entirely", () => {
    const out = sanitizeSnapshotHtml('<p>hi</p><script>alert(document.cookie)</script>');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(document.cookie)");
    expect(out).toContain("<p>hi</p>");
  });

  it("strips inline event-handler attributes", () => {
    const out = sanitizeSnapshotHtml('<img src="x.png" onerror="alert(1)">');
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("alert(1)");
  });

  it("strips javascript: URLs from links", () => {
    const out = sanitizeSnapshotHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain("javascript:");
  });

  it("strips <iframe>/<object>/<embed>/<form> entirely", () => {
    const out = sanitizeSnapshotHtml(
      '<iframe src="https://evil.example"></iframe>' +
        '<object data="evil.swf"></object>' +
        '<embed src="evil.swf">' +
        '<form action="https://evil.example"><input name="x"></form>',
    );
    expect(out).not.toMatch(/<iframe|<object|<embed|<form|<input/);
  });

  it("keeps plain formatting markup and safe links/images intact", () => {
    const out = sanitizeSnapshotHtml(
      '<h1>Title</h1><p>Some <strong>bold</strong> text.</p>' +
        '<a href="https://example.com/model">source</a>' +
        '<img src="https://example.com/pic.png" alt="pic">',
    );
    expect(out).toContain("<h1>Title</h1>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain('href="https://example.com/model"');
    expect(out).toContain('src="https://example.com/pic.png"');
  });

  it("adds rel=noopener noreferrer to links (defense against reverse tabnabbing)", () => {
    const out = sanitizeSnapshotHtml('<a href="https://example.com">link</a>');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  it("drops <style> tags and their content", () => {
    const out = sanitizeSnapshotHtml("<style>body{background:url(https://evil.example/track.png)}</style><p>ok</p>");
    expect(out).not.toContain("evil.example");
    expect(out).toContain("<p>ok</p>");
  });
});
