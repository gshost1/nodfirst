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

## Hooks from public job boards

`hooks.mjs` writes the `hook` column. Give it a CSV of companies (an Apollo export works as-is: it reads `Company`, `Website`, `First Name` and `Email`). For each company it looks for a public job board on Greenhouse, Lever or Ashby and writes one factual line from the open US roles:

```sh
node outreach/hooks.mjs apollo-export.csv hooks.csv --leads leads.csv
```

- `hooks.csv` keeps every input column and adds `hook`, `hook_source` (the board it came from), `ats`, `us_roles` and `us_states`. Read each hook before it goes out. The script only knows job titles, so an odd title makes an odd line.
- `leads.csv` has exactly `email, first_name, company, hook` for rows that have an email. Paste it into the Leads tab only after every address is verified.
- The hook picks, in order: an open People or HR role, an IT role ("just opened" only if posted in the last 21 days), several roles across 3 or more states, a count of open roles, or the single open role. Companies with no public board get a blank hook; write those by hand or leave them blank.
