// Netlify Background Function: transcribeert een geüploade aflevering-mp3 met ECHTE
// tijdstempels per zin, en laat Claude er shownotes van schrijven — met een ingebouwde
// zoekfunctie om namen online te verifiëren. Schrijft het resultaat terug naar Supabase.
// Draait tot 15 minuten (i.p.v. 10 seconden bij een gewone functie).
//
// Tijdstempels: whisper-1 (met response_format=verbose_json) geeft per zin een echt
// start-tijdstip terug — dat plakken we als "[MM:SS] tekst" voor elke zin in het
// transcript. Claude krijgt de instructie om voor hoofdstukken UITSLUITEND deze
// tijden over te nemen, nooit zelf te schatten. Om de tijden over meerdere
// audio-stukken heen correct te laten optellen, gebeurt de transcriptie NA ELKAAR
// (niet meer parallel) — elk stuk se echte, door Whisper gemeten duur wordt als
// starttijd voor het volgende stuk gebruikt. Dat kost iets van de snelheidswinst van
// eerder, maar nauwkeurigheid van de tijdcodes weegt zwaarder.
//
// Namen controleren: Claude krijgt Anthropic's ingebouwde websearch-tool mee, met de
// instructie om elke genoemde naam online te verifiëren en alleen aan te passen bij
// duidelijk bewijs van de juiste spelling — geen giswerk.
//
// Vereiste environment variables in Netlify:
// OPENAI_API_KEY, ANTHROPIC_API_KEY, SUPABASE_SERVICE_ROLE_KEY

const SUPABASE_URL = 'https://oxzdddxjcqmhwsxiupic.supabase.co';
const CHUNK_BYTES = 20 * 1024 * 1024; // ruim onder de 25MB-bestandslimiet van Whisper

async function sbAdmin(method, path, body) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, Authorization: 'Bearer ' + key };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (!res.ok) { const t = await res.text(); throw new Error('Supabase-fout (' + res.status + '): ' + t.slice(0, 300)); }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function setProgress(id, pct) {
  try { await sbAdmin('PATCH', 'podcast_shownotes?id=eq.' + id, { progress: Math.min(99, Math.max(0, Math.round(pct))) }); } catch (e) {}
}

function fmtTime(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

// Transcribeert één stuk audio MET tijdstempels per zin (whisper-1, verbose_json).
// Geeft de opgetelde tekst terug ("[MM:SS] zin\n[MM:SS] zin\n...") plus de gemeten
// duur van dit stuk, zodat de aanroeper de starttijd van het volgende stuk kan bepalen.
async function transcribeChunkWithTimestamps(blob, filename, startOffsetSeconds) {
  const form = new FormData();
  form.append('file', blob, filename);
  form.append('model', 'whisper-1');
  form.append('language', 'nl');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
    body: form
  });
  if (!res.ok) { const t = await res.text(); throw new Error('Transcriptie-fout: ' + t.slice(0, 300)); }
  const data = await res.json();
  const segments = data.segments || [];
  const lines = segments.map(seg => `[${fmtTime(startOffsetSeconds + seg.start)}] ${seg.text.trim()}`);
  const chunkDuration = data.duration || (segments.length ? segments[segments.length - 1].end : 0);
  return { text: lines.join('\n'), durationSeconds: chunkDuration };
}

async function fetchStorageObject(path) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/shownotes-audio/${path}`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY }
  });
  if (!res.ok) throw new Error('Kon audiobestand niet ophalen (' + res.status + ')');
  return res.arrayBuffer();
}

function concatArrayBuffers(buffers) {
  const total = buffers.reduce((sum, b) => sum + b.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const b of buffers) { result.set(new Uint8Array(b), offset); offset += b.byteLength; }
  return result.buffer;
}

async function transcribeAudio(audioPaths, id) {
  // De upload-kant knipt grote bestanden zelf al in stukken van max ~40MB (onder de
  // 50MB-limiet van de storage-bucket). Die stukken plakken we hier eerst weer aan
  // elkaar tot één geheel, voordat we het opnieuw opdelen voor Whisper (max 25MB/stuk).
  const uploadChunks = await Promise.all(audioPaths.map(fetchStorageObject));
  const arrayBuffer = uploadChunks.length > 1 ? concatArrayBuffers(uploadChunks) : uploadChunks[0];
  await setProgress(id, 10);

  const chunks = [];
  let offset = 0;
  while (offset < arrayBuffer.byteLength) {
    const end = Math.min(offset + CHUNK_BYTES, arrayBuffer.byteLength);
    chunks.push(arrayBuffer.slice(offset, end));
    offset = end;
  }
  if (chunks.length === 0) chunks.push(arrayBuffer.slice(0));

  // SEQUENTIEEL (niet parallel) transcriberen: de tijdstempels van stuk 2 kunnen pas
  // correct opgeteld worden zodra de echte (gemeten) duur van stuk 1 bekend is.
  let cumulativeSeconds = 0;
  const allLines = [];
  for (let i = 0; i < chunks.length; i++) {
    const { text, durationSeconds } = await transcribeChunkWithTimestamps(
      new Blob([chunks[i]]), `aflevering_${i}.mp3`, cumulativeSeconds
    );
    allLines.push(text);
    cumulativeSeconds += durationSeconds;
    setProgress(id, 10 + ((i + 1) / chunks.length) * 50);
  }
  return allLines.join('\n');
}

async function generateShownotes(timestampedTranscript, basePrompt, projectName, glossary) {
  const systemPrompt = `${basePrompt}

Schrijf op basis van het transcript van deze podcastaflevering (${projectName || 'onbekende titel'}) shownotes.

BELANGRIJK — het transcript hieronder bevat op elke regel een ECHT gemeten tijdstip vooraan, in het formaat "[MM:SS] tekst". Voor de hoofdstukken in het "chapters"-veld mag je UITSLUITEND een tijdstip gebruiken dat letterlijk zo in het transcript voorkomt (kopieer het exact van de regel waar dat hoofdstuk begint). Verzin, rond af of schat NOOIT zelf een tijdstip — als je twijfelt welke regel het beste startpunt is, kies de dichtstbijzijnde regel en gebruik precies dat tijdstip.

BELANGRIJK — gebruik de websearch-tool om ELKE persoonsnaam die in het transcript voorkomt (presentator, gasten, genoemde personen) online te controleren op de juiste spelling, vooral bij namen die er foutief getranscribeerd uit kunnen zien. Pas de schrijfwijze in je shownotes ALLEEN aan als je online duidelijk bewijs vindt van de correcte spelling (bijvoorbeeld een LinkedIn-profiel, nieuwsartikel, of officiële bron). Vind je geen duidelijk bewijs, gebruik dan de schrijfwijze zoals die in het transcript staat — verzin nooit zelf een correctie.

Let op het verschil tussen platformen:
- Spotify/Apple Podcasts: max 4000 tekens, en de eerste ~150 tekens zijn het enige wat direct zichtbaar is voor "meer weergeven" verschijnt.
- YouTube: max 5000 tekens, keyword-rijk, met hoofdstukken (chapters) die beginnen bij 0:00, elk hoofdstuk minimaal 10 seconden.
Hoofdstukken: gebruik alleen de GROTE onderwerpswissels van de aflevering, niet elk subpunt. Streef naar 3 tot 6 hoofdstukken in totaal, ongeacht de lengte van de aflevering.
Voeg 3-5 relevante hashtags toe voor YouTube.
Signaleer of er een host-read (advertentie/sponsorvermelding door de presentator) in het transcript zit; zo ja, stel een korte, scherpe advertentietekst voor met duidelijk disclosure-label ("Advertentie:") vlak bij de URL.
Schrijf GEEN social-links, website-CTA of merk-outro zelf — dat voegt het systeem apart en automatisch toe.
${glossary ? `\nDe volgende namen/termen zijn vooraf bevestigd door de redactie (dit zijn vaak redacteuren die online lastig te vinden zijn) — gebruik voor deze ALTIJD exact deze schrijfwijze, zonder ze zelf nog te hoeven verifiëren:\n${glossary}\n` : ''}
Nadat je klaar bent met eventuele zoekopdrachten, geef je ALLEEN geldige JSON terug als allerlaatste bericht, zonder uitleg ervoor of erna, in dit exacte formaat:
{"hook":"...","shownotes_audio":"...","shownotes_youtube":"...","chapters":[{"time":"0:00","title":"..."}],"hashtags":["#voorbeeld"],"tags":["voorbeeld"],"hostread_detected":true,"hostread_text":"...","hostread_url":""}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: systemPrompt,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: 'Transcript (met tijdstempels):\n\n' + timestampedTranscript.slice(0, 100000) }]
    })
  });
  if (!res.ok) { const t = await res.text(); throw new Error('Claude-fout: ' + t.slice(0, 300)); }
  const data = await res.json();

  // Bij gebruik van tools kan de content meerdere blokken bevatten (zoekopdrachten,
  // zoekresultaten, tussentekst) — het laatste tekstblok is het uiteindelijke
  // JSON-antwoord, niet per se content[0].
  const textBlocks = (data.content || []).filter(b => b.type === 'text');
  const raw = textBlocks.length ? textBlocks[textBlocks.length - 1].text : '{}';
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const stopReason = data.stop_reason;
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Stil doorgaan met lege shownotes verbergt precies dit soort fouten. Beter:
    // duidelijk laten mislukken zodat de status "error" wordt en je in de tool ziet
    // wat er misging.
    throw new Error('Kon Claude-antwoord niet als JSON lezen' + (stopReason === 'max_tokens' ? ' (output werd afgekapt door de max_tokens-limiet)' : '') + ': ' + cleaned.slice(0, 200));
  }
}

export default async (req) => {
  let id;
  try {
    const body = await req.json();
    id = body.id;
    const { projectId } = body;

    const rows = await sbAdmin('GET', 'podcast_shownotes?id=eq.' + id + '&select=*');
    const note = rows[0];
    if (!note) throw new Error('Shownotes-rij niet gevonden');

    const projects = projectId ? await sbAdmin('GET', 'projects?id=eq.' + projectId + '&select=name') : [];
    const projectName = projects[0] && projects[0].name;

    // 1. Transcriberen MET echte tijdstempels (sequentieel per stuk, voortgang 10-60%)
    const audioPaths = (note.audio_paths && note.audio_paths.length) ? note.audio_paths : [note.audio_path];
    const timestampedTranscript = await transcribeAudio(audioPaths, id);
    await sbAdmin('PATCH', 'podcast_shownotes?id=eq.' + id, { status: 'generating', transcript: timestampedTranscript, progress: 65 });

    // 2. Shownotes laten schrijven, met het door de SEO-redacteur ingestelde prompt
    const [promptRows, glossaryRows] = await Promise.all([
      sbAdmin('GET', 'app_settings?key=eq.shownotes_prompt&select=value'),
      sbAdmin('GET', 'app_settings?key=eq.names_glossary&select=value')
    ]);
    const basePrompt = (promptRows[0] && promptRows[0].value) || 'Je bent SEO-redacteur voor RMN-podcasts.';
    const glossary = glossaryRows[0] && glossaryRows[0].value;
    await setProgress(id, 80);
    const result = await generateShownotes(timestampedTranscript, basePrompt, projectName, glossary);

    // 3. Resultaat wegschrijven
    await sbAdmin('PATCH', 'podcast_shownotes?id=eq.' + id, {
      status: 'ready',
      progress: 100,
      hook: result.hook || '',
      shownotes_audio: result.shownotes_audio || '',
      shownotes_youtube: result.shownotes_youtube || '',
      chapters: result.chapters || [],
      hashtags: result.hashtags || [],
      tags: result.tags || [],
      hostread_detected: !!result.hostread_detected,
      hostread_text: result.hostread_text || '',
      hostread_url: result.hostread_url || ''
    });
  } catch (err) {
    console.error('process-shownotes error:', err);
    if (id) {
      try { await sbAdmin('PATCH', 'podcast_shownotes?id=eq.' + id, { status: 'error', error_message: String(err.message || err).slice(0, 500) }); } catch (e2) {}
    }
  }
};

export const config = { path: '/.netlify/functions/process-shownotes', background: true };
