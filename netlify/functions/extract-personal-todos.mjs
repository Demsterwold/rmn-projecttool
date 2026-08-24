// Netlify Function (gewone, synchrone functie - geen achtergrondverwerking nodig,
// dit is een enkele, snelle Claude-aanroep).
//
// Haalt concrete taken uit een los stukje vrije tekst (bijv. aantekeningen uit een
// meeting die niet bij een specifiek project hoort), en stelt voor in welke kolom
// (categorie) elke taak het beste past.
//
// Vereiste environment variable in Netlify: ANTHROPIC_API_KEY

export default async (req) => {
  try {
    const { text, categories } = await req.json();
    if (!text || !text.trim()) {
      return new Response(JSON.stringify({ tasks: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const catList = (categories || []).map(c => `- ${c.id}: ${c.name}`).join('\n') || '- overig: Overig';

    const prompt = `Je krijgt losse aantekeningen/notities (Nederlands), bijvoorbeeld uit een meeting. Haal daar concrete, uitvoerbare taken uit.

Bestaande kolommen om een taak in te plaatsen:
${catList}

Geef ALLEEN geldige JSON terug, in dit exacte formaat, zonder uitleg ervoor of erna:
{"tasks": [{"text": "korte, concrete taakomschrijving", "category": "het bijbehorende kolom-id uit de lijst hierboven, OF null als er geen bestaande kolom goed past", "new_category_name": "voorstel voor een nieuwe, korte kolomnaam (2-3 woorden) als 'category' null is, anders null"}]}

Kies voor elke taak de bestaande kolom die het beste past. Past geen enkele bestaande kolom goed (de taken gaan duidelijk over een ander soort onderwerp), stel dan zelf een korte, duidelijke nieuwe kolomnaam voor (bijvoorbeeld "Meetings", "Persoonlijk", "Roularta intern") in plaats van alles in "Overig" te proppen. Taken die logisch bij elkaar horen (bijvoorbeeld allemaal uit dezelfde meeting of over hetzelfde onderwerp) moeten dezelfde nieuwe kolomnaam krijgen. Gebruik alleen "overig" als kolom wanneer een taak echt te divers/eenmalig is om een eigen kolom te verdienen. Als er geen duidelijke taken in de tekst staan, geef een leeg "tasks"-lijstje terug. Verzin geen taken die niet in de tekst staan.

Notities:
"""
${text}
"""`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] })
    });
    if (!claudeRes.ok) {
      const t = await claudeRes.text();
      return new Response(JSON.stringify({ error: 'Claude-fout: ' + t.slice(0, 300) }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
    const claudeData = await claudeRes.json();
    const raw = claudeData.content?.[0]?.text || '{"tasks": []}';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch (e) { parsed = { tasks: [] }; }

    return new Response(JSON.stringify({ tasks: parsed.tasks || [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const config = { path: '/.netlify/functions/extract-personal-todos' };
