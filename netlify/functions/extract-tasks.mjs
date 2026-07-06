// Netlify Function: analyseert een transcript en stelt taken voor, gekoppeld aan projecten.
// Vereist environment variable ANTHROPIC_API_KEY in de Netlify site-instellingen.

export default async (req) => {
  try {
    const { transcript, projects, currentProjectId } = await req.json();
    if (!transcript) {
      return new Response(JSON.stringify({ error: 'transcript ontbreekt' }), { status: 400 });
    }

    const projectList = (projects || []).map(p => `- ${p.id}: ${p.name}`).join('\n');

    const prompt = `Je krijgt het transcript van een werkmeeting (Nederlands). Maak er twee dingen van: (1) een korte samenvatting van wat er besproken is, (2) concrete, uitvoerbare actiepunten/taken.

Beschikbare projecten:
${projectList}

Het huidige project waar deze meeting bij is opgenomen is: ${currentProjectId}. Gebruik dat als project_id, tenzij de taak duidelijk over een ander project uit de lijst gaat.

Geef ALLEEN geldige JSON terug, in dit exacte formaat, zonder uitleg ervoor of erna:
{"summary": "3-6 zinnen die samenvatten wat er besproken is, in doorlopende tekst", "tasks": [{"text": "korte, concrete taakomschrijving", "project_id": "het bijbehorende project-id uit de lijst", "track": "productie|marketing|distributie|algemeen|taken", "selected": true}]}

Als er geen duidelijke taken in het transcript staan, geef dan een leeg "tasks"-lijstje, maar wel altijd een samenvatting.

Transcript:
"""
${transcript}
"""`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return new Response(JSON.stringify({ error: 'Claude-fout: ' + errText.slice(0, 300) }), { status: 502 });
    }

    const data = await claudeRes.json();
    const raw = data.content?.[0]?.text || '{"tasks": []}';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch (e) { parsed = { tasks: [] }; }

    return new Response(JSON.stringify({ tasks: parsed.tasks || [], summary: parsed.summary || null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const config = { path: '/.netlify/functions/extract-tasks' };
