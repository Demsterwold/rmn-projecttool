// Netlify Background Function: transcribeert een podcast-mp3 met ECHTE tijdstempels,
// verifieert sprekersnamen online, en laat Claude er SEO-shownotes van schrijven voor
// zowel Spotify/Apple Podcasts als YouTube.
//
// Vereiste environment variables in Netlify:
//   OPENAI_API_KEY            - voor transcriptie (Whisper)
//   ANTHROPIC_API_KEY         - voor naam-verificatie en shownotes-generatie
//   SUPABASE_SERVICE_ROLE_KEY - geheime sleutel (NIET de publishable key), nodig omdat
//                                de audio-bucket priv\u00e9 is

const SUPABASE_URL = 'https://oxzdddxjcqmhwsxiupic.supabase.co';
const WHISPER_CHUNK_BYTES = 20 * 1024 * 1024; // ruim onder Whisper's limiet van 25MB

async function sbAdmin(method, path, body) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, Authorization: 'Bearer ' + key };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (!res.ok) { const t = await res.text(); throw new Error('Supabase-fout (' + res.status + '): ' + t.slice(0, 300)); }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
async function sbDownloadPrivate(bucket, path) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
    headers: { apikey: key, Authorization: 'Bearer ' + key }
  });
  if (!res.ok) throw new Error('Kon audiobestand niet ophalen (' + res.status + '): ' + path);
  return Buffer.from(await res.arrayBuffer());
}
function sliceBuffer(buf, maxBytes) {
  const parts = [];
  for (let offset = 0; offset < buf.length; offset += maxBytes) parts.push(buf.subarray(offset, offset + maxBytes));
  return parts;
}
function mmss(totalSeconds) {
  const m = Math.floor(totalSeconds / 60), s = Math.round(totalSeconds % 60);
  return String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
}

async function transcribeChunkWithTimestamps(buffer, filename) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'audio/mpeg' }), filename);
  form.append('model', 'whisper-1');
  form.append('language', 'nl');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY }, body: form
  });
  if (!res.ok) { const t = await res.text(); throw new Error('Whisper-fout: ' + t.slice(0, 300)); }
  return await res.json(); // { text, segments: [{start,end,text}], duration }
}

async function verifyNamesOnline(transcriptSample) {
  // Losse, kleine aanroep die ALLEEN namen verifieert (met web_search), bewust niet
  // gecombineerd met de shownotes-generatie zelf - een model dat eerst moet zoeken en
  // daarna meteen bruikbare JSON-shownotes moet opleveren loopt vast in een
  // samenvatting van de zoekresultaten en levert geen bruikbare JSON meer op.
  try {
    const prompt = `Dit is een fragment van een Nederlandstalig podcasttranscript (automatisch getranscribeerd, mogelijk met verkeerd gespelde namen):

"""
${transcriptSample}
"""

Zoek online op om te controleren of de namen van de host(s) en gast(en) correct gespeld zijn. Geef ALLEEN geldige JSON terug, zonder uitleg ervoor of erna, in dit exacte formaat:
{"corrections": [{"wrong": "fonetisch/verkeerd gespelde naam zoals in het transcript", "correct": "juiste spelling"}]}
Als je geen duidelijke fouten vindt of niets kan verifi\u00ebren, geef dan een lege lijst terug.`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 1000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!res.ok) return [];
    const data = await res.json();
    const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
    const raw = textBlocks.length ? textBlocks[textBlocks.length - 1] : '{"corrections":[]}';
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw);
    return Array.isArray(parsed.corrections) ? parsed.corrections : [];
  } catch (e) {
    console.error('verifyNamesOnline mislukt, ga door zonder correcties:', e.message);
    return [];
  }
}

function parseJsonWithFallback(raw) {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch (e) {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch (e) {} }
  return null;
}

export default async (req) => {
  let shownoteId;
  try {
    const body = await req.json();
    shownoteId = body.shownoteId;
    const row = (await sbAdmin('GET', 'podcast_shownotes?id=eq.' + shownoteId + '&select=*'))[0];
    if (!row) throw new Error('Aflevering niet gevonden.');
    const paths = (row.audio_paths && row.audio_paths.length) ? row.audio_paths : (row.audio_path ? [row.audio_path] : []);
    if (!paths.length) throw new Error('Geen audiobestand gevonden bij deze aflevering.');

    // 1. Alle geuploade stukken ophalen en aan elkaar plakken tot de oorspronkelijke mp3
    const buffers = [];
    for (const p of paths) buffers.push(await sbDownloadPrivate('shownotes-audio', p));
    const fullBuffer = Buffer.concat(buffers);

    // 2. Knippen in stukken van max ~20MB voor Whisper (diens limiet is 25MB)
    const whisperChunks = sliceBuffer(fullBuffer, WHISPER_CHUNK_BYTES);

    // 3. Transcriberen, SEQUENTIEEL (niet parallel) zodat de gemeten duur van elk stuk
    // correct opgeteld kan worden bij de starttijd van het volgende stuk.
    let timeOffset = 0;
    const transcriptLines = [];
    for (let i = 0; i < whisperChunks.length; i++) {
      await sbAdmin('PATCH', 'podcast_shownotes?id=eq.' + shownoteId, { progress: Math.round(10 + (i / whisperChunks.length) * 50) });
      const result = await transcribeChunkWithTimestamps(whisperChunks[i], `deel${i}.mp3`);
      (result.segments || []).forEach(seg => {
        transcriptLines.push(`[${mmss(timeOffset + seg.start)}] ${seg.text.trim()}`);
      });
      timeOffset += result.duration || 0;
    }
    let transcript = transcriptLines.join('\n');
    await sbAdmin('PATCH', 'podcast_shownotes?id=eq.' + shownoteId, { transcript, progress: 65 });

    // 4. Namen verifi\u00ebren (aparte, kleine aanroep) en corrigeren met een simpele string-replace
    const sample = transcript.length > 6000 ? transcript.slice(0, 6000) : transcript;
    const corrections = await verifyNamesOnline(sample);
    corrections.forEach(c => {
      if (c.wrong && c.correct) transcript = transcript.split(c.wrong).join(c.correct);
    });
    await sbAdmin('PATCH', 'podcast_shownotes?id=eq.' + shownoteId, { transcript, status: 'generating', progress: 75 });

    // 5. Hoofdaanroep: shownotes genereren. GEEN tools hier (voorkomt het
    // vastloop-probleem van stap 4 als dat gecombineerd zou worden).
    const settingsRows = await sbAdmin('GET', 'app_settings?key=in.(shownotes_prompt,names_glossary)&select=key,value');
    const agentPrompt = (settingsRows.find(s => s.key === 'shownotes_prompt') || {}).value || '';
    const namesGlossary = (settingsRows.find(s => s.key === 'names_glossary') || {}).value || '';

    const fullPrompt = `${agentPrompt}

${namesGlossary ? `Namen/termen die online niet goed te verifi\u00ebren zijn, gebruik deze spelling: ${namesGlossary}\n\n` : ''}BELANGRIJK: hoofdstuktijden mag je UITSLUITEND letterlijk overnemen uit de "[MM:SS]"-tijdstempels die in het transcript staan. Verzin of bereken nooit zelf een tijd.

BELANGRIJK: geef ALTIJD alleen het JSON-object terug, ongeacht hoe kort, onduidelijk of ongebruikelijk het transcript is. Ook bij een heel korte of testachtige opname: doe gewoon je best met wat er is en vul het JSON-formaat in \u2014 geef nooit uitleg, een verontschuldiging, of een vraag om verduidelijking in plaats van JSON.

Transcript (met tijdstempels per zin):
"""
${transcript}
"""`;

    // Prefill-techniek: door het antwoord van het model zelf te laten beginnen met "{",
    // kan het bijna niet meer uitwijken naar uitleg of een inleidende zin in plaats van
    // meteen geldige JSON \u2014 dit is de meest betrouwbare manier om dit af te dwingen.
    async function callClaudeForShownotes() {
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 8000,
          messages: [
            { role: 'user', content: fullPrompt },
            { role: 'assistant', content: '{' }
          ]
        })
      });
      if (!claudeRes.ok) { const t = await claudeRes.text(); throw new Error('Claude-fout: ' + t.slice(0, 300)); }
      const claudeData = await claudeRes.json();
      const continuation = (claudeData.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n') || '';
      return '{' + continuation; // de "{" die we lieten voorinvullen zit niet in het antwoord, dus terugzetten
    }

    let parsed = null;
    let lastRaw = '';
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      lastRaw = await callClaudeForShownotes();
      parsed = parseJsonWithFallback(lastRaw);
    }
    if (!parsed) {
      // Bewaar het daadwerkelijke, onverwerkte antwoord (ingekort) zodat de oorzaak
      // zichtbaar is in de tool, in plaats van alleen een generieke foutmelding.
      throw new Error('Kon geen geldige JSON uit het AI-antwoord halen, ook niet na een herhaalde poging. Ruw antwoord: ' + lastRaw.slice(0, 400));
    }

    // 6. Merk automatisch koppelen aan deze aflevering (vanaf het project/de show waar
    // 'm bij hoort), zodat het merkblok in het review-venster altijd klaarstaat.
    let brandId = null;
    try {
      const proj = (await sbAdmin('GET', 'projects?id=eq.' + row.project_id + '&select=brand_id'))[0];
      if (proj && proj.brand_id) brandId = proj.brand_id;
      else {
        const show = (await sbAdmin('GET', 'live_shows?linked_project_id=eq.' + row.project_id + '&select=brand_id'))[0];
        if (show && show.brand_id) brandId = show.brand_id;
      }
    } catch (e) {}

    await sbAdmin('PATCH', 'podcast_shownotes?id=eq.' + shownoteId, {
      hook: parsed.hook || null,
      shownotes_audio: parsed.shownotes_audio || null,
      shownotes_youtube: parsed.shownotes_youtube || null,
      chapters: parsed.chapters || [],
      hashtags: parsed.hashtags || [],
      tags: parsed.tags || [],
      hostread_detected: !!parsed.hostread_detected,
      hostread_text: parsed.hostread_text || null,
      hostread_url: parsed.hostread_url || null,
      brand_id: brandId,
      status: 'ready', progress: 100
    });
  } catch (err) {
    console.error('process-shownotes error:', err);
    if (shownoteId) {
      try { await sbAdmin('PATCH', 'podcast_shownotes?id=eq.' + shownoteId, { status: 'error', error_message: String(err.message).slice(0,500) }); } catch (e2) {}
    }
  }
};

export const config = { path: '/.netlify/functions/process-shownotes', background: true };
