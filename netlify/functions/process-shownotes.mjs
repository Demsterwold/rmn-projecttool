// Netlify Background Function: transcribeert een podcastaflevering (mp3 of wav) met
// ECHTE tijdstempels,
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

// ---- MPEG-audio-frame-bewuste splitsing --------------------------------------------
// BUG DIE HIERMEE WORDT OPGELOST: sliceBuffer() hierboven knipt op een willekeurige
// bytegrens. Voor een gecomprimeerd mp3-bestand is byte X vrijwel nooit het begin van
// een audioframe, dus elk stuk NA het eerste begint midden in een frame. Whisper (dat
// het bestandsformaat detecteert op basis van de eerste paar KB) ziet daar geen geldige
// mp3-header en antwoordt met "Invalid file format" / duration 0 - precies de fout uit
// het screenshot. Bij bestanden onder de 20MB werd er nooit gesplitst, dus viel dit
// nooit op; pas bij langere afleveringen (die WEL over de WHISPER_CHUNK_BYTES-grens
// gaan) breekt de oude sliceBuffer() de tweede/derde/... chunk kapot.
// Oplossing: elke knip verschuiven naar het begin van een echt audioframe, zodat elk
// stuk zelf weer een geldig, decodeerbaar mp3-fragment is.
const MPEG_BITRATES = {
  1: { 3: [0,32,64,96,128,160,192,224,256,288,320,352,384,416,448,null], 2: [0,32,48,56,64,80,96,112,128,160,192,224,256,320,384,null], 1: [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,null] },
  2: { 3: [0,32,48,56,64,80,96,112,128,144,160,176,192,224,256,null], 2: [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,null], 1: [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,null] }
};
const MPEG_SAMPLERATES = { 3: [44100,48000,32000,null], 2: [22050,24000,16000,null], 0: [11025,12000,8000,null] };

function parseMpegFrameHeader(buf, offset) {
  if (offset < 0 || offset + 4 > buf.length) return null;
  const b1 = buf[offset], b2 = buf[offset + 1], b3 = buf[offset + 2];
  if (b1 !== 0xFF || (b2 & 0xE0) !== 0xE0) return null; // 11-bits sync word
  const versionBits = (b2 >> 3) & 0x03; // 00=MPEG2.5, 10=MPEG2, 11=MPEG1 (01=reserved)
  const layerBits = (b2 >> 1) & 0x03;   // 01=Layer III, 10=Layer II, 11=Layer I (00=reserved)
  if (versionBits === 1 || layerBits === 0) return null;
  const bitrateIndex = (b3 >> 4) & 0x0F;
  const sampleIndex = (b3 >> 2) & 0x03;
  const padding = (b3 >> 1) & 0x01;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return null;
  const versionGroup = versionBits === 3 ? 1 : 2; // MPEG1 vs MPEG2/2.5 (delen dezelfde tabellen)
  const layerKey = layerBits === 3 ? 3 : (layerBits === 2 ? 2 : 1); // I, II, III
  const bitrate = MPEG_BITRATES[versionGroup][layerKey][bitrateIndex];
  const sampleRateGroup = versionBits === 3 ? 3 : (versionBits === 2 ? 2 : 0);
  const sampleRate = MPEG_SAMPLERATES[sampleRateGroup][sampleIndex];
  if (!bitrate || !sampleRate) return null;
  const frameLen = layerKey === 3
    ? (Math.floor((12 * bitrate * 1000) / sampleRate) + padding) * 4 // Layer I
    : Math.floor(((versionGroup === 1 ? 144 : 72) * bitrate * 1000) / sampleRate) + padding; // Layer II/III
  if (frameLen <= 0) return null;
  return { frameLen };
}

// Zoekt vanaf fromOffset het dichtstbijzijnde punt dat echt het begin van een
// audioframe is (gevalideerd door te checken dat de VOLGENDE frame er ook weer een
// geldige header heeft staan, zodat een toevallige 0xFF-byte in de audiodata niet
// per ongeluk als startpunt wordt aangezien).
function findFrameBoundary(buf, fromOffset) {
  const searchLimit = Math.min(fromOffset + 65536, buf.length); // ruim genoeg om altijd een frame te vinden
  for (let i = fromOffset; i < searchLimit - 4; i++) {
    const header = parseMpegFrameHeader(buf, i);
    if (!header) continue;
    const next = i + header.frameLen;
    if (next >= buf.length - 4 || parseMpegFrameHeader(buf, next)) return i;
  }
  return -1;
}

function sliceMp3ByFrames(buf, maxBytes) {
  const parts = [];
  let start = 0;
  while (start < buf.length) {
    let end = Math.min(start + maxBytes, buf.length);
    if (end < buf.length) {
      const boundary = findFrameBoundary(buf, end);
      if (boundary > start) end = boundary; // geen geldig frame gevonden? dan noodgedwongen op de oude manier knippen
    }
    parts.push(buf.subarray(start, end));
    start = end;
  }
  return parts;
}
function mmss(totalSeconds) {
  const m = Math.floor(totalSeconds / 60), s = Math.round(totalSeconds % 60);
  return String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
}

// ---- WAV-bewuste splitsing ----------------------------------------------------------
// Zelfde probleem als bij mp3, maar dan voor WAV: een .wav-bestand is een RIFF-container
// met precies één header (RIFF/WAVE/fmt /data) gevolgd door de kale samples. Knip je
// hem op een willekeurige bytegrens, dan mist elk stuk na het eerste die header helemaal
// en herkent Whisper het niet als geldig audiobestand (dezelfde "Invalid file format").
// Oplossing: de 'fmt '- en 'data'-chunk opzoeken, en elk stuk knippen op een hele
// sample-grens (blockAlign) en van een eigen, geldige WAV-header voorzien.
function parseWavContainer(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12, fmt = null, dataOffset = null, dataSize = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (id === 'fmt ' && bodyStart + 16 <= buf.length) {
      fmt = {
        audioFormat: buf.readUInt16LE(bodyStart),
        numChannels: buf.readUInt16LE(bodyStart + 2),
        sampleRate: buf.readUInt32LE(bodyStart + 4),
        byteRate: buf.readUInt32LE(bodyStart + 8),
        blockAlign: buf.readUInt16LE(bodyStart + 12),
        bitsPerSample: buf.readUInt16LE(bodyStart + 14)
      };
    } else if (id === 'data') {
      dataOffset = bodyStart;
      dataSize = Math.min(size, Math.max(buf.length - bodyStart, 0)); // beschermt tegen een onjuiste/afgekapte grootte in de header
    }
    if (size < 0 || !Number.isFinite(size)) break; // corrupte header, stop met zoeken
    offset = bodyStart + size + (size % 2); // chunks zijn op een even aantal bytes uitgelijnd
  }
  if (!fmt || dataOffset == null || !fmt.numChannels || !fmt.bitsPerSample) return null;
  const blockAlign = fmt.blockAlign || Math.max(1, fmt.numChannels * (fmt.bitsPerSample / 8));
  return { fmt, blockAlign, dataOffset, dataSize };
}

function buildWavHeader(fmt, dataSize) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(fmt.audioFormat || 1, 20);
  header.writeUInt16LE(fmt.numChannels, 22);
  header.writeUInt32LE(fmt.sampleRate, 24);
  header.writeUInt32LE(fmt.byteRate || fmt.sampleRate * (fmt.blockAlign || 1), 28);
  header.writeUInt16LE(fmt.blockAlign, 32);
  header.writeUInt16LE(fmt.bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  return header;
}

// Retourneert null als buf geen (herkenbare) WAV-container is, zodat de aanroeper dat
// als "geen WAV" kan behandelen.
function sliceWavByFrames(buf, maxBytes) {
  const parsed = parseWavContainer(buf);
  if (!parsed) return null;
  const { fmt, blockAlign, dataOffset, dataSize } = parsed;
  const headerRoom = 64; // ruime marge voor de 44-byte header die we per stuk toevoegen
  const maxPcmBytes = Math.max(blockAlign, Math.floor((maxBytes - headerRoom) / blockAlign) * blockAlign);
  const parts = [];
  let start = 0;
  while (start < dataSize) {
    const end = Math.min(start + maxPcmBytes, dataSize);
    const pcm = buf.subarray(dataOffset + start, dataOffset + end);
    parts.push(Buffer.concat([buildWavHeader(fmt, pcm.length), pcm]));
    start = end;
  }
  return parts.length ? parts : null;
}

// Herkent of de samengevoegde audio een WAV- of een (ID3-getagde of kale) mp3-stream is,
// puur op basis van de eerste bytes - onafhankelijk van de bestandsnaam/extensie waarmee
// hij is geupload (die is niet altijd betrouwbaar).
function detectAudioFormat(buf) {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') return 'mp3';
  if (parseMpegFrameHeader(buf, 0)) return 'mp3';
  return null;
}

async function transcribeChunkWithTimestamps(buffer, filename, mimeType) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'audio/mpeg' }), filename);
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

// Aparte, kritische controle: bevat de gegenereerde tekst iets (een naam, team, bocht,
// gebeurtenis, relatie, claim) dat niet letterlijk in het transcript voorkomt? Dit is
// bewust een eigen, losse aanroep (net als de naam-verificatie) zodat het model hier
// puur beoordelend te werk gaat, zonder tegelijk ook nog tekst te moeten schrijven.
async function checkGrounding(transcript, parsed) {
  const combinedText = [parsed.hook, parsed.shownotes_audio, parsed.shownotes_youtube, ...(parsed.chapters||[]).map(c=>c.title)].filter(Boolean).join('\n\n');
  if (!combinedText.trim()) return [];
  const prompt = `Je krijgt een transcript van een podcast, en een daaruit gegenereerde tekst (shownotes). Controleer STRENG of ALLE genoemde namen, teams, plekken, gebeurtenissen, relaties tussen personen en concrete claims in de gegenereerde tekst daadwerkelijk letterlijk voorkomen in het transcript. Bij twijfel: het telt als een probleem.

Transcript:
"""
${transcript}
"""

Gegenereerde tekst om te controleren:
"""
${combinedText}
"""

Geef ALLEEN JSON terug in dit formaat: {"issues": ["korte beschrijving van elk concreet feit, elke naam of claim in de tekst die NIET in het transcript voorkomt"]}
Staat alles daadwerkelijk in het transcript? Geef dan een lege lijst terug.`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
      output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: { issues: { type: 'array', items: { type: 'string' } } }, required: ['issues'], additionalProperties: false } } }
    })
  });
  if (!res.ok) return [];
  const data = await res.json();
  const raw = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n') || '{"issues":[]}';
  const parsedResult = parseJsonWithFallback(raw);
  return (parsedResult && Array.isArray(parsedResult.issues)) ? parsedResult.issues : [];
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

    // 1. Alle geuploade stukken ophalen en aan elkaar plakken tot het oorspronkelijke
    // audiobestand (ongeacht of het een mp3 of wav is - dit is puur byte-concatenatie)
    const buffers = [];
    for (const p of paths) buffers.push(await sbDownloadPrivate('shownotes-audio', p));
    const fullBuffer = Buffer.concat(buffers);

    // 2. Bestandsformaat herkennen aan de eerste bytes (niet aan de bestandsnaam, die is
    // niet altijd betrouwbaar) en op basis daarvan in stukken van max ~20MB knippen voor
    // Whisper (diens limiet is 25MB). Voor mp3 op audioframe-grenzen, voor wav op hele
    // sample-grenzen mét een eigen geldige WAV-header per stuk - zie sliceMp3ByFrames()
    // en sliceWavByFrames() hierboven. Nooit op een willekeurige bytegrens: dan mist elk
    // stuk na het eerste een geldige header en meldt Whisper "Invalid file format".
    const audioFormat = detectAudioFormat(fullBuffer);
    if (!audioFormat) throw new Error('Onherkenbaar audioformaat. Alleen mp3 en wav worden ondersteund.');
    let whisperChunks, chunkExt, chunkMime;
    if (audioFormat === 'wav') {
      whisperChunks = sliceWavByFrames(fullBuffer, WHISPER_CHUNK_BYTES);
      if (!whisperChunks) throw new Error('Kon de WAV-header niet lezen; het bestand lijkt beschadigd.');
      chunkExt = 'wav'; chunkMime = 'audio/wav';
    } else {
      whisperChunks = sliceMp3ByFrames(fullBuffer, WHISPER_CHUNK_BYTES);
      chunkExt = 'mp3'; chunkMime = 'audio/mpeg';
    }

    // 3. Transcriberen, SEQUENTIEEL (niet parallel) zodat de gemeten duur van elk stuk
    // correct opgeteld kan worden bij de starttijd van het volgende stuk.
    let timeOffset = 0;
    const transcriptLines = [];
    for (let i = 0; i < whisperChunks.length; i++) {
      await sbAdmin('PATCH', 'podcast_shownotes?id=eq.' + shownoteId, { progress: Math.round(10 + (i / whisperChunks.length) * 50) });
      const result = await transcribeChunkWithTimestamps(whisperChunks[i], `deel${i}.${chunkExt}`, chunkMime);
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

KRITIEK, GEEN UITZONDERINGEN: het is ABSOLUUT VERBODEN om zelf informatie te verzinnen of aan te vullen. Noem alleen namen, teams, bochten, locaties, gebeurtenissen, relaties tussen personen, statistieken en andere feiten die LETTERLIJK in het transcript worden genoemd. Als iets niet met zekerheid uit het transcript blijkt, laat het dan volledig weg \u2014 gok nooit en vul nooit aan, ook niet met dingen die je vanuit je eigen kennis over het onderwerp "waarschijnlijk" weet of denkt te weten (zoals de juiste naam van een bocht op een circuit, de actuele samenstelling van een team, of een verhaallijn tussen twee mensen). Twijfel je of iets in het transcript stond? Laat het dan weg. Schrijf ook nooit zelf een website-URL, link of webadres in de lopende tekst \u2014 die worden automatisch door het systeem toegevoegd; noem zelf geen enkele URL.

${namesGlossary ? `Namen/termen die online niet goed te verifi\u00ebren zijn, gebruik deze spelling: ${namesGlossary}\n\n` : ''}BELANGRIJK: hoofdstuktijden mag je UITSLUITEND letterlijk overnemen uit de "[MM:SS]"-tijdstempels die in het transcript staan. Verzin of bereken nooit zelf een tijd.

Ook bij een heel korte, onduidelijke of testachtige opname: doe gewoon je best met wat er is en vul elk veld in.

Transcript (met tijdstempels per zin):
"""
${transcript}
"""`;

    // Structured outputs: dwingt een antwoord af dat exact aan dit schema voldoet, dus
    // gegarandeerd geldige JSON. (De eerder gebruikte "prefill"-truc \u2014 het antwoord
    // laten beginnen met "{" \u2014 wordt door dit model niet meer ondersteund en gaf een
    // 400-fout; structured outputs is de door Anthropic aanbevolen vervanging.)
    const shownotesSchema = {
      type: 'object',
      properties: {
        hook: { type: 'string' },
        shownotes_audio: { type: 'string' },
        shownotes_youtube: { type: 'string' },
        chapters: { type: 'array', items: { type: 'object', properties: { time: { type: 'string' }, title: { type: 'string' } }, required: ['time','title'], additionalProperties: false } },
        hashtags: { type: 'array', items: { type: 'string' } },
        tags: { type: 'array', items: { type: 'string' } },
        hostread_detected: { type: 'boolean' },
        hostread_text: { type: 'string' },
        hostread_url: { type: 'string' }
      },
      required: ['hook','shownotes_audio','shownotes_youtube','chapters','hashtags','tags','hostread_detected','hostread_text','hostread_url'],
      additionalProperties: false
    };

    async function callClaudeForShownotes(promptText) {
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 8000,
          messages: [{ role: 'user', content: promptText }],
          output_config: { format: { type: 'json_schema', schema: shownotesSchema } }
        })
      });
      if (!claudeRes.ok) { const t = await claudeRes.text(); throw new Error('Claude-fout: ' + t.slice(0, 300)); }
      const claudeData = await claudeRes.json();
      return (claudeData.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n') || '';
    }

    let parsed = null;
    let lastRaw = '';
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      lastRaw = await callClaudeForShownotes(fullPrompt);
      parsed = parseJsonWithFallback(lastRaw);
    }
    if (!parsed) {
      // Bewaar het daadwerkelijke, onverwerkte antwoord (ingekort) zodat de oorzaak
      // zichtbaar is in de tool, in plaats van alleen een generieke foutmelding.
      throw new Error('Kon geen geldige JSON uit het AI-antwoord halen, ook niet na een herhaalde poging. Ruw antwoord: ' + lastRaw.slice(0, 400));
    }

    // 5b. Controle-stap: check of alles wat gegenereerd is ook echt letterlijk in het
    // transcript staat. Dit is een aparte, kritische blik op het eigen resultaat \u2014
    // wordt er iets gevonden dat niet in het transcript voorkomt, dan wordt de tekst
    // \u00e9\u00e9n keer opnieuw gegenereerd met die concrete punten als expliciete waarschuwing.
    try {
      await sbAdmin('PATCH', 'podcast_shownotes?id=eq.' + shownoteId, { progress: 92 });
      const issues = await checkGrounding(transcript, parsed);
      if (issues.length) {
        console.error('Ongegronde content gevonden, opnieuw genereren:', issues);
        const retryPrompt = fullPrompt + `\n\nLET OP: een eerder gegenereerde versie van deze tekst bevatte de volgende dingen die NIET in het transcript stonden. Laat deze nu zeker weg en verzin ze niet opnieuw, ook niet in een andere vorm:\n${issues.map(i => '- ' + i).join('\n')}`;
        const retryRaw = await callClaudeForShownotes(retryPrompt);
        const retryParsed = parseJsonWithFallback(retryRaw);
        if (retryParsed) parsed = retryParsed;
      }
    } catch (e) {
      console.error('Controle-stap mislukt, ga door met de ongecontroleerde versie:', e.message);
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
