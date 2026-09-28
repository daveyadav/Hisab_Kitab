/* =========================================================================
 * Hisab configuration.
 *
 * GOOGLE SIGN-IN (optional):
 *   To let people sign in with Google and sync their records across
 *   devices (via a hidden folder in their own Google Drive), you need a
 *   Google OAuth "Client ID":
 *
 *   1. Go to https://console.cloud.google.com and create a project
 *      called "Hisab".
 *   2. APIs & Services → Library → enable "Google Drive API".
 *   3. APIs & Services → OAuth consent screen → External → fill in the
 *      app name ("Hisab"), your support email and developer contact
 *      email. Under "Test users", add the Gmail addresses of the
 *      family members who will use the app.
 *      (While the app is in "Testing", only those test users can sign
 *      in, and they re-confirm once a week — fine for family use.
 *      Publishing the app removes these limits.)
 *   4. APIs & Services → Credentials → Create Credentials →
 *      OAuth client ID → Application type "Web application".
 *      Under "Authorized JavaScript origins" add:
 *        https://daveyadav.github.io        (the live GitHub Pages site)
 *        http://localhost:8123              (for testing on your computer)
 *   5. Copy the Client ID and paste it below, replacing
 *      PASTE_YOUR_CLIENT_ID_HERE. It looks like
 *      1234567890-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com
 *   6. Re-upload all files to GitHub and hard-refresh the page
 *      (Ctrl/Cmd + Shift + R).
 *
 * Until a real Client ID is pasted here, the "Sign in with Google"
 * button stays disabled and the app works in device-only mode.
 * ========================================================================= */
window.HISAB_CONFIG = {
  GOOGLE_CLIENT_ID: '434056557055-f71840fi74pdhpevl5fvdllilt2jt1fq.apps.googleusercontent.com'
};
