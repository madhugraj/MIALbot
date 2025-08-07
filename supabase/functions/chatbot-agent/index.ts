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

**PRIMARY GOAL:**
Your main goal is to understand the user's complete intent by analyzing the entire conversation history and the latest user message. You must synthesize these two pieces of information to form a complete picture of what the user wants.

**INSTRUCTIONS:**
1.  **Synthesize Context:** If the "LATEST USER MESSAGE" is a fragment (e.g., just a date like "today" or "2024-08-15"), you MUST look at the "CONVERSATION HISTORY" to find the rest of the context (e.g., the flight number the user asked about previously).
2.  **Extract Parameters:** Your goal is to extract up to three parameters: \`airline_code\`, \`flight_number\`, and \`origin_date\`.
3.  **Output Format:** Your entire output MUST be a single JSON object.

**PARAMETER RULES:**
*   \`airline_code\`: (Optional) A two-character IATA airline code (e.g., "AA", "DL", "UA").
*   \`flight_number\`: (Optional) The number of the flight. It might be part of a string like "AA123".
*   \`origin_date\`: (Optional) The date of the flight in 'YYYY-MM-DD' format. Today's date is ${today}. If the user says "today", use this date.

**AMBIGUITY & CLARIFICATION RULES:**
*   **When to Ask:** If a user asks a question that requires a date (like "what is the status" or "what is the gate") but does not provide one AND it's not in the history, you MUST ask for it.
*   **How to Ask:** To ask for clarification, output a JSON object with this exact structure: \`{"requires_clarification": true, "missing_parameter": "date", "flight_number": "<the_extracted_flight_number>", "airline_code": "<the_extracted_airline_code>"}\`. You MUST include the flight number and airline code if you were able to extract them.
*   **LOOP PREVENTION (CRITICAL):** If the conversation history shows that the assistant just asked for a date, and the user's latest message appears to be that date, you MUST NOT output the clarification JSON again. Instead, you must combine the date from the user with the flight number from the history and output the complete parameter JSON.

**EXAMPLE 1 (Full Query):**
*   User Message: "What is the status of flight AA123 on 2024-08-15?"
*   Your Output: \`{"airline_code": "AA", "flight_number": "123", "origin_date": "2024-08-15"}\`

**EXAMPLE 2 (Clarification Loop - THE CORRECT BEHAVIOR):**
*   **Turn 1 - User:** "Gate for BA2490?"
*   **Turn 1 - Your Output:** \`{"requires_clarification": true, "missing_parameter": "date", "flight_number": "2490", "airline_code": "BA"}\`
*   ---
*   **Turn 2 - History:** "User: Gate for BA2490? \\n Assistant: I found a few dates for that flight. Which one are you interested in?"
*   **Turn 2 - User:** "2024-09-20"
*   **Turn 2 - Your Output:** \`{"airline_code": "BA", "flight_number": "2490", "origin_date": "2024-09-20"}\`

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
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});