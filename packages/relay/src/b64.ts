export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Convert an Apple .p8 (PKCS#8 PEM) into DER bytes. */
export function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  if (body === "") throw new Error("PEM is empty");
  return Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
}
