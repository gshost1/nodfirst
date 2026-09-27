/**
 * NodFirst outreach sender: a Google Sheet + Apps Script mail merge.
 *
 * Runs on Google's servers as the account that installs it. Every 15 minutes
 * on weekdays it sends at most one email per sender address, follows up in the
 * same thread after a few days, and stops a sequence as soon as anyone replies.
 *
 * Sheets (created by NodFirst → Set up sheets):
 *   Leads      one row per person; the script fills in the status columns
 *   Templates  subject and bodies for the three steps
 *   Settings   on/off switch, limits, sending window, mailing address
 *
 * Needs the Gmail advanced service (appsscript.json enables it) so follow-ups
 * carry In-Reply-To/References headers and thread in the recipient's inbox.
 */

const HARD_DAILY_CAP = 30;          // per sender, whatever Settings says
const TICK_MINUTES = 15;
const BOUNCE_WINDOW = 30;           // look at the last N first-touch emails
const BOUNCE_LIMIT = 3;             // more bounces than this in the window pauses sending
const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[a-z]{2,}$/i;

const LEAD_HEADERS = ['email', 'first_name', 'company', 'hook', 'status', 'step', 'sent_from', 'thread_id', 'message_ids', 'last_sent_at', 'next_at', 'notes'];
const DEFAULT_SETTINGS = [
  ['enabled', 'FALSE', 'Master switch. Nothing sends until this is TRUE.'],
  ['test_mode', 'TRUE', 'TRUE sends every email to you instead of the lead.'],
  ['senders', 'george@trynodfirst.com, george@getnodfirst.com', 'Comma-separated. Each must be a Gmail "Send mail as" address.'],
  ['from_name', 'George', 'Name shown in the From line.'],
  ['daily_limit_per_sender', '5', 'Start at 5, raise by ~2 a week. Capped at 30.'],
  ['window_start_hour', '9', 'Local hour (script time zone) sending may start.'],
  ['window_end_hour', '16', 'Local hour sending stops.'],
  ['weekdays_only', 'TRUE', 'Skip Saturday and Sunday.'],
  ['followup1_days', '3', 'Days after email 1 before follow-up 1.'],
  ['followup2_days', '4', 'Days after follow-up 1 before follow-up 2.'],
  ['mailing_address', '', 'Required by CAN-SPAM. A real postal address; a PO box is fine.'],
  ['alert_email', '', 'Where pause alerts go. Blank = the account running the script.'],
];
const DEFAULT_TEMPLATES = [
  ['step', 'subject', 'body'],
  ['1', 'Quick question about onboarding at {{company}}', 'Hi {{first_name}},\n\n{{hook}}\n\nWhen a new hire asks for something unusual (a stipend, special access, a payroll change), who at {{company}} decides where it goes?\n\nI\'m building NodFirst, an HR agent that sorts those requests and asks a person before anything happens. I\'m paying $50 for 20 minutes of honest feedback on a demo.\n\nWorth a look?'],
  ['2', '', 'Hi {{first_name}}, bumping this in case it got buried. $50 for 20 minutes, and no pitch after unless you ask for one.'],
  ['3', '', 'Last note from me, {{first_name}}. If onboarding requests aren\'t a headache at {{company}}, that\'s useful to know too.'],
];

/* Menu */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('NodFirst')
    .addItem('Set up sheets', 'setup')
    .addItem('Check sender addresses', 'checkSenders')
    .addItem('Send me a preview of the first lead', 'sendPreview')
    .addSeparator()
    .addItem('Start sending (install timer)', 'start')
    .addItem('Stop sending (remove timer)', 'stop')
    .addItem('Run once now', 'tick')
    .addToUi();
}

function setup() {
  const book = SpreadsheetApp.getActive();
  const leads = book.getSheetByName('Leads') || book.insertSheet('Leads');
  if (leads.getLastRow() === 0) leads.appendRow(LEAD_HEADERS).setFrozenRows(1);
  const templates = book.getSheetByName('Templates') || book.insertSheet('Templates');
  if (templates.getLastRow() === 0) templates.getRange(1, 1, DEFAULT_TEMPLATES.length, 3).setValues(DEFAULT_TEMPLATES);
  const settings = book.getSheetByName('Settings') || book.insertSheet('Settings');
  if (settings.getLastRow() === 0) {
    settings.getRange(1, 1, 1, 3).setValues([['key', 'value', 'what it does']]);
    settings.getRange(2, 1, DEFAULT_SETTINGS.length, 3).setValues(DEFAULT_SETTINGS);
  }
  toast_('Sheets ready. Fill in Settings (mailing_address is required), then add leads.');
}

function start() {
  stop();
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(TICK_MINUTES).create();
  toast_(`Timer installed. It sends only while Settings → enabled is TRUE.`);
}

function stop() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'tick').forEach(t => ScriptApp.deleteTrigger(t));
}

function checkSenders() {
  const cfg = settings_();
  const missing = cfg.senders.filter(s => !sendAsAddresses_().includes(s));
  toast_(missing.length ? `Not set up as "Send mail as": ${missing.join(', ')}` : `All senders OK: ${cfg.senders.join(', ')}`);
}

/** Sends all three steps for the first lead to you, so you can read them as a recipient would. */
function sendPreview() {
  const cfg = settings_();
  const lead = leads_().rows.find(r => r.email);
  if (!lead) return toast_('Add a lead first.');
  const me = Session.getActiveUser().getEmail();
  const templates = templates_();
  [1, 2, 3].forEach(step => {
    const subject = `[PREVIEW step ${step}] ${render_(templates[1].subject, lead)}`;
    sendRaw_({ from: cfg.senders[0], name: cfg.fromName, to: me, subject, body: compose_(templates[step].body, lead, cfg) });
  });
  toast_(`Sent 3 preview emails to ${me}.`);
}

/* The timer */

function tick() {
  const cfg = settings_();
  if (!cfg.enabled) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    syncReplies_(cfg);
    if (!inWindow_(new Date(), cfg)) return;
    if (tooManyBounces_(cfg)) return;
    const allowed = sendAsAddresses_();
    for (const sender of shuffle_(cfg.senders.slice())) {
      if (!allowed.includes(sender)) { note_(`Skipped ${sender}: not a "Send mail as" address.`); continue; }
      const sent = sentToday_(sender);
      const quota = Math.min(cfg.dailyLimit, HARD_DAILY_CAP);
      if (sent >= quota) continue;
      // Spread sends across the window instead of bursting at the start.
      const ticksLeft = Math.max(1, ticksLeftToday_(new Date(), cfg));
      if (Math.random() > Math.min(1, (quota - sent) / ticksLeft * 1.3)) continue;
      const lead = nextFor_(sender, cfg);
      if (!lead) continue;
      sendStep_(lead, sender, cfg);
      countSent_(sender);
      Utilities.sleep(20000 + Math.floor(Math.random() * 70000));
    }
  } finally {
    lock.release();
  }
}

function nextFor_(sender, cfg) {
  const { rows } = leads_();
  const now = Date.now();
  const due = rows.find(r => r.status === 'active' && r.sent_from === sender && r.next_at && new Date(r.next_at).getTime() <= now);
  if (due) return due;
  const contacted = new Set(rows.filter(r => r.status).map(r => r.email.toLowerCase()));
  return rows.find(r => !r.status && r.email && !contacted.has(r.email.toLowerCase())) || null;
}

function sendStep_(lead, sender, cfg) {
  const step = Number(lead.step || 0) + 1;
  const templates = templates_();
  if (!EMAIL_RE.test(lead.email)) return update_(lead, { status: 'error', notes: 'Invalid email address.' });
  if (!templates[step] || !templates[step].body) return update_(lead, { status: 'done' });
  const subject1 = render_(templates[1].subject, lead);
  const subject = step === 1 ? subject1 : `Re: ${subject1}`;
  const ids = String(lead.message_ids || '').split(/\s+/).filter(Boolean);
  try {
    const result = sendRaw_({
      from: sender,
      name: cfg.fromName,
      to: cfg.testMode ? Session.getActiveUser().getEmail() : lead.email,
      subject: cfg.testMode ? `[TEST] ${subject}` : subject,
      body: compose_(templates[step].body, lead, cfg),
      threadId: lead.thread_id || null,
      inReplyTo: ids.at(-1) || null,
      references: ids.join(' ') || null,
    });
    const gap = step === 1 ? cfg.followup1Days : cfg.followup2Days;
    const last = step >= 3 || !templates[step + 1] || !templates[step + 1].body;
    update_(lead, {
      status: last ? 'done' : 'active',
      step,
      sent_from: sender,
      thread_id: result.threadId,
      message_ids: [...ids, result.messageId].filter(Boolean).join(' '),
      last_sent_at: new Date().toISOString(),
      next_at: last ? '' : businessDaysFrom_(new Date(), gap).toISOString(),
      notes: cfg.testMode ? 'Sent in test mode (to you).' : '',
    });
  } catch (error) {
    update_(lead, { status: 'error', notes: String(error.message || error).slice(0, 300) });
  }
}

/* Replies, bounces, opt-outs */

function syncReplies_(cfg) {
  const { rows } = leads_();
  const ours = new Set([...sendAsAddresses_(), Session.getActiveUser().getEmail()].map(a => a.toLowerCase()));
  rows.filter(r => r.thread_id && ['active', 'done'].includes(r.status)).slice(0, 60).forEach(lead => {
    const thread = Gmail.Users.Threads.get('me', lead.thread_id, { format: 'metadata', metadataHeaders: ['From', 'Auto-Submitted'] });
    for (const message of thread.messages || []) {
      const header = name => (message.payload.headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
      const from = (header('From').match(/<([^>]+)>/)?.[1] || header('From')).trim().toLowerCase();
      if (!from || ours.has(from)) continue;
      if (/mailer-daemon|postmaster/.test(from)) return update_(lead, { status: 'bounced', next_at: '', notes: 'Bounced.' });
      if (/^auto-/i.test(header('Auto-Submitted'))) return update_(lead, { status: 'replied', next_at: '', notes: 'Auto-reply (out of office?). Sequence stopped.' });
      const optOut = /\b(unsubscribe|remove me|stop emailing|don'?t (email|contact)|^no\b)/i.test(message.snippet || '');
      return update_(lead, { status: optOut ? 'unsubscribed' : 'replied', next_at: '', notes: optOut ? 'Asked not to be contacted.' : 'Replied. Answer from your inbox.' });
    }
  });
  // Some bounces arrive outside the original thread; match them by address.
  const waiting = new Map(rows.filter(r => ['active', 'done'].includes(r.status)).map(r => [r.email.toLowerCase(), r]));
  GmailApp.search('from:(mailer-daemon OR postmaster) newer_than:3d', 0, 30).forEach(thread => {
    const text = thread.getMessages().map(m => m.getPlainBody()).join('\n').toLowerCase();
    waiting.forEach((lead, email) => { if (text.includes(email)) update_(lead, { status: 'bounced', next_at: '', notes: 'Bounced.' }); });
  });
}

function tooManyBounces_(cfg) {
  const recent = leads_().rows.filter(r => r.last_sent_at && Number(r.step) >= 1).sort((a, b) => String(b.last_sent_at).localeCompare(String(a.last_sent_at))).slice(0, BOUNCE_WINDOW);
  const bounced = recent.filter(r => r.status === 'bounced').length;
  if (bounced <= BOUNCE_LIMIT) return false;
  setSetting_('enabled', 'FALSE');
  GmailApp.sendEmail(cfg.alertEmail, 'NodFirst outreach paused: too many bounces',
    `${bounced} of the last ${recent.length} emails bounced, so sending was switched off to protect your domains.\n\nClean the bounced addresses out of the Leads sheet, then set Settings → enabled back to TRUE.`);
  return true;
}

/* Sending */

function sendRaw_({ from, name, to, subject, body, threadId, inReplyTo, references }) {
  [from, to].forEach(address => { if (!EMAIL_RE.test(address)) throw new Error(`Bad address: ${address}`); });
  const clean = value => String(value || '').replace(/[\r\n]+/g, ' ').trim();
  const headers = [
    `From: ${encodeHeader_(clean(name))} <${from}>`,
    `To: ${to}`,
    `Subject: ${encodeHeader_(clean(subject))}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${clean(inReplyTo)}`, `References: ${clean(references || inReplyTo)}`);
  const encodedBody = Utilities.base64Encode(body, Utilities.Charset.UTF_8).match(/.{1,76}/g).join('\r\n');
  const raw = Utilities.base64EncodeWebSafe(`${headers.join('\r\n')}\r\n\r\n${encodedBody}`, Utilities.Charset.UTF_8);
  const sent = Gmail.Users.Messages.send(threadId ? { raw, threadId } : { raw }, 'me');
  const meta = Gmail.Users.Messages.get('me', sent.id, { format: 'metadata', metadataHeaders: ['Message-ID'] });
  const messageId = (meta.payload.headers || []).find(h => h.name.toLowerCase() === 'message-id')?.value || '';
  return { threadId: sent.threadId, messageId };
}

function encodeHeader_(value) {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Utilities.base64Encode(value, Utilities.Charset.UTF_8)}?=`;
}

function compose_(template, lead, cfg) {
  const footer = `\n\n--\n${cfg.fromName}\nNodFirst · nodfirst.com\n${cfg.mailingAddress}\nNot relevant? Reply "no" and I won't email again.`;
  return render_(template, lead).replace(/\n{3,}/g, '\n\n').trim() + footer;
}

function render_(template, lead) {
  const values = { first_name: lead.first_name || 'there', company: lead.company || 'your team', hook: lead.hook || '' };
  return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => values[key] ?? '');
}

/* Sheets */

function leads_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName('Leads');
  if (!sheet) throw new Error('Run NodFirst → Set up sheets first.');
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(h => String(h).trim().toLowerCase());
  const rows = values.slice(1).map((row, i) => {
    const record = { _row: i + 2, _sheet: sheet, _headers: headers };
    headers.forEach((h, j) => { record[h] = row[j] instanceof Date ? row[j].toISOString() : String(row[j] ?? '').trim(); });
    return record;
  });
  return { sheet, headers, rows };
}

function update_(lead, changes) {
  Object.entries(changes).forEach(([key, value]) => {
    const column = lead._headers.indexOf(key);
    if (column >= 0) lead._sheet.getRange(lead._row, column + 1).setValue(value);
    lead[key] = String(value);
  });
}

function templates_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName('Templates');
  const out = {};
  sheet.getDataRange().getValues().slice(1).forEach(([step, subject, body]) => { if (step) out[Number(step)] = { subject: String(subject), body: String(body) }; });
  if (!out[1] || !out[1].subject || !out[1].body) throw new Error('Templates: step 1 needs a subject and a body.');
  return out;
}

function settings_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName('Settings');
  if (!sheet) throw new Error('Run NodFirst → Set up sheets first.');
  const map = {};
  sheet.getDataRange().getValues().slice(1).forEach(([key, value]) => { if (key) map[String(key).trim()] = String(value).trim(); });
  const cfg = {
    enabled: /^true$/i.test(map.enabled),
    testMode: !/^false$/i.test(map.test_mode),
    senders: (map.senders || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    fromName: map.from_name || 'George',
    dailyLimit: Math.max(0, Number(map.daily_limit_per_sender) || 0),
    startHour: Number(map.window_start_hour) || 9,
    endHour: Number(map.window_end_hour) || 16,
    weekdaysOnly: !/^false$/i.test(map.weekdays_only),
    followup1Days: Number(map.followup1_days) || 3,
    followup2Days: Number(map.followup2_days) || 4,
    mailingAddress: map.mailing_address || '',
    alertEmail: map.alert_email || Session.getActiveUser().getEmail(),
  };
  if (cfg.enabled && !cfg.mailingAddress) throw new Error('Settings: mailing_address is required before sending (CAN-SPAM).');
  return cfg;
}

function setSetting_(key, value) {
  const sheet = SpreadsheetApp.getActive().getSheetByName('Settings');
  const values = sheet.getDataRange().getValues();
  const row = values.findIndex(r => String(r[0]).trim() === key);
  if (row > 0) sheet.getRange(row + 1, 2).setValue(value);
}

/* Time and counters */

function inWindow_(date, cfg) {
  const day = Number(Utilities.formatDate(date, Session.getScriptTimeZone(), 'u')); // 1 = Monday … 7 = Sunday
  const hour = Number(Utilities.formatDate(date, Session.getScriptTimeZone(), 'H'));
  return !(cfg.weekdaysOnly && day >= 6) && hour >= cfg.startHour && hour < cfg.endHour;
}

function ticksLeftToday_(date, cfg) {
  const zone = Session.getScriptTimeZone();
  const minutes = Number(Utilities.formatDate(date, zone, 'H')) * 60 + Number(Utilities.formatDate(date, zone, 'm'));
  return Math.ceil((cfg.endHour * 60 - minutes) / TICK_MINUTES);
}

function businessDaysFrom_(date, days) {
  const next = new Date(date.getTime());
  let added = 0;
  while (added < days) {
    next.setDate(next.getDate() + 1);
    const day = next.getDay();
    if (day !== 0 && day !== 6) added += 1;
  }
  return next;
}

function sentToday_(sender) {
  return Number(PropertiesService.getScriptProperties().getProperty(counterKey_(sender)) || 0);
}

function countSent_(sender) {
  PropertiesService.getScriptProperties().setProperty(counterKey_(sender), String(sentToday_(sender) + 1));
}

function counterKey_(sender) {
  return `sent:${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')}:${sender}`;
}

function sendAsAddresses_() {
  return (Gmail.Users.Settings.SendAs.list('me').sendAs || []).map(s => s.sendAsEmail.toLowerCase());
}

/* Helpers */

function shuffle_(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function note_(text) { console.log(text); }

function toast_(text) {
  try { SpreadsheetApp.getActive().toast(text, 'NodFirst', 8); } catch (_) { console.log(text); }
}
