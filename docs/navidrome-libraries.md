# Limit the station's Navidrome libraries

Navidrome 0.58+ supports libraries with user permissions. See the
[official multi-library guide](https://www.navidrome.org/docs/usage/features/multi-library/).

1. As a Navidrome administrator, create separate libraries under Settings →
   Libraries for music and any audiobooks or seasonal collections. Use separate
   root folders readable by Navidrome, then let the scan finish.
2. Create a **regular, non-admin user** for the station. In Settings → Users,
   edit its Libraries permissions to allow only the collections intended for air.
   Administrators can access every library, so an admin account cannot enforce
   this boundary. A library selector in the browser is not a permission change.
3. Configure that user's credentials in the station's onboarding wizard, or
   `NAVIDROME_USER` / `NAVIDROME_PASS` in the root `.env` if env config is used.
   Restart the controller after changing its environment. Environment overrides
   take precedence over stored wizard credentials.
4. Sign in to Navidrome as that user and verify allowed music is visible and a
   known excluded track is inaccessible. Subsonic search and browsing respect
   the user's permissions, including the `getMusicFolders` list.

Before reconciling a previously broader station library, verify the restricted
account and take a station backup. Reconcile removes tracks absent from the
account's catalogue; it is not just a visibility toggle for the existing index.

The fork's room uses its own configured Navidrome connection. Its credentials
must have the same intended scope; see [room deployment](../station/room/README.md).
