# Outreach sender

A Google Sheet with an Apps Script that sends the NodFirst feedback-call outreach from `george@trynodfirst.com` and `george@getnodfirst.com`. It runs on Google's servers as george@nodfirst.com, so nobody has to be signed in. Your computer can be off.

## What it does

- Every 15 minutes on weekdays, 9:00–16:00, it sends at most one email per sender address. Sends are spread across the day, with a random pause between them.
- It sends three steps per lead: the first email, follow-up 1 after 3 business days, and follow-up 2 after 4 more. Both follow-ups go in the same email thread.
- It stops a lead's sequence as soon as that person replies, auto-replies, bounces, or asks not to be contacted.
- If more than 3 of the last 30 emails bounce, it switches itself off and emails you.
- Every email ends with your name, your postal address, and a "reply no" opt-out, as the US CAN-SPAM law requires.
- It starts in **test mode**, where every email goes to you instead of the lead.

## One-time setup (about 10 minutes, signed in as george@nodfirst.com)

1. **Let Gmail send as the alias addresses.** In Gmail, go to ⚙ → See all settings → Accounts → "Send mail as" → **Add another email address**. Add `george@trynodfirst.com` with "Treat as an alias" ticked, then do the same for `george@getnodfirst.com`. Both are on your own Workspace account, so Gmail won't ask you to verify them.
2. **Create the Sheet.** Go to https://sheets.new and name it "NodFirst outreach".
3. **Add the script.** Open Extensions → Apps Script, delete the placeholder code, paste in all of `sender.gs`, and save.
4. **Turn on the Gmail service.** In the Apps Script editor's left sidebar, next to **Services**, click **+**, choose **Gmail API**, and click **Add**.
5. **Set the time zone.** In Apps Script, open ⚙ Project Settings → Time zone and pick your time zone. The sending window uses it.
6. **Create the tabs.** Reload the Sheet. A **NodFirst** menu appears; click NodFirst → **Set up sheets**, then approve Google's permission prompt. You'll see an "unverified app" warning because you wrote the app yourself. Click Advanced → Go to project.
7. **Fill in Settings.** `mailing_address` is required. Leave `enabled` as FALSE and `test_mode` as TRUE for now.
8. **Check the senders.** Run NodFirst → **Check sender addresses**. It should report both addresses as OK.

## Going live

1. **Add one lead** to the Leads tab. Fill in `email`, `first_name`, `company`, and optionally a `hook` (one personal line). Leave every other column blank; the script fills them in.
2. **Preview it.** Run NodFirst → **Send me a preview of the first lead**. You get all three emails in your inbox, exactly as the lead would see them.
3. **Test the timer.** Run NodFirst → **Start sending**, then set `enabled` to TRUE. Test mode is still on, so emails come to you. Leave it running for a day.
4. **Go live.** When the test emails look right, set `test_mode` to FALSE. Don't do this until warm-up is done and DKIM shows "Authenticating" for both alias domains.
5. **Raise volume slowly.** Keep `daily_limit_per_sender` at 5 for the first week, then raise it by about 2 a week. The script never sends more than 30 per sender per day.

**To stop:** set `enabled` to FALSE, or run NodFirst → **Stop sending**.

## Status column

| Status | Meaning |
| --- | --- |
| *(blank)* | Queued |
| `active` | In the sequence; the next email goes out at `next_at` |
| `done` | All three sent, no reply |
| `replied` | They answered (or auto-replied). Reply from your inbox. |
| `unsubscribed` | They asked not to be contacted. Never email them again. |
| `bounced` | The address doesn't work |
| `error` | See `notes` |

Replies arrive in george@nodfirst.com's inbox, whichever address sent the email.
