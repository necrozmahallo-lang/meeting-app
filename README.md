# Meeting Notes App (secure build)

No n8n needed. Three free pieces: Supabase (login + saved records), OpenRouter (the AI), Vercel (hosting).

## One-time setup (about 30 minutes, all in a browser)

1. **Supabase** (supabase.com) -> New project. Then SQL Editor -> New query -> paste all of `supabase.sql` -> Run.
   Then Authentication -> URL Configuration: set Site URL to your Vercel address (step 3 gives it to you; come back and set it).
   Settings -> API: copy the **Project URL** and the **anon public** key.
2. **OpenRouter** (openrouter.ai) -> Keys -> create a NEW key (revoke the old one that was pasted in chat).
   Free models need no credit. Free models may store and learn from what you send, so use fake data only. Use a paid model for real client data.
3. **Vercel** (vercel.com) -> Add New Project -> upload this folder (or push it to GitHub and import it).
   Settings -> Environment Variables, add:
   - `SUPABASE_URL` = the Project URL
   - `SUPABASE_ANON_KEY` = the anon public key
   - `OPENROUTER_API_KEY` = your new key
   - `OPENROUTER_MODEL` = `openai/gpt-oss-120b:free` for free testing (a paid model such as `anthropic/claude-sonnet-4.5` for real client data)
   - `OPENROUTER_VISION_MODEL` (optional) = a free model that can read images, used only when photos are attached. Find one at openrouter.ai/models, filter Free + Image input.
   - `DAILY_LIMIT` = `40`
   Then Redeploy.
4. Open your Vercel address on your phone, enter your email, tap the link in the email.

## What changed from the n8n prototype
- Sign in by email link. Each user only ever sees their own records (database rules enforce this).
- The AI key lives only in Vercel. It never reaches the browser.
- Approved records are saved in Supabase and shown on the Records tab (download CSV, delete all).
- Linking a Google Sheet by link is not in this build. Upload an Excel/CSV file instead (it stays on the device).
  Direct Google/Microsoft sheet writing comes with per-customer sign-in in Phase 2.
- Client name is optional and never leaves the device.

## Privacy rules
Never log notes, photos or transcripts. Secrets only in Vercel environment variables.
The legal text in `public/privacy.html` is a draft. Have a lawyer review it before real customers.
Recording needs client consent and employer permission.
