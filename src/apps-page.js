/**
 * Entry point for apps.html - every app in one place, grouped the same way
 * as the "אפליקציות" section on index.html (src/apps.js), just without the
 * portal/API map underneath it. Its own page/URL because "just the apps,
 * nothing else" is a real thing someone might want to link to or bookmark -
 * the map stays a map.
 */

import { el, esc, showError } from './ui.js';
import { renderAppsByCategory } from './apps.js';
import { initThemePicker } from './theme.js';

initThemePicker(el('themePick'));

/** The blog post ("ארגז הכלים לפעיל החברתי") this page's own feedback form
 *  posts comments onto - WordPress REST API, not the classic HTML form, so
 *  a visitor never has to leave apps.html. Its comments endpoint already
 *  sends `Access-Control-Allow-Origin: https://agmonr.github.io` (checked
 *  directly against the live site before building this), so no server-side
 *  change on the WordPress side was needed for this cross-origin POST to
 *  work. Same spam exposure as the blog's own native comment form already
 *  has - Akismet (visible in that site's own /wp-json/ namespace list)
 *  screens comments regardless of which frontend submitted them, so this
 *  isn't a new attack surface, just a second entry point into the same one. */
const BLOG_POST_ID = 2304;
const BLOG_POST_URL = 'https://hod-hasharon.org/%d7%a4%d7%95%d7%a8%d7%98%d7%9c-%d7%90%d7%a4%d7%9c%d7%99%d7%a7%d7%a6%d7%99%d7%95%d7%aa-%d7%94%d7%9e%d7%99%d7%93%d7%a2/';
const BLOG_COMMENTS_ENDPOINT = 'https://hod-hasharon.org/wp-json/wp/v2/comments';

el('feedbackForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = el('feedbackSubmit');
  const status = el('feedbackStatus');
  const content = el('fbComment').value.trim();
  if (!content) return;

  const fallback = `אפשר גם <a href="${esc(BLOG_POST_URL)}" target="_blank" rel="noopener">להגיב ישירות בבלוג</a>.`;
  btn.disabled = true;
  status.textContent = 'שולח…';
  try {
    const body = { post: BLOG_POST_ID, content };
    const name = el('fbName').value.trim();
    const email = el('fbEmail').value.trim();
    if (name) body.author_name = name;
    if (email) body.author_email = email;

    const res = await fetch(BLOG_COMMENTS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // WordPress returns 201 whether the comment was auto-approved or held
    // for moderation (the common case for a first-time/anonymous
    // commenter) - `status` on the returned object is the only way to tell
    // which, so the success message has to cover both.
    const data = await res.json().catch(() => null);
    if (res.ok) {
      el('fbComment').value = '';
      el('fbName').value = '';
      el('fbEmail').value = '';
      status.textContent = data?.status === 'approved'
        ? 'התגובה פורסמה, תודה!'
        : 'התגובה נשלחה ותפורסם לאחר אישור, תודה!';
    } else {
      status.innerHTML = `אירעה שגיאה בשליחת התגובה${data?.message ? `: ${esc(data.message)}` : ''} - ${fallback}`;
    }
  } catch (err) {
    status.innerHTML = `אירעה שגיאה בשליחת התגובה - ${fallback}`;
  } finally {
    btn.disabled = false;
  }
});

/** Copies one embed snippet (HTML/iframe or JS) as plain text - Clipboard
 * API, no fallback textarea/execCommand: every browser this site otherwise
 * targets (Chrome/Edge/Firefox/Safari, all recent enough for the rest of the
 * JS here) already supports navigator.clipboard.writeText over https/
 * localhost. Both snippets share the same button/code pairing, just two of
 * them (btnId/codeId) rather than one. */
[['embedCopyBtnHtml', 'embedCodeHtml'], ['embedCopyBtnJs', 'embedCodeJs']].forEach(([btnId, codeId]) => {
  const btn = el(btnId);
  if (!btn) return;
  const prevLabel = btn.textContent;
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(el(codeId).textContent);
      btn.textContent = 'הועתק ✓';
    } catch {
      btn.textContent = 'ההעתקה נכשלה - יש להעתיק ידנית';
    }
    setTimeout(() => { btn.textContent = prevLabel; }, 2000);
  });
});

async function load() {
  try {
    const data = globalThis.__API_DATA__ || await (async () => {
      const res = await fetch(new URL('../apis.json', import.meta.url));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })();
    renderAppsByCategory(el('apps'), data.apps);
  } catch (err) {
    showError(el('apps'), err);
  }
}

load();
