// Netlify Background Function: transcribeert audio + stelt taken voor, en schrijft
// het resultaat direct terug naar Supabase. Draait tot 15 minuten (i.p.v. 10 seconden
// bij een gewone functie), nodig voor langere meeting-opnames.
//
// Vereiste environment variables in Netlify:
//   OPENAI_API_KEY       - voor transcriptie
//   ANTHROPIC_API_KEY     - voor taak-extractie
//   SUPABASE_SERVICE_ROLE_KEY - geheime sleutel (NIET de publishable key) om te mogen schrijven

const SUPABASE_URL = 'https://oxzdddxjcqmhwsxiupic.supabase.co';

async function sbAdmin(method, path, body) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, Authorization: 'Bearer ' + key };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (!res.ok) { const t = await res.text(); throw new Error('Supabase-fout (' + res.status + '): ' + t.slice(0, 300)); }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export default async (req) => {
  let noteId;
  try {
    const body = await req.json();
    noteId = body.noteId;
    const { audioUrl, projectId } = body;

    // 1. Transcriptie
    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) throw new Error('Kon audio niet ophalen (' + audioRes.status + ')');
    const audioBlob = await audioRes.blob();

    const form = new FormData();
    form.append('file', audioBlob, 'meeting.webm');
    form.append('model', 'whisper-1');
    form.append('language', 'nl');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
      body: form
    });
    if (!whisperRes.ok) { const t = await whisperRes.text(); throw new Error('Whisper-fout: ' + t.slice(0, 300)); }
    const { text: transcript } = await whisperRes.json();

    // 2. Taken + samenvatting
    const projects = await sbAdmin('GET', 'projects?select=id,name,type');
    const projectList = (projects || []).map(p => `- ${p.id}: ${p.name}`).join('\n');
    const prompt = `Je krijgt het transcript van een werkmeeting (Nederlands). Maak er twee dingen van: (1) een korte samenvatting van wat er besproken is, (2) concrete, uitvoerbare actiepunten/taken.

Beschikbare projecten:
${projectList}

Het huidige project waar deze meeting bij is opgenomen is: ${projectId}. Gebruik dat als project_id, tenzij de taak duidelijk over een ander project uit de lijst gaat.

Geef ALLEEN geldige JSON terug, in dit exacte formaat, zonder uitleg ervoor of erna:
{"summary": "3-6 zinnen die samenvatten wat er besproken is, in doorlopende tekst", "tasks": [{"text": "korte, concrete taakomschrijving", "project_id": "het bijbehorende project-id uit de lijst", "track": "productie|marketing|distributie|algemeen|taken", "selected": true}]}

Als er geen duidelijke taken in het transcript staan, geef dan een leeg "tasks"-lijstje, maar wel altijd een samenvatting.

Transcript:
"""
${transcript}
"""`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] })
    });
    if (!claudeRes.ok) { const t = await claudeRes.text(); throw new Error('Claude-fout: ' + t.slice(0, 300)); }
    const claudeData = await claudeRes.json();
    const raw = claudeData.content?.[0]?.text || '{"tasks": []}';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch (e) { parsed = { tasks: [] }; }

    // 3. Resultaat wegschrijven
    await sbAdmin('PATCH', 'meeting_notes?id=eq.' + noteId, {
      transcript, proposed_tasks: parsed.tasks || [], summary: parsed.summary || null, status: 'ready'
    });
  } catch (err) {
    console.error('process-meeting error:', err);
    if (noteId) {
      try { await sbAdmin('PATCH', 'meeting_notes?id=eq.' + noteId, { status: 'recorded' }); } catch (e2) {}
    }
  }
};

export const config = { path: '/.netlify/functions/process-meeting', background: true };
