# Auto-payments (Monzo): set-up guide

Everything is built on the `auto-pay` branch and switched off. This is the order to switch it on. Allow about 30 minutes. You need: the person who holds the club's Monzo account (with their phone), Vercel access, and Supabase access.

> **Two rules.** Always use **`https://www.wirral-community-football.com`** (with `www`), never the `vercel.app` address. And run the SQL (step 3) **before** the switch goes on (step 4), or the app gets stuck on the loading screen.

## 0. The club account is Monzo Business
The connection picks the **business account** first (a personal or joint account is only a fallback). Monzo's developer access is reported to work for business accounts, but it isn't officially documented, so step 6's £5 test is what proves it. If GaffAI still says no account is connected 10 minutes after step 5, tell Claude: the fallback is an Open Banking provider.

## 1. Create the Monzo developer client (account holder)
1. Go to **developers.monzo.com** and sign in with the account holder's email. Monzo emails a link, then asks for approval in the Monzo app.
2. **Clients → New OAuth Client.**
   - Name: `Wirral Community Football`
   - Redirect URLs: **`https://www.wirral-community-football.com/api/monzo/callback`** (exactly this)
   - Confidentiality: **Confidential**
3. Submit, then copy the **Client ID** and **Client secret**.

## 2. Add them to Vercel
Vercel → the project → **Settings → Environment Variables**, Production:
- `MONZO_CLIENT_ID` = the Client ID
- `MONZO_CLIENT_SECRET` = the Client secret

They take effect on the next deploy (step 4 does one).

## 3. Run the SQL in Supabase
Ask Claude to re-check it against the live database first, then run `supabase/auto-pay-rollout.sql` in the Supabase **SQL Editor**. The last query should list members, each with a 5-character code.

## 4. Switch it on (Claude)
Merge `auto-pay`, set `MONZO_MATCHING_LIVE = true` in `lib/clubPolicy.ts`, deploy, run the smoke test.

## 5. Connect Monzo (account holder)
1. Open **`https://www.wirral-community-football.com/api/monzo/authorize`**.
2. Sign in to Monzo (email link) and approve **Wirral Community Football**.
3. The page says **"Connected!"**.
4. Open the **Monzo app** and approve the access request there too. Without this, Monzo won't share the account.
5. Within about **5 minutes** the app finds the account and starts receiving payments. Ask GaffAI "how's the app's health?": it should say **"Monzo connected and receiving payments"**.

## 6. Test with a real £5
From a different bank account, pay the club account **£5** with a player's reference in the payment reference (it's in their app). Within a minute:
- that player's soonest unpaid game shows as paid ("paid via Monzo" in Admin)
- they get **"Payment received ✅"**

## If something goes wrong
| You see | What it means |
|---|---|
| Monzo says the redirect URL doesn't match | The client's redirect URL isn't exactly `https://www.wirral-community-football.com/api/monzo/callback` |
| "Not set up yet" | The Vercel variables are missing, or there hasn't been a deploy since adding them |
| "Connected!" but GaffAI says the webhook isn't registered | The Monzo app approval (step 5.4) hasn't been done yet |
| A payment shows under Payments → "Couldn't be confirmed automatically" | No reference, a wrong reference, or an amount that doesn't fit their games. Confirm it by hand as today |
| GaffAI says the connection expired | Repeat step 5 to reconnect |

## How matching works
Each member has a 5-character reference. When money arrives, the app finds the player from the reference and confirms the set of their unpaid games that adds up to the amount. If more than one set fits (most games cost the same), **part payments cover the soonest games first**. Anything it can't match goes to the admins. "I've paid" still works for cash.
