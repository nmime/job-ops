/**
 * Email link extraction — pure string processing.
 *
 * Registration flows rely on one-time links delivered by email (verification,
 * password reset). These helpers pull them out of raw email text in the two
 * shapes observed in the wild:
 *   - Markdown-ish:  `Label (https://example.com/...)`
 *   - Bare:          `https://example.com/...`
 */

export interface ExtractedLink {
  url: string;
  label?: string;
}

const LINK_RE =
  /([^\s()]*\((\s*)(https?:\/\/[^\s)]+)(\s*)\))|(https?:\/\/[^\s)>"']+)/g;

export function extractLinks(text: string): ExtractedLink[] {
  const out: ExtractedLink[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    const url = (m[3] ?? m[5]) as string;
    if (!url) continue;
    out.push({ url });
  }
  // De-dupe preserving order.
  const seen = new Set<string>();
  return out.filter((l) => {
    if (seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  });
}

/** First link whose URL contains every needle (case-insensitive). */
export function findLink(text: string, ...needles: string[]): string | null {
  const links = extractLinks(text);
  const lower = needles.map((n) => n.toLowerCase());
  const hit = links.find((l) =>
    lower.every((n) => l.url.toLowerCase().includes(n)),
  );
  return hit ? hit.url : null;
}

/**
 * Freelancer-specific link shapes.
 *  - verify:   /users/login-quick.php?token=…&url=…onverify.php?id=…&verifycode=…
 *  - reset:    /users/reset_user_password.php?token=…&userid=…&uniqid=…
 */
export function findFreelancerVerifyLink(text: string): string | null {
  return findLink(text, "login-quick.php", "onverify");
}

export function findFreelancerResetLink(text: string): string | null {
  return findLink(text, "reset_user_password.php");
}

/** Pull `key=value` params out of a query string without a URL parser. */
export function queryParam(url: string, name: string): string | null {
  const qIdx = url.indexOf("?");
  if (qIdx < 0) return null;
  for (const pair of url.slice(qIdx + 1).split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (decodeURIComponent(pair.slice(0, eq)) === name) {
      return decodeURIComponent(pair.slice(eq + 1));
    }
  }
  return null;
}
