// Netlify Background Function: transcribeert een geüploade aflevering-mp3 en laat
// Claude er shownotes van schrijven, en schrijft het resultaat terug naar Supabase.
// Draait tot 15 minuten (i.p.v. 10 seconden bij een gewone functie), nodig omdat
// transcriptie + generatie bij lange afleveringen anders wordt afgebroken.
//
// In tegenstelling tot process-meeting.mjs komt deze mp3 niet al voorgeknipt binnen
// (dat gebeurt daar tijdens de opname zelf). Hier knippen we daarom zelf: in vaste
// stukken ruwe bytes (geen ffmpeg/dependency nodig). Mp3 is frame-gebaseerd en
// tolereert dit prima voor transcriptiedoeleinden.
//
// De stukken worden PARALLEL getranscribeerd (i.p.v. na elkaar) — bij een aflevering
// van 20-45 minuten scheelt dat flink in wachttijd. Tussentijdse voortgang (0-100)
// wordt in de kolom "progress" bijgewerkt zodat de tool een percentage kan tonen.
//
// Vereiste environment variables in Netlify (zelfde als process-meeting.mjs):
// OPENAI_API_KEY, ANTHROPIC_API_KEY, SUPABASE_SERVICE_ROLE_KEY

const SUPABASE_URL = 'https://oxzdddxjcqmhwsxiupic.supabase.co';
const CHUNK_BYTES = 8 * 1024 * 1024; // ~8MB (~8 min) per stuk, voor fijnere parallellisatie + voortgang

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

async function transcribeBlob(blob, filename) {
  const form = new FormData();
  form.append('file', blob, filename);
  form.append('model', 'gpt-4o-transcribe');
  form.append('language', 'nl');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
    body: form
  });
  if (!res.ok) { const t = await res.text(); throw new Error('Transcriptie-fout: ' + t.slice(0, 300)); }
  const { text } = await res.json();
  return text;
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
  // elkaar tot één geheel, voordat we het zelf opnieuw (fijner, ~8MB) opdelen voor
  // de transcriptie zelf.
  const uploadChunks = await Promise.all(audioPaths.map(fetchStorageObject));
  const arrayBuffer = uploadChunks.length > 1 ? concatArrayBuffers(uploadChunks) : uploadChunks[0];
  await setProgress(id, 10);

  // In stukken knippen
  const chunks = [];
  let offset = 0;
  while (offset < arrayBuffer.byteLength) {
    const end = Math.min(offset + CHUNK_BYTES, arrayBuffer.byteLength);
    chunks.push(arrayBuffer.slice(offset, end));
    offset = end;
  }
  if (chunks.length === 0) chunks.push(arrayBuffer.slice(0));

  // Parallel transcriberen (i.p.v. na elkaar) — scheelt flink in wachttijd bij
  // afleveringen van 20-45 minuten. Voortgang loopt van 10% naar 60% naarmate
  // stukken terugkomen.
  let done = 0;
  const parts = await Promise.all(chunks.map((chunkBuffer, i) =>
    transcribeBlob(new Blob([chunkBuffer]), `aflevering_${i}.mp3`).then(text => {
      done++;
      setProgress(id, 10 + (done / chunks.length) * 50);
      return { i, text };
    })
  ));
  parts.sort((a, b) => a.i - b.i);
  return parts.map(p => p.text).join(' ');
}

async function generateShownotes(transcript, basePrompt, projectName, glossary) {
  const systemPrompt = `${basePrompt}

Schrijf op basis van het transcript van deze podcastaflevering (${projectName || 'onbekende titel'}) shownotes.
Let op het verschil tussen platformen:
- Spotify/Apple Podcasts: max 4000 tekens, en de eerste ~150 tekens zijn het enige wat direct zichtbaar is voor "meer weergeven" verschijnt.
- YouTube: max 5000 tekens, keyword-rijk, met hoofdstukken (chapters) die beginnen bij 0:00, elk hoofdstuk minimaal 10 seconden.
Hoofdstukken: gebruik alleen de GROTE onderwerpswissels van de aflevering, niet elk subpunt. Streef naar 5 tot 10 hoofdstukken in totaal, ongeacht de lengte van de aflevering — meer dan 10 is bijna nooit nuttig voor een luisteraar/kijker.
Voeg 3-5 relevante hashtags toe voor YouTube.
Signaleer of er een host-read (advertentie/sponsorvermelding door de presentator) in het transcript zit; zo ja, stel een korte, scherpe advertentietekst voor met duidelijk disclosure-label ("Advertentie:") vlak bij de URL.
Schrijf GEEN social-links, website-CTA of merk-outro zelf — dat voegt het systeem apart en automatisch toe.
${glossary ? `\nBelangrijk: de audio-transcriptie maakt vaak fouten in namen en vaktermen. Gebruik voor de volgende namen/termen ALTIJD exact deze schrijfwijze, ook als het transcript een andere (foutieve) variant gebruikt:\n${glossary}\n` : ''}
Geef ALLEEN geldige JSON terug, zonder uitleg ervoor of erna, in dit exacte formaat:
{"hook":"...","shownotes_audio":"...","shownotes_youtube":"...","chapters":[{"time":"0:00","title":"..."}],"hashtags":["#voorbeeld"],"tags":["voorbeeld"],"hostread_detected":true,"hostread_text":"...","hostread_url":""}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Transcript:\n\n' + transcript.slice(0, 100000) }]
    })
  });
  if (!res.ok) { const t = await res.text(); throw new Error('Claude-fout: ' + t.slice(0, 300)); }
  const data = await res.json();
  const raw = data.content?.[0]?.text || '{}';
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const stopReason = data.stop_reason;
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Stil doorgaan met lege shownotes verbergt precies dit soort fouten (zoals nu
    // gebeurde). Beter: duidelijk laten mislukken zodat de status "error" wordt en
    // je in de tool ziet wat er misging.
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

    // 1. Transcriberen (parallel, met voortgang 10-60%)
    const audioPaths = (note.audio_paths && note.audio_paths.length) ? note.audio_paths : [note.audio_path];
    const transcript = await transcribeAudio(audioPaths, id);
    await sbAdmin('PATCH', 'podcast_shownotes?id=eq.' + id, { status: 'generating', transcript, progress: 65 });

    // 2. Shownotes laten schrijven, met het door de SEO-redacteur ingestelde prompt
    const [promptRows, glossaryRows] = await Promise.all([
      sbAdmin('GET', 'app_settings?key=eq.shownotes_prompt&select=value'),
      sbAdmin('GET', 'app_settings?key=eq.names_glossary&select=value')
    ]);
    const basePrompt = (promptRows[0] && promptRows[0].value) || 'Je bent SEO-redacteur voor RMN-podcasts.';
    const glossary = glossaryRows[0] && glossaryRows[0].value;
    await setProgress(id, 80);
    const result = await generateShownotes(transcript, basePrompt, projectName, glossary);

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
