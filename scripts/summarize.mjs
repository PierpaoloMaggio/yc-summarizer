#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

const CHANNEL_ID = 'UCcefcZRL2oaA_uBNeo5UOWg';
const CHANNEL_NAME = 'Y Combinator';
const RSS_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
const APIFY_ACTOR = 'pintostudio~youtube-transcript-scraper';
const RECIPIENT = 'pierpaolo.maggio84@gmail.com';
const MIN_DURATION_SECONDS = 1800; // only long-form videos (30 min+)
const MIN_TRANSCRIPT_LEN = 1500;
const STATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state.json');

const APIFY_TOKEN = (process.env.APIFY_TOKEN || '').trim();
const OPENROUTER_KEY = (process.env.OPENROUTER_KEY || '').trim();
const GMAIL_USER = (process.env.GMAIL_USER || '').trim();
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || '').trim();

for (const [k, v] of Object.entries({ APIFY_TOKEN, OPENROUTER_KEY, GMAIL_USER, GMAIL_APP_PASSWORD })) {
  if (!v) { console.error(`Missing env var: ${k}`); process.exit(1); }
  console.log(`env ${k}: length=${v.length}, prefix=${v.slice(0, 6)}***`);
}

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
  } catch {
    return { seeded: false, processed: [] };
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

function decodeHtml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function formatDuration(seconds) {
  const m = Math.round(seconds / 60);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

async function fetchRSS() {
  let res;
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = await fetch(RSS_URL);
    if (res.ok) break;
    if (attempt === 3) {
      console.log(`RSS fetch failed: ${res.status} after 3 attempts, skipping run`);
      return [];
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  const xml = await res.text();
  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml))) {
    const e = m[1];
    const videoId = (e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
    const title = (e.match(/<title>([^<]+)<\/title>/) || [])[1];
    const published = (e.match(/<published>([^<]+)<\/published>/) || [])[1];
    if (videoId) entries.push({
      videoId,
      title: title ? decodeHtml(title) : '',
      published,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }
  return entries;
}

// Cheap duration probe: reads lengthSeconds off the watch page so short videos
// never reach the paid transcript call. Returns null when YouTube serves a
// consent/bot page (common from datacenter IPs) — the caller then falls back to
// the transcript timestamps.
async function fetchDurationSeconds(videoUrl) {
  try {
    const res = await fetch(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/"lengthSeconds":"(\d+)"/);
    return m ? Number(m[1]) : null;
  } catch (e) {
    console.log(`  duration probe failed: ${e.message}`);
    return null;
  }
}

async function fetchTranscript(videoUrl) {
  const url = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoUrl }),
  });
  if (!res.ok) throw new Error(`Apify failed: ${res.status} ${await res.text().catch(() => '')}`);
  const data = await res.json();
  let segs = [];
  if (Array.isArray(data)) {
    for (const d of data) {
      if (Array.isArray(d?.transcript)) segs = segs.concat(d.transcript);
      else if (Array.isArray(d?.data)) segs = segs.concat(d.data);
      else if (d?.text) segs.push(d);
    }
  }
  const last = segs[segs.length - 1];
  const durationSeconds = last && last.start != null
    ? Number(last.start) + Number(last.dur || 0)
    : null;
  const text = segs
    .map(s => (typeof s === 'string' ? s : s.text || s.snippet || ''))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { text, durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null };
}

async function summarize({ title, transcript }) {
  const systemPrompt = 'Sei un analista che guarda contenuti su startup, prodotto e AI per conto di un marketing strategist freelance che lavora con PMI e brand e-commerce italiani. Il tuo compito non è riassumere tutto, ma estrarre solo ciò che è trasferibile al lavoro sui clienti: strategia, posizionamento, go-to-market, acquisizione, retention, pricing, uso concreto di AI e automazione. Scarti sistematicamente ciò che riguarda solo la vita da founder della Silicon Valley (fundraising, cap table, equity, assunzioni in startup, dinamiche tra cofondatori) a meno che il principio sottostante non sia applicabile fuori da quel contesto. Produci sempre output HTML pulito (solo <h2>, <h3>, <p>, <strong>, <em>, <ul>, <li>, <code>) senza tag <html>, <body> o <style>. Non aggiungere preamboli, commenti o note finali. Mai usare blocchi triple-backtick. Scrivi sempre in italiano anche quando la trascrizione di partenza è in inglese.';

  const userPrompt = `Ti fornisco la trascrizione automatica (in inglese) di un video lungo del canale "${CHANNEL_NAME}" (Y Combinator — startup, prodotto, tecnologia, AI) intitolato: ${title}

Il lettore è un marketing strategist freelance italiano: lavora su strategia di marketing, lancio di prodotti e servizi, automazione, social e email marketing per clienti PMI ed e-commerce. Non è un founder di startup e non cerca consigli su fundraising. Filtra il contenuto con questo criterio.

Devi produrre un singolo output HTML in italiano con esattamente questa struttura:

<h2>Riassunto</h2>
<p><strong>Argomento principale:</strong> una frase concisa che identifichi il tema centrale del video e chi parla.</p>
<p><strong>Rilevanza per il lettore:</strong> una frase onesta su quanto questo video è utile al suo lavoro sui clienti. Se il video è interessante ma poco trasferibile, dillo esplicitamente invece di forzare collegamenti.</p>

<h3>Tesi e argomenti principali</h3>
<ul>
  <li>Da 5 a 8 punti, ciascuno una frase compatta su una tesi, un dato o un argomento distinto sostenuto nel video. Mantieni le posizioni originali di chi parla, senza addolcirle.</li>
</ul>

<h3>Trasferibile al lavoro sui clienti</h3>
<p>Qui sta il valore. Estrai solo ciò che il lettore può riusare su strategia, posizionamento, acquisizione, retention, pricing, contenuti, automazione o uso di AI nel lavoro quotidiano. Per ogni elemento:</p>
<ul>
  <li><strong>Principio o tattica:</strong> cosa dice il video e come si tradurrebbe concretamente sul lavoro di un consulente marketing con clienti PMI o e-commerce.</li>
</ul>
<p>Se il video <strong>non</strong> contiene nulla di realmente trasferibile, sostituisci questa sezione con: <em>Nulla di direttamente trasferibile: contenuto rilevante solo per chi costruisce una startup.</em> Non inventare collegamenti forzati.</p>

<h3>Segnali su AI, strumenti e mercato</h3>
<ul>
  <li><strong>Nome di strumento, modello, azienda o trend:</strong> cosa viene detto e perché conta, in 1-2 frasi. Includi numeri, benchmark o tempistiche quando vengono citati.</li>
</ul>
<p>Se non emergono segnali di questo tipo, scrivi: <em>Nessun segnale rilevante su strumenti o mercato.</em></p>

<h3>Da scartare</h3>
<p>In 1-3 frasi, cosa nel video è contesto da startup della Silicon Valley non applicabile al lavoro del lettore. Serve a fargli capire cosa si sta perdendo di proposito.</p>

Tutto in italiano. Mantieni intatti nomi propri, sigle, riferimenti a strumenti, brand, framework, aziende e persone (anche se in inglese). Non inventare dati o citazioni non presenti nella trascrizione. Restituisci direttamente l'HTML pronto, senza markdown, commenti o blocchi di codice.

Trascrizione originale:
${transcript}`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/PierpaoloMaggio/yc-summarizer',
      'X-Title': 'Y Combinator Summarizer',
    },
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-4.5',
      max_tokens: 4000,
      temperature: 0.3,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter failed: ${res.status} ${await res.text().catch(() => '')}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenRouter response missing content: ' + JSON.stringify(data).slice(0, 300));
  return content
    .replace(/^```html\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

function buildEmailHtml({ title, videoUrl, summaryHtml, durationSeconds }) {
  const meta = durationSeconds ? ` &middot; ${formatDuration(durationSeconds)}` : '';
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:720px;margin:0 auto;color:#1a1a1a;line-height:1.6">
<p style="color:#666;font-size:13px;margin:0 0 8px 0">Nuovo video &middot; ${CHANNEL_NAME}${meta}</p>
<h1 style="font-size:22px;margin:0 0 4px 0">${title}</h1>
<p style="margin:0 0 24px 0"><a href="${videoUrl}" style="color:#0066cc">Guarda su YouTube</a></p>
<hr style="border:none;border-top:1px solid #eee;margin:0 0 24px 0">
${summaryHtml}
</div>`;
}

async function sendEmail({ subject, html }) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  await transporter.sendMail({ from: GMAIL_USER, to: RECIPIENT, subject, html });
}

async function main() {
  const state = await loadState();
  const entries = await fetchRSS();
  console.log(`RSS entries: ${entries.length}`);

  if (!state.seeded) {
    state.seeded = true;
    state.processed = entries.map(e => e.videoId);
    await saveState(state);
    console.log(`First run — seeded ${state.processed.length} videoIds without processing.`);
    return;
  }

  const newOnes = entries.filter(e => !state.processed.includes(e.videoId));
  console.log(`New videos: ${newOnes.length}`);
  if (newOnes.length === 0) return;

  for (const entry of newOnes.reverse()) {
    console.log(`Processing ${entry.videoId} — ${entry.title}`);
    const markDone = async () => {
      state.processed.push(entry.videoId);
      if (state.processed.length > 200) state.processed = state.processed.slice(-200);
      await saveState(state);
    };

    if (/#shorts\b/i.test(entry.title)) {
      console.log('  skipped (title contains #shorts)');
      await markDone();
      continue;
    }

    const pageDuration = await fetchDurationSeconds(entry.videoUrl);
    if (pageDuration != null) {
      console.log(`  duration: ${pageDuration}s`);
      if (pageDuration < MIN_DURATION_SECONDS) {
        console.log(`  skipped (under ${MIN_DURATION_SECONDS}s, no transcript call)`);
        await markDone();
        continue;
      }
    } else {
      console.log('  duration unknown from page, falling back to transcript timestamps');
    }

    try {
      const { text: transcript, durationSeconds } = await fetchTranscript(entry.videoUrl);
      const duration = pageDuration ?? durationSeconds;
      console.log(`  transcript length: ${transcript.length}, duration from transcript: ${durationSeconds ?? 'n/a'}`);

      if (duration != null && duration < MIN_DURATION_SECONDS) {
        console.log(`  skipped (under ${MIN_DURATION_SECONDS}s)`);
        await markDone();
        continue;
      }
      if (transcript.length < MIN_TRANSCRIPT_LEN) {
        console.log('  skipped (transcript too short or unavailable)');
        await markDone();
        continue;
      }

      const summaryHtml = await summarize({ title: entry.title, transcript });
      const html = buildEmailHtml({ title: entry.title, videoUrl: entry.videoUrl, summaryHtml, durationSeconds: duration });
      await sendEmail({ subject: `${CHANNEL_NAME} — ${entry.title}`, html });
      console.log('  mail sent');
      await markDone();
    } catch (e) {
      console.error(`  ERROR on ${entry.videoId}: ${e.message}`);
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
