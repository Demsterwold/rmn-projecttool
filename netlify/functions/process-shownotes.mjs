// Netlify Background Function: transcribeert een geüploade aflevering-mp3 en laat
// Claude er shownotes van schrijven, en schrijft het resultaat terug naar Supabase.
// Draait tot 15 minuten (i.p.v. 10 seconden bij een gewone functie), nodig omdat
// transcriptie + generatie bij lange afleveringen anders wordt afgebroken.
//
// In tegenstelling tot process-meeting.mjs komt deze mp3 niet al voorgeknipt binnen
// (dat gebeurt daar tijdens de opname zelf, in stukken van ~18 minuten). Hier knippen
// we daarom zelf: gewoon in vaste stukken ruwe bytes (geen ffmpeg/dependency nodig,
// zelfde zero-dependency aanpak als de rest van dit project). Mp3 is frame-gebaseerd
// en tolereert dit prima voor transcriptiedoeleinden; een klein beetje contextverlies
// op de knip zelf is acceptabel, zelfde afweging als bij de meeting-chunks.
//
// Vereiste environment variables in Netlify (zelfde als process-meeting.mjs):
// OPENAI_API_KEY, ANTHROPIC_API_KEY, SUPABASE_SERVICE_ROLE_KEY

const SUPABASE_URL = 'https://oxzdddxjcqmhwsxiupic.supabase.co';
const CHUNK_BYTES = 20 * 1024 * 1024; // ~20MB per stuk, ruim onder de 25MB-limiet van het transcriptiemodel

async function sbAdmin(method, path, body) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, Authorization: 'Bearer ' + key };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (!res.ok) { const t = await res.text(); throw new Error('Supabase-fout (' + res.status + '): ' + t.slice(0, 300)); }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
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

async function transcribeAudio(audioUrl) {
  const audioRes = await fetch(audioUrl, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY }
  });
  if (!audioRes.ok) throw new Error('Kon audiobestand niet ophalen (' + audioRes.status + ')');
  const arrayBuffer = await audioRes.arrayBuffer();
  if (arrayBuffer.byteLength <= CHUNK_BYTES) {
    return transcribeBlob(new Blob([arrayBuffer]), 'aflevering.mp3');
  }
  // Lange aflevering: in vaste byte-stukken knippen en na elkaar transcriberen.
  const parts = [];
  let offset = 0;
  let i = 0;
  while (offset < arrayBuffer.byteLength) {
    const end = Math.min(offset + CHUNK_BYTES, arrayBuffer.byteLength);
    const chunkBlob = new Blob([arrayBuffer.slice(offset, end)]);
    const text = await transcribeBlob(chunkBlob, `aflevering_${i}.mp3`);
    parts.push(text);
    offset = end;
    i++;
  }
  return parts.join(' ');
}

async function generateShownotes(transcript, basePrompt, projectName) {
  const systemPrompt = `${basePrompt}

Schrijf op basis van het transcript van deze podcastaflevering (${projectName || 'onbekende titel'}) shownotes.
Let op het verschil tussen platformen:
- Spotify/Apple Podcasts: max 4000 tekens, en de eerste ~150 tekens zijn het enige wat direct zichtbaar is voor "meer weergeven" verschijnt.
- YouTube: max 5000 tekens, keyword-rijk, met hoofdstukken (chapters) die beginnen bij 0:00, elk hoofdstuk minimaal 10 seconden, en 3-5 relevante hashtags.
Signaleer of er een host-read (advertentie/sponsorvermelding door de presentator) in het transcript zit; zo ja, stel een korte, scherpe advertentietekst voor met duidelijk disclosure-label ("Advertentie:") vlak bij de URL.

Geef ALLEEN geldige JSON terug, zonder uitleg ervoor of erna, in dit exacte formaat:
{"hook":"...","shownotes_audio":"...","shownotes_youtube":"...","chapters":[{"time":"0:00","title":"..."}],"hashtags":["#voorbeeld"],"tags":["voorbeeld"],"hostread_detected":true,"hostread_text":"...","hostread_url":""}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Transcript:\n\n' + transcript.slice(0, 100000) }]
    })
  });
  if (!res.ok) { const t = await res.text(); throw new Error('Claude-fout: ' + t.slice(0, 300)); }
  const data = await res.json();
  const raw = data.content?.[0]?.text || '{}';
  const cleaned = raw.replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch (e) { return {}; }
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

    // 1. Transcriberen
    const audioUrl = `${SUPABASE_URL}/storage/v1/object/shownotes-audio/${note.audio_path}`;
    const transcript = await transcribeAudio(audioUrl);
    await sbAdmin('PATCH', 'podcast_shownotes?id=eq.' + id, { status: 'generating', transcript });

    // 2. Shownotes laten schrijven, met het door de SEO-redacteur ingestelde prompt
    const promptRows = await sbAdmin('GET', 'app_settings?key=eq.shownotes_prompt&select=value');
    const basePrompt = (promptRows[0] && promptRows[0].value) || 'Je bent SEO-redacteur voor RMN-podcasts.';
    const result = await generateShownotes(transcript, basePrompt, projectName);

    // 3. Resultaat wegschrijven
    await sbAdmin('PATCH', 'podcast_shownotes?id=eq.' + id, {
      status: 'ready',
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
