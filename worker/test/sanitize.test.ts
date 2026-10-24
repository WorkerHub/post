import { describe, expect, it } from "vitest";
import { sanitizeBodyHtml } from "../src/services/sanitize";

describe("sanitizeBodyHtml", () => {
  it("keeps the TipTap whitelist tags", () => {
    const input = [
      "<p>段落</p>",
      "<h2>二级标题</h2>",
      "<h3>三级标题</h3>",
      "<p><strong>加粗</strong> <b>加粗b</b> <em>斜体</em> <i>斜体i</i></p>",
      "<blockquote>引用</blockquote>",
      "<ul><li>无序项</li></ul>",
      "<ol><li>有序项</li></ol>",
      '<a href="https://example.com">链接</a>',
      "<hr>",
      "<p>第一行<br>第二行</p>",
    ].join("");
    const out = sanitizeBodyHtml(input);
    expect(out).toContain("<p>段落</p>");
    expect(out).toContain("<h2>二级标题</h2>");
    expect(out).toContain("<h3>三级标题</h3>");
    expect(out).toContain("<strong>加粗</strong>");
    expect(out).toContain("<b>加粗b</b>");
    expect(out).toContain("<em>斜体</em>");
    expect(out).toContain("<i>斜体i</i>");
    expect(out).toContain("<blockquote>引用</blockquote>");
    expect(out).toContain("<ul><li>无序项</li></ul>");
    expect(out).toContain("<ol><li>有序项</li></ol>");
    expect(out).toContain('<a href="https://example.com">链接</a>');
    expect(out).toContain("<hr");
    expect(out).toContain("<br");
  });

  it("strips <script> and its content entirely", () => {
    const out = sanitizeBodyHtml(
      '<p>before</p><script>alert("xss")</script><p>after</p>',
    );
    expect(out).not.toContain("script");
    expect(out).not.toContain("alert");
    expect(out).toContain("<p>before</p>");
    expect(out).toContain("<p>after</p>");
  });

  it("strips inline event attributes", () => {
    const out = sanitizeBodyHtml(
      '<p onclick="alert(1)">x</p><a href="https://a.com" onmouseover="evil()">link</a>',
    );
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("onmouseover");
    expect(out).not.toContain("alert(1)");
    expect(out).toContain('<a href="https://a.com">link</a>');
  });

  it("strips javascript: and data: links", () => {
    const out = sanitizeBodyHtml(
      '<a href="javascript:alert(1)">js</a><a href="data:text/html;base64,xxx">data</a><a href="https://ok.com">ok</a>',
    );
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("data:");
    expect(out).not.toContain("alert(1)");
    expect(out).toContain('<a href="https://ok.com">ok</a>');
  });

  it("strips disallowed tags but keeps their text content", () => {
    const out = sanitizeBodyHtml(
      '<div style="color:red">div内容</div><table><tr><td>cell</td></tr></table>',
    );
    expect(out).not.toContain("<div");
    expect(out).not.toContain("<table");
    expect(out).not.toContain("color:red");
    expect(out).toContain("div内容");
    expect(out).toContain("cell");
  });

  it("strips style attributes on whitelisted tags", () => {
    const out = sanitizeBodyHtml('<p style="position:fixed">x</p>');
    expect(out).not.toContain("style=");
    expect(out).toContain("<p>x</p>");
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeBodyHtml("")).toBe("");
  });
});
