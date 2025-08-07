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

  const parameterExtractionPrompt = `You are a stateful and context-aware entity extraction engine. Your primary job is to understand an ongoing conversation about flights and maintain the context across multiple turns.

**CORE PRINCIPLE: CONTEXT PERSISTENCE**
The user will ask multiple questions about the SAME flight. Once a flight's context (airline_code, flight_number, origin_date) is established, you MUST carry that context forward for all subsequent questions. Do NOT lose the context. Assume the user is still talking about the same flight unless they explicitly provide a new flight number.

**INSTRUCTIONS:**
1.  **Analyze Full History:** Read the entire "CONVERSATION HISTORY" and the "LATEST USER MESSAGE".
2.  **Establish Context:** Identify the primary flight context (airline_code, flight_number, origin_date) from the history.
3.  **Apply to New Message:** Interpret the "LATEST USER MESSAGE" using the established context. If the user asks "and what's the gate?", you must use the flight number and date from the previous turns.
4.  **Output Format:** Your entire output MUST be a single JSON object.

**PARAMETER RULES:**
*   \`airline_code\`: (String) Two-character IATA code.
*   \`flight_number\`: (String) The flight number.
*   \`origin_date\`: (String) Date in 'YYYY-MM-DD' format. Today is ${today}.

**CLARIFICATION & LOOP PREVENTION:**
*   **Missing Info:** If a required parameter (like \`origin_date\`) is missing from the start and cannot be found in the history, you MUST ask for it by outputting: \`{"requires_clarification": true, "missing_parameter": "date", "flight_number": "<flight_number>", "airline_code": "<airline_code>"}\`.
*   **Anti-Loop:** If you have just asked for a date, and the user's latest message is the answer, you MUST combine it with the previous context and output the full parameter JSON. DO NOT ask for clarification again.

**EXAMPLE SCENARIO (Correct Behavior):**
*   **Turn 1 - User:** "Status for flight BA2490?"
*   **Turn 1 - Your Output:** \`{"requires_clarification": true, "missing_parameter": "date", "flight_number": "2490", "airline_code": "BA"}\`
*   ---
*   **Turn 2 - History:** ...Assistant asks for date...
*   **Turn 2 - User:** "Today"
*   **Turn 2 - Your Output:** \`{"airline_code": "BA", "flight_number": "2490", "origin_date": "${today}"}\`
*   ---
*   **Turn 3 - History:** ...Assistant gives status for BA2490 today...
*   **Turn 3 - User:** "What's the gate?"
*   **Turn 3 - Your Output (CRITICAL):** \`{"airline_code": "BA", "flight_number": "2490", "origin_date": "${today}"}\`

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
    if (params.flight_number) {
        const { data: flights, error: flightsError } = await supabase.rpc('get_flight_info', {
            p_airline_code: params.airline_code || null,
            p_flight_number: params.flight_number,
            p_origin_date: null
        });

        if (flightsError || !flights || flights.length === 0) {
            console.error("Error fetching dates for clarification:", flightsError);
            return {
                response: `I can help with that, but I couldn't find any scheduled dates for flight ${params.flight_number}. Please check the flight number.`,
                requiresFollowUp: false,
            };
        }
        
        const distinctDates = [...new Set(flights.map(flight => flight.scheduled_departure_time.split('T')[0]))]
            .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());

        if (distinctDates.length > 0) {
            return {
                response: `I found a few dates for that flight. Which one are you interested in?`,
                requiresFollowUp: true,
                followUpOptions: distinctDates
            };
        }
    }
    return {
      response: `I can help with that. Which date are you interested in?`,
      requiresFollowUp: true,
      followUpOptions: []
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
  const summarizationPrompt = `You are Mia, a helpful flight assistant. Your primary goal is to provide a direct and concise answer to the user's latest question using the provided database information, and then offer relevant follow-up suggestions.

**CRITICAL INSTRUCTIONS:**
1.  **Identify the User's Core Question:** Look at the "User's Latest Question" and determine the specific piece of information they are asking for (e.g., "status", "gate", "is it international?", "is it delayed?").
2.  **Formulate the Answer:** Find the answer in the "Database Result (JSON)" and create a direct, conversational sentence.
3.  **Handle Missing Information:** If the JSON data does not contain the answer, you MUST state that the information is not available.
4.  **Create Follow-up Suggestions:** Based on the *other* available data in the JSON, create a list of 2-3 short, relevant questions the user might ask next.
5.  **Output Format:** Your entire output MUST be a single JSON object with two keys: \`answer\` (a string) and \`suggestions\` (an array of strings).

**EXAMPLE 1:**
*   User's Question: "What is the gate for flight UA456?"
*   Database Result: \`{"gate_name": "C32", "terminal_name": "1", "operational_status_description": "On Time"}\`
*   Your Output:
    \`\`\`json
    {
      "answer": "The gate for flight UA456 is C32.",
      "suggestions": ["What is the terminal?", "What is the flight status?"]
    }
    \`\`\`

**EXAMPLE 2:**
*   User's Question: "Is flight BA288 international?"
*   Database Result: \`{"flight_type": "International", "gate_name": "A10"}\`
*   Your Output:
    \`\`\`json
    {
      "answer": "Yes, flight BA288 is an international flight.",
      "suggestions": ["What is the gate number?"]
    }
    \`\`\`

---
**EXECUTE YOUR TASK:**

**Conversation History:**
${formattedHistory}

**User's Latest Question:** "${user_query}"

**Database Result (JSON):**
\`\`\`json
${resultData}
\`\`\`

**Your Response (JSON object only):**`;
    
  const summaryResponseText = await callGemini(geminiApiKey, summarizationPrompt);
  const summaryResponse = summaryResponseText.replace(/```json\n|```/g, '').trim();

  try {
    const summaryJson = JSON.parse(summaryResponse);
    return { 
      response: summaryJson.answer, 
      followUpSuggestions: summaryJson.suggestions,
      generatedSql: `RPC: get_flight_info, Params: ${JSON.stringify(params)}` 
    };
  } catch (e) {
    console.error("Failed to parse summary from Gemini:", e);
    // Fallback to just sending the raw text if JSON parsing fails
    return { response: summaryResponseText };
  }
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
    return new Response(JSON.stringify({ error: "Sorry, I've run into an unexpected error." }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});