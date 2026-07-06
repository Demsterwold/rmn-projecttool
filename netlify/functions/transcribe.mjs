// Netlify Function: transcribeert audio (Nederlands) via OpenAI Whisper.
// Vereist environment variable OPENAI_API_KEY in de Netlify site-instellingen.

export default async (req) => {
  try {
    const { audioUrl, language } = await req.json();
    if (!audioUrl) {
      return new Response(JSON.stringify({ error: 'audioUrl ontbreekt' }), { status: 400 });
    }

    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) {
      return new Response(JSON.stringify({ error: 'Kon audio niet ophalen (' + audioRes.status + ')' }), { status: 502 });
    }
    const audioBlob = await audioRes.blob();

    const form = new FormData();
    form.append('file', audioBlob, 'meeting.webm');
    form.append('model', 'gpt-4o-transcribe');
    form.append('language', language || 'nl');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
      body: form
    });

    if (!whisperRes.ok) {
      const errText = await whisperRes.text();
      return new Response(JSON.stringify({ error: 'Whisper-fout: ' + errText.slice(0, 300) }), { status: 502 });
    }

    const data = await whisperRes.json();
    return new Response(JSON.stringify({ transcript: data.text }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const config = { path: '/.netlify/functions/transcribe' };
