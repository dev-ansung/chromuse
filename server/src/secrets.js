// Detects likely secrets in text so they are not written to memory. Returns the KINDS found, never the matched value.

function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

const RULES = [
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ["bearer_token", /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i],
  ["api_key", /\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,}\b/],
  ["credentials_in_url", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
  ["credential_assignment", /\b(?:api[_ -]?key|secret|token|passw(?:or)?d|passcode|pwd)\b\s*[:=]\s*\S{6,}/i],
  ["one_time_code", /\b(?:otp|one[- ]time (?:code|password)|verification code|2fa code|security code)\b\D{0,20}\d{4,8}\b/i],
];

/** @returns {string[]} the distinct kinds of secret found (empty when none) */
export function scanSecrets(text) {
  const kinds = new Set();
  const s = String(text ?? "");
  for (const m of s.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      kinds.add("card_number");
      break;
    }
  }
  for (const [kind, re] of RULES) if (re.test(s)) kinds.add(kind);
  return [...kinds];
}
