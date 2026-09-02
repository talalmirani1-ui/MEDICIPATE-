const SYSTEM_PROMPT = `You are the MEDICIPATE assistant — a friendly, knowledgeable helper embedded on the MEDICIPATE website (medicipate.netlify.app), a USMLE/MBBS exam prep platform.

You help with two kinds of questions:

1. SITE / PRODUCT QUESTIONS
   - How to access the Qbank, flashcards, and library
   - How signup, login, and the free vs. paid plans work
   - Pricing: Rs 4800/year for unlimited access
   - Installing the app (it's a PWA — "Add to Home Screen")
   - Any other navigation or account question about MEDICIPATE

2. GENERAL MEDICAL EDUCATION QUESTIONS
   - Explaining USMLE/MBBS exam concepts, pathophysiology, pharmacology, etc.
   - Study strategies, exam-taking tips, how to use practice questions effectively
   - This is for STUDENTS studying medicine, not patients seeking care

STRICT BOUNDARIES:
- Never give diagnostic or treatment advice for a real, specific patient case. If a message sounds like someone describing their own or someone else's symptoms for personal medical advice (not an exam question), gently redirect them to see a doctor or seek emergency care if urgent, and do not attempt to diagnose or recommend treatment.
- If a question sounds like it could be an actual emergency (chest pain, difficulty breathing, suicidal thoughts, etc. described as a real personal situation), prioritize telling them to seek immediate in-person or emergency care over any other content.
- Keep answers concise and conversational — this is a chat widget on a mobile-friendly site, not a textbook. Use short paragraphs or brief lists, not long essays.
- If you don't know something about the MEDICIPATE platform specifically (e.g., exact button locations you can't verify), say so plainly rather than guessing.
- Never claim to be a doctor or licensed clinician.`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let message, history;
  try {
    ({ message, history } = JSON.parse(event.body || '{}'));
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!message || typeof message !== 'string' || !message.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Message is required' }) };
  }
  if (message.length > 2000) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Message is too long' }) };
  }

  const safeHistory = Array.isArray(history)
    ? history
        .filter(m => m && (m.role === 'user' || m.role === 'assistant' || m.role === 'model') && typeof m.content === 'string')
        .slice(-12)
    : [];

  if (!process.env.GEMINI_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Assistant is not configured yet.' }) };
  }

  const geminiContents = [
    { role: 'user', parts: [{ text: SYSTEM_PROMPT }] },
    { role: 'model', parts: [{ text: 'Understood — I\'m ready to help with MEDICIPATE site questions and general USMLE/MBBS study questions, within those boundaries.' }] },
    ...safeHistory.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    })),
    { role: 'user', parts: [{ text: message }] }
  ];

  try {
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': process.env.GEMINI_API_KEY,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          contents: geminiContents,
          generationConfig: { maxOutputTokens: 600 }
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('Gemini API error:', response.status, errText);
      if (response.status === 429) {
        return { statusCode: 429, body: JSON.stringify({ error: "We've hit today's free message limit — please try again later." }) };
      }
      return { statusCode: 502, body: JSON.stringify({ error: 'The assistant is temporarily unavailable. Please try again.' }) };
    }

    const data = await response.json();
    
    // Fixed the typo here: changed data?.candidates?.?.content to data?.candidates?.[0]?.content
    const reply = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim()
      || "Sorry, I could not generate a response.";

    return {
      statusCode: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*' 
      },
      body: JSON.stringify({ reply })
    };

  } catch (error) {
    console.error('Error handling function:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'The assistant is temporarily unavailable. Please try again.' })
    };
  }
};
