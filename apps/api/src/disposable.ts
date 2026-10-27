// A short list of common throwaway-email domains. Requests from them are accepted like any other
// (the reply never differs) but flagged for the admin reviewing invite requests.
const DISPOSABLE = new Set([
  '10minutemail.com',
  '20minutemail.com',
  'anonaddy.me',
  'burnermail.io',
  'byom.de',
  'dispostable.com',
  'dropmail.me',
  'emailondeck.com',
  'fakeinbox.com',
  'getairmail.com',
  'getnada.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'guerrillamailblock.com',
  'maildrop.cc',
  'mailinator.com',
  'mailnesia.com',
  'mailpoof.com',
  'mintemail.com',
  'mohmal.com',
  'moakt.com',
  'mytemp.email',
  'sharklasers.com',
  'spamgourmet.com',
  'temp-mail.org',
  'tempail.com',
  'tempmail.dev',
  'tempmailo.com',
  'tempr.email',
  'throwawaymail.com',
  'trashmail.com',
  'yopmail.com',
]);

export function isDisposable(email: string): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  if (DISPOSABLE.has(domain)) return true;
  // Catch subdomains such as foo.mailinator.com.
  for (const d of DISPOSABLE) if (domain.endsWith(`.${d}`)) return true;
  return false;
}
