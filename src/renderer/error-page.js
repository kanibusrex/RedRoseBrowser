'use strict';

// Populates the error page from the query string TabManager's did-fail-load
// handler passed in (url, code, desc) — no privileged access here, this
// runs in a normal sandboxed page context like any other site content.

const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
const code = Number(params.get('code'));
const desc = params.get('desc') || '';

// Synthetic codes TabManager uses for its own policy blocks (never real
// Chromium net error codes, which are always non-zero and, for the
// certificate range this checks below, well below -100).
const isMalicious = code === -2;
const isBlocked = code === 0;
const isCertError = !isBlocked && !isMalicious && (desc.toUpperCase().includes('CERT') || (code <= -200 && code >= -299));

const heading = document.getElementById('heading');
const detail = document.getElementById('detail');
const urlline = document.getElementById('urlline');
const retry = document.getElementById('retry');

if (isMalicious) {
  document.body.classList.add('danger');
  heading.textContent = 'Deceptive site ahead';
  detail.textContent =
    (desc || 'This site was flagged as malicious.') +
    ' Attackers on this site may trick you into installing software, or steal your passwords, ' +
    'photos, or other personal information.';
} else if (isBlocked) {
  heading.textContent = 'This address is blocked';
  detail.textContent = desc || 'This navigation was blocked for your safety.';
} else if (isCertError) {
  heading.textContent = "Your connection isn't private";
  detail.textContent =
    "This site's certificate could not be verified (" + (desc || 'certificate error') + '). ' +
    'Someone could be trying to intercept your connection, or the site is misconfigured.';
} else {
  heading.textContent = "This site can't be reached";
  detail.textContent = desc ? desc.replace(/^net::/, '') : 'The page could not be loaded.';
}

urlline.textContent = url;
if (url && !isBlocked && !isMalicious) retry.href = url;
else retry.style.display = 'none';
