# MirrorEdu

A custom-branded chat interface backed by the Claude API, with Supabase for
auth + chat history and Vercel for hosting.

## Stack

- **Frontend**: plain HTML/CSS/JS, no build step (`index.html`, `chat.html`, `js/`, `styles.css`)
- **Backend**: Vercel serverless functions in `api/`
- **Auth + DB**: Supabase (Auth + Postgres)
- **Model**: Claude, via `@anthropic-ai/sdk`, called only from `api/chat.js`

## How the pieces fit together

- `api/chat.js` is the only place `ANTHROPIC_API_KEY` is read. It verifies the
  caller's Supabase session, enforces the per-user daily message cap
  (`increment_usage` in `sql/schema.sql`), calls Claude, streams the reply
  back as plain text, and saves both sides of the exchange to Supabase.
- `api/health.js` does a zero-cost `models.retrieve()` call to confirm the
  API key and model id are valid, and reports specifically what's missing if
  not.
- `api/config.js` hands the browser the Supabase URL and anon key. This is
  intentionally the *only* thing exposed to the client - the anon key is
  meant to be public (Row Level Security protects the data), unlike the
  Anthropic key or the Supabase service role key, which never leave `api/`.
- The chat page reads conversation/message history directly from Supabase
  using the signed-in user's own session (fast, no extra API call needed),
  but all writes go through `api/chat.js` so the usage cap can't be bypassed.

---

## Setup checklist

Do these in order. Nothing will work until all of them are done.

### 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) -> New Project.
2. Pick a name/region/password (the DB password isn't used anywhere in this
   app - Supabase just needs one).
3. Once it's provisioned, open **Project Settings -> API** and note down:
   - **Project URL** -> this is `SUPABASE_URL`
   - **anon / public key** -> this is `SUPABASE_ANON_KEY`
   - **service_role key** -> this is `SUPABASE_SERVICE_ROLE_KEY` (click "reveal" - keep this one secret, never put it in frontend code)

### 2. Run the database schema

1. In the Supabase dashboard, open **SQL Editor -> New query**.
2. Paste in the entire contents of [`sql/schema.sql`](sql/schema.sql) and run it.
3. Confirm under **Table Editor** that `conversations`, `messages`, and
   `usage_daily` now exist.

### 3. Configure Supabase Auth

1. **Authentication -> URL Configuration**: set **Site URL** to your Vercel
   deployment URL (you'll get this after the first deploy in step 6 - you can
   come back and set this after). Add it to **Redirect URLs** too.
2. **Authentication -> Providers -> Email**: should already be enabled by
   default. Decide whether you want "Confirm email" on or off (on = users
   must click a confirmation link before signing in).

### 4. Push this code to GitHub

Tell me when you're ready and I'll run:

```bash
git init
git add .
git commit -m "Initial MirrorEdu app"
git branch -M main
git remote add origin https://github.com/dylan4remote/MirrorEdu.git
git push -u origin main
```

(I'll confirm with you before actually pushing.)

### 5. Import the project into Vercel

1. [vercel.com](https://vercel.com) -> Add New -> Project -> Import the
   `MirrorEdu` GitHub repo.
2. Framework preset: **Other** (it's plain static files + serverless
   functions, no framework to detect).
3. Before deploying, add the environment variables below.

### 6. Set environment variables in Vercel

Project -> Settings -> Environment Variables. Add these (Production, and
Preview if you want preview deployments to work too):

| Variable | Value | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | your key from console.anthropic.com | Never exposed to the browser |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | Current model id as of writing - see [docs.claude.com](https://docs.claude.com/en/docs/about-claude/models) if you want to change it later |
| `DAILY_MESSAGE_LIMIT` | `50` | Optional, defaults to 50 if unset |
| `SUPABASE_URL` | from step 1 | |
| `SUPABASE_ANON_KEY` | from step 1 | Safe to expose - do not confuse with the service role key |
| `SUPABASE_SERVICE_ROLE_KEY` | from step 1 | Server-side only, never in frontend code |

Deploy. Once it's live, go back to Supabase **Authentication -> URL
Configuration** and set the Site URL / Redirect URLs to your real
`https://your-project.vercel.app` URL if you hadn't yet.

#### Enable file attachments (Vercel Blob)

Chat attachments (PDFs, images) upload straight from the browser to Vercel
Blob storage rather than through the `/api/chat` function - that's what
lets them exceed Vercel's 4.5MB request body limit. This needs a Blob store
connected to the project:

1. Project -> **Storage** tab -> **Create Database** -> **Blob**.
2. Give it a name (e.g. `mirror-edu-attachments`), access **Public**,
   **Create**.
3. Vercel automatically adds `BLOB_READ_WRITE_TOKEN` (and related vars) to
   the project's environment variables - no manual copying needed.
4. Redeploy so the function picks up the new environment variable.

Equivalently, from the CLI: `vercel blob create-store <name> --access public`
(run from the project directory, already linked to the Vercel project).

Without this, attaching a file will fail with a clear error rather than
break silently - `/api/attachment-upload` returns 400/500 if the Blob store
isn't configured.

### 7. Verify the deployment

Visit `https://your-project.vercel.app/api/health`. You should see:

```json
{ "ok": true, "model": "claude-sonnet-5", "displayName": "Claude Sonnet 5" }
```

If not, the response tells you exactly what's missing or wrong (e.g. "
ANTHROPIC_API_KEY is not set" vs "Anthropic rejected this key").

Then visit the site itself, sign up for an account, and send a test message.

---

## Importing your claude.ai conversation history

This is a **one-time, local** script (`scripts/import-claude-export.mjs`) -
not a web page - because it needs the Supabase **service role** key, which
must never run in a browser.

### Step 1: get your export from claude.ai

On claude.ai: **Settings -> Privacy -> Export data**. You'll receive an email
with a download link to a ZIP file. Unzip it - inside you'll find a
**`conversations.json`** file. That's the one you need.

### Step 2: find your Supabase user id

In the Supabase dashboard: **Authentication -> Users**, find your account
(the one you signed up with in MirrorEdu), and copy its **UUID**.

### Step 3: run the import

From the `MirrorEdu` project folder:

```bash
SUPABASE_URL="https://your-project.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key" \
node scripts/import-claude-export.mjs --file /path/to/conversations.json --user-id "your-user-uuid" --dry-run
```

The `--dry-run` flag previews what would be imported (conversation titles and
message counts) without writing anything. Check the output looks right, then
run the same command **without** `--dry-run` to actually import.

Your imported conversations will show up in the MirrorEdu sidebar next to
your new chats.

**If the import reports a lot of skipped messages**: Claude's export format
has changed over time, so the script's parser might not recognize every
field shape. Send me a sample of `conversations.json` (redact anything
sensitive) and I'll adjust the parser.

---

## Notes on cost safety

- `ANTHROPIC_API_KEY` is read only inside `api/*.js`, never sent to or
  embedded in any frontend file.
- `api/health.js` costs nothing to call - `models.retrieve()` is metadata
  only, no tokens billed.
- The daily cap (`DAILY_MESSAGE_LIMIT`, default 50/user/day) is enforced
  atomically server-side via the `increment_usage` Postgres function, so it
  can't be bypassed by calling the API directly or racing concurrent
  requests.
