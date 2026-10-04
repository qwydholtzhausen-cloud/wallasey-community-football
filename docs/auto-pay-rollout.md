# Auto-payments rollout

Everything is built on the `auto-pay` branch and switched off. To turn it on:

> **Order matters:** run the SQL (step 3) **before** `MONZO_MATCHING_LIVE` goes to `true`. With the switch on and the columns missing, the app can't load games and sits on the loading screen.

1. **Monzo developer client.** At developers.monzo.com, sign in as the club's Monzo account holder and create a confidential OAuth client with redirect URL `https://www.wirral-community-football.com/api/monzo/callback`.
2. **Vercel environment variables** (Production): `MONZO_CLIENT_ID` and `MONZO_CLIENT_SECRET` from that client.
3. **Database.** Run `supabase/auto-pay-rollout.sql` in the Supabase SQL editor. The last query should list members with 5-character codes.
4. **Merge and deploy** the `auto-pay` branch, then flip `MONZO_MATCHING_LIVE` to `true` in `lib/clubPolicy.ts` and deploy again (or flip it on the branch before merging).
5. **Connect Monzo.** Open `https://www.wirral-community-football.com/api/monzo/authorize` as the account holder, approve, then **also approve the access request in the Monzo app** (Monzo asks for in-app approval). Within about 5 minutes the scheduled job finds the account and registers for payment notifications (GaffAI's health check shows whether it's connected).
6. **Test with a real £5.** From another account, pay the club with one player's reference. Within a minute that player's oldest unpaid game should show "paid via Monzo" in Admin and they get "Payment received ✅".

What players get once it's on: their reference and "Copy" on the pay sheet, a choice of "This week" or "All", "Pay £X with ref …", a "Waiting for your £X" bar until it lands, then a receipt listing the games it covered and the existing paid tickets. Part payments cover the soonest games first. Payments without a reference or with an amount that doesn't fit go to admins as today.
