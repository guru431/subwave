// URL for the download endpoint. The room lives under /room/* on the same
// origin, so a relative path resolves on its own — no origin, no CORS needed.
//
// A function, not a shared room client: the three existing fetch('/room/…')
// calls don't translate to it. Extra lines in the patch are conflicts on the
// next upstream update, and the project rule is surgical changes.
export function downloadUrl(subsonicId: string): string {
  return `/room/download?id=${encodeURIComponent(subsonicId)}`;
}
