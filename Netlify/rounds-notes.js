exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let transcript;
  try {
    ({ transcript } = JSON.parse(event.body || '{}'));
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Transcript is required' }) };
  }
  if (transcript.length > 8000) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Transcript is too long' }) };
  }

  if (!process.env.GEMINI_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Notes assistant is not configured yet.' }) };
  }

  const prompt = "You are helping a doctor turn a consult transcript into a clinical note. Convert the following transcript into a concise SOAP note (Subjective, Objective, Assessment, Plan). Use only information present in the transcript — do not invent findings. If a section has no relevant information, write \"Not documented\" for that section. Format each section header in bold on its own line, followed by the content. Output only the note, nothing else.\n\nTranscript:\n" + transcript;

  try {
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': process.env.GEMINI_API_KEY,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 1000 }
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('Gemini API error:', response.status, errText);
      if (response.status === 429) {
        return { statusCode: 429, body: JSON.stringify({ error: "We've hit today's free message limit — please try again later." }) };
      }
      return { statusCode: 502, body: JSON.stringify({ error: 'The notes assistant is temporarily unavailable. Please try again.' }) };
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim()
      || "Sorry, I couldn't generate a note — please try rephrasing the transcript.";

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text })
    };
  } catch (err) {
    console.error('rounds-notes function error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong. Please try again.' }) };
  }
};
