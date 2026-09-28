# Hisab — Khata Book

A calm **khata (ledger) book** for personal and small-business use — built for daily life in Nepal. Record what you buy, what you owe, and what others owe you, with automatic date/time, per-day totals, and per-person running balances.

**Sign in with Google** and your records follow you across browsers and phones: the app saves your khata as `hisab-data.json` in your Google Drive's hidden app-data folder (`appDataFolder`) and syncs it back whenever you sign in on another device. Prefer not to use Google? Local username/password accounts still work as a fully offline, device-only alternative.

**Static site:** plain HTML + CSS + vanilla JavaScript. No frameworks, no webfonts, no build step. The only external script is Google Identity Services (for Google sign-in).

## Features

- **Sign in with Google** — your Personal + Business records sync through your own Google Drive (hidden app data, readable only by this app). Same Gmail = same khata on every phone and browser. A **"Continue as you@gmail.com"** one-tap option appears on devices you've used before (no automatic sign-in — you always tap it).
- **Local accounts (device-only)** — create a username + password account that stays in that browser only (salted SHA-256 hashing). Good for family members without a Google account, or anyone who wants their khata on one device.
- **Two portals** — Personal khata and Business khata (e.g. a medical shop), switchable from the top bar.
- **Ledger entries** with auto-filled, readable date + time (Asia/Kathmandu, editable):
  - Cash purchase · Bought on due · Gave money · Took money · I paid back · Got money back
- **Dashboard** — today's cash out, today's new dues, total payables ("I owe"), total receivables ("owed to me"), this-month summary, recent entries.
- **Entries view** — per-day grouped list with per-day totals and a grand total, search across items/people/notes, and type filters. Edit or delete any entry.
- **Balances view** — per-person/vendor running balances, split into "I owe" and "Owed to me". Tap a person to see their entries.
- **Sync status pill** — Google accounts show **Synced ✓**, **Syncing…**, **Offline — will sync**, or **Reconnect needed** (tap it to sign in again) in the top bar.
- **JSON backup** — one-tap export downloads the current account's records (filename includes the username or Gmail); import restores them into either account type. Useful for moving records between different Gmail accounts, or as a safety net for local accounts.
- **Sample data loader** — explore the app with example entries.
- **Mobile-first UI** — bottom navigation, big touch targets, inline SVG icons, system fonts, NPR formatting (`Rs 1,25,000` lakh/crore grouping).

## Set up Google sign-in (one-time, ~10 minutes)

Google sign-in needs a free Google Cloud project. Until you paste in a client ID, the Google buttons stay disabled with a note explaining why — local accounts keep working normally.

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a project (name it e.g. **Hisab**).
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - Choose **External**, fill in the app name (Hisab) and your email.
   - Click **Publish app** (under Publishing status) so the app shows **In production**. This is the important step: in Testing mode only hand-listed test users can sign in (and Google re-asks consent about weekly); once published, **any** Gmail works automatically — no test-user list needed. Sign-in will show an "unverified app" warning; that's normal and safe to click through for a family tool (full Google verification is only required for public apps with 100+ users).
   - Add the scope `https://www.googleapis.com/auth/drive.appdata` (or type it under "Add scopes" manually).
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID** → type **Web application**.
5. Under **Authorized JavaScript origins**, add exactly:
   - `https://daveyadav.github.io`
   - `http://localhost:8123` (for local testing)
6. Copy the **Client ID**, paste it into `js/config.js` replacing `PASTE_YOUR_CLIENT_ID_HERE`, and save.
7. Re-upload the files to GitHub (or push), then **hard-refresh** the site (Ctrl/Cmd + Shift + R).

### Test it locally first

```bash
cd hisab-github
python3 -m http.server 8123
# open http://localhost:8123 — sign in with Google, add an entry,
# then sign in on the live site with the same Gmail: the entry appears.
```

The Drive data lives under your Google account's hidden **appDataFolder** — it doesn't show in "My Drive" and only Hisab can read it. Revoking access: Google Account → Security → Third-party access → remove Hisab.

## Push to GitHub

From this folder, in a terminal:

```bash
git init
git add .
git commit -m "Hisab khata book"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/hisab.git
git push -u origin main
```

(Replace `YOUR-USERNAME` and `hisab` with your GitHub username and repository name. Create the empty repository on GitHub first — do not initialize it with a README, to avoid conflicts.)

## Enable GitHub Pages

1. On GitHub, open your repository → **Settings** → **Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Set **Branch** to `main` and folder to `/ (root)`, then **Save**.
4. After a minute or two, your app is live at `https://YOUR-USERNAME.github.io/hisab/`.

The `.nojekyll` file in this project tells GitHub Pages to serve the files exactly as they are.

## How family members use it

1. Each person opens the Pages link on their own phone's browser.
2. **With a Google account (recommended):** tap **Sign in with Google**, pick their Gmail. Their khata then follows them to any browser or phone where they sign in with that same Gmail.
3. **Without Google:** tap **Create a new account** and choose a username + password — that's their private khata on that phone only.
4. For an app-like feel: browser menu → **Add to Home Screen** (Chrome/Android) or **Share → Add to Home Screen** (Safari/iPhone).

A Google account and a local account **never share records**, even on the same phone. Two different Gmail addresses also never share records. To move records between Gmail accounts, export JSON from one and import it into the other.

## Honest notes — please read

- **Local accounts are per-device.** A local account on your phone does *not* appear on anyone else's phone — it never syncs. **Google accounts sync** through Drive's app-data folder instead.
- **Sync is "last write wins."** The whole khata is one JSON file; whichever device saved most recently is what the next sign-in loads. If two phones edit offline at the same time, the later save overwrites the earlier one — no merging. For a family khata this is usually fine; just export a backup before a big import.
- **Offline works, then catches up.** Google accounts keep a local cache, so the app works without internet; changes upload automatically when you're back online (the pill shows **Offline — will sync**).
- **Publish the app — don't stay in Testing mode.** Testing mode only allows hand-listed test users and re-asks consent roughly weekly. Publishing is one click and free: any Gmail can then sign in, no weekly re-consent, and each new Gmail automatically gets its own synced khata. The only costs are an "unverified app" warning screen and a 100-user cap a family will never hit.
- **Backups are per account.** Export downloads the signed-in account's records only. Clearing browser data erases the local copy on that device — for local accounts that's everything, so export regularly (**More → Export backup**) and keep the JSON somewhere safe. For Google accounts, Drive holds the copy.
- **Logins are convenience locks, not bank-grade security.** Anyone with access to the browser's stored data could read it. Fine for family use; not for secrets.
- Dates and times use the **Asia/Kathmandu** timezone.
- For balances to group correctly, keep person/vendor names spelled consistently (e.g. always "Ramesh").

## Project structure

```
hisab/
├── index.html        # app shell, all views/modals, Google buttons
├── css/
│   └── styles.css    # mobile-first styling, no frameworks
├── js/
│   ├── app.js        # auth, ledger, balances, backup, Google flow wiring
│   ├── drive.js      # Google sign-in + Drive appDataFolder sync (token stays in memory)
│   └── config.js     # your Google OAuth client ID goes here
├── tests/
│   └── drive-sync-test.js  # mocked Google/Drive smoke tests (45 checks)
├── .nojekyll         # tells GitHub Pages to serve files as-is
└── README.md
```

Run the tests any time with `node tests/drive-sync-test.js` — no network needed, Google is fully mocked.

## Local preview

No build needed — just serve the folder:

```bash
python3 -m http.server 8123
# then open http://localhost:8123
```

Note: Google sign-in only works on the **authorized origins** (`http://localhost:8123` and your Pages domain) — it will not work from `file://` or other ports. Local accounts work everywhere.
