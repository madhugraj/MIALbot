import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function callGemini(apiKey, prompt) {
  const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });

  if (!geminiResponse.ok) {
    const errorText = await geminiResponse.text();
    console.error(`Gemini API error: ${geminiResponse.status} - ${errorText}`);
    throw new Error(`Failed to get response from Gemini API: ${geminiResponse.statusText}`);
  }

  const geminiData = await geminiResponse.json();
  if (geminiData.candidates && geminiData.candidates[0].content && geminiData.candidates[0].content.parts) {
    return geminiData.candidates[0].content.parts[0].text;
  }
  
  if (geminiData.parts) {
    return geminiData.parts[0].text;
  }

  console.error("Unrecognized Gemini response structure:", geminiData);
  throw new Error("Gemini response did not contain expected content structure.");
}

function formatHistory(history) {
    if (!history || history.length === 0) return "No conversation history yet.";
    return history.map(msg => `${msg.sender === 'user' ? 'User' : 'Assistant'}: ${msg.text}`).join('\n');
}

async function handleQuery(supabase, geminiApiKey, user_query, history) {
  const formattedHistory = formatHistory(history);
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const parameterExtractionPrompt = `You are a highly intelligent entity extraction engine. Your sole purpose is to analyze a user's conversation and extract specific parameters for a flight information system.

**INSTRUCTIONS:**
1.  Analyze the "CONVERSATION HISTORY" and the "LATEST USER MESSAGE" to understand the user's full intent.
2.  Your goal is to extract up to three parameters: \`airline_code\`, \`flight_number\`, and \`origin_date\`.
3.  You MUST synthesize information from the entire conversation. For example, the flight number might be in an early message, and the date in the latest one.
4.  **Output Format:** Your entire output MUST be a single JSON object.

**PARAMETER RULES:**
*   \`airline_code\`: (Optional) A two-character IATA airline code (e.g., "AA", "DL", "UA").
*   \`flight_number\`: (Optional) The number of the flight. It might be part of a string like "AA123".
*   \`origin_date\`: (Optional) The date of the flight in 'YYYY-MM-DD' format. Today's date is ${today}. If the user says "today", use this date.

**AMBIGUITY & CLARIFICATION:**
*   If the user asks a question that requires a date (like "what is the status" or "what is the gate") but does not provide one and it's not in the history, you MUST ask for it. To do this, output a JSON object with this exact structure: \`{"requires_clarification": true, "missing_parameter": "date"}\`.
*   If you cannot extract a flight number or airline code from the conversation, do not guess.

**EXAMPLE 1:**
*   User Message: "What is the status of flight AA123 on 2024-08-15?"
*   Your Output: \`{"airline_code": "AA", "flight_number": "123", "origin_date": "2024-08-15"}\`

**EXAMPLE 2:**
*   Conversation History: "User: Gate for BA2490?" -> "Assistant: Which date?" -> User: "today"
*   Your Output: \`{"airline_code": "BA", "flight_number": "2490", "origin_date": "${today}"}\`

**EXAMPLE 3:**
*   User Message: "Is flight DL456 on time?"
*   Your Output: \`{"requires_clarification": true, "missing_parameter": "date"}\`

---
**ANALYZE THE FOLLOWING CONVERSATION:**

**CONVERSATION HISTORY:**
${formattedHistory}

**LATEST USER MESSAGE:**
"${user_query}"

**YOUR RESPONSE (JSON object only):**`;

  console.log("Sending prompt to Gemini for parameter extraction...");
  const geminiResponseText = await callGemini(geminiApiKey, parameterExtractionPrompt);
  const geminiResponse = geminiResponseText.replace(/```json\n|```/g, '').trim();
  console.log("Gemini Raw Parameter Response:", geminiResponse);

  let params;
  try {
    params = JSON.parse(geminiResponse);
  } catch (e) {
    console.error("Failed to parse parameters from Gemini:", e);
    return { response: "I'm having trouble understanding your request. Could you please rephrase it?", generatedSql: null };
  }

  if (params.requires_clarification) {
    return {
      response: `I can help with that. Which date are you interested in?`,
      requiresFollowUp: true,
      followUpOptions: [] // We can't suggest dates without a flight number
    };
  }

  if (!params.flight_number && !params.airline_code) {
      return { response: "I need a flight number or airline code to look up information. Please provide one." };
  }

  const { data: queryResult, error: queryError } = await supabase.rpc('get_flight_info', {
      p_airline_code: params.airline_code || null,
      p_flight_number: params.flight_number || null,
      p_origin_date: params.origin_date || null
  });

  if (queryError) {
    console.error('RPC Execution Error:', queryError);
    return { response: `I'm sorry, I ran into a database error.` };
  }

  if (!queryResult || queryResult.length === 0) {
    return { response: `I couldn't find any information for your query. Please check the details and try again.` };
  }

  const resultData = JSON.stringify(queryResult[0]);
  const summarizationPrompt = `You are Mia, a helpful flight assistant. Your task is to provide a clear and direct answer to the user's question based on the JSON data provided.

**CRITICAL RULES:**
1.  Analyze the User's Question to understand their intent.
2.  Analyze the JSON Data to find the answer.
3.  If a value in the JSON is 'null' or an empty string, state that the information is not available. Do not ignore it.
4.  If the entire JSON object is empty or contains only null values, state that you couldn't find any details for that flight.

**Conversation History:**
${formattedHistory}
**User's Latest Question:** "${user_query}"
**Database Result (JSON):**
\`\`\`json
${resultData}
\`\`\`

**Your Answer (be conversational and helpful):**`;
    
  const summary = await callGemini(geminiApiKey, summarizationPrompt);

  if (!summary || summary.trim() === "") {
      console.error("Summarization failed: Gemini returned an empty response.");
      return { response: "I found the information, but I had trouble summarizing it." };
  }

  return { response: summary, generatedSql: `RPC: get_flight_info, Params: ${JSON.stringify(params)}` };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { user_query, history } = await req.json();
    const geminiApiKey = Deno.env.get('GEMINI_API_KEY');
    if (!geminiApiKey) throw new Error('GEMINI_API_KEY is not set.');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    
    const result = await handleQuery(supabase, geminiApiKey, user_query, history);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (error) {
    console.error('Edge Function Catch Block Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});