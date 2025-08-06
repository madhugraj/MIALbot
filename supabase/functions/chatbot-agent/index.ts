import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Helper to call the Gemini API
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
  
  // Fallback for different structures, if necessary
  if (geminiData.parts) {
    return geminiData.parts[0].text;
  }

  console.error("Unrecognized Gemini response structure:", geminiData);
  throw new Error("Gemini response did not contain expected content structure.");
}


// Helper to format history
function formatHistory(history) {
    if (!history || history.length === 0) return "No conversation history yet.";
    return history.map(msg => `${msg.sender === 'user' ? 'User' : 'Assistant'}: ${msg.text}`).join('\n');
}

// Tool 1: Flight Information Retrieval
async function handleFlightInfo(supabase, geminiApiKey, user_query, formattedHistory) {
  console.log("Inside handleFlightInfo");

  // Step 1: Extract parameters using Gemini
  const paramExtractionPrompt = `You are an expert at extracting flight information from user queries.
Extract the following parameters from the user's latest message, considering the conversation history:
- airline_code (e.g., "AA", "DL", "UA")
- flight_number (e.g., "123", "4567")
- origin_date (YYYY-MM-DD format, default to today if not specified)

**Conversation History:**
${formattedHistory}
**User's Latest Message:** "${user_query}"

**CRITICAL INSTRUCTIONS:**
1.  **Format:** Return a JSON object with keys: \`airline_code\`, \`flight_number\`, \`origin_date\`.
2.  **Null if not found:** If a parameter is not explicitly mentioned or inferable, set its value to \`null\`.
3.  **Current Date:** If the user asks for "today" or "tonight", use the current date in YYYY-MM-DD format. The current date is ${new Date().toISOString().split('T')[0]}.
4.  **No Markdown:** Do not include markdown like \`\`\`json.

**Extracted Parameters (JSON):**`;

  const rawParams = await callGemini(geminiApiKey, paramExtractionPrompt);
  let params;
  try {
    params = JSON.parse(rawParams.replace(/```json\n|```/g, '').trim());
  } catch (e) {
    console.error("Failed to parse parameters JSON:", rawParams, e);
    return { response: "I'm sorry, I had trouble understanding the flight details. Could you please provide the airline code, flight number, and date?", suggestions: [] };
  }

  console.log("Extracted Params:", params);

  // Step 2: Call Supabase RPC function
  const { data, error } = await supabase.rpc('get_flight_info', {
    p_airline_code: params.airline_code,
    p_flight_number: params.flight_number,
    p_origin_date: params.origin_date,
  });

  if (error) {
    console.error('Supabase RPC Error:', error);
    return { response: "I'm sorry, I couldn't retrieve flight information due to a system error. Please try again later.", suggestions: [] };
  }

  // Step 3: Summarize the result using Gemini
  if (data && Array.isArray(data) && data.length > 0) {
    const summarizationPrompt = `You are Mia, a helpful flight assistant. Your task is to provide a clear and direct answer to the user's question based on the flight information provided.

**Conversation History:**
${formattedHistory}
**User's Latest Question:** "${user_query}"
**Flight Information (JSON):**
\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`
**Your Answer (be conversational and helpful):**`;
    
    const summary = await callGemini(geminiApiKey, summarizationPrompt);

    // Step 4: Generate suggestions
    const suggestionGenerationPrompt = `You are an expert AI assistant that generates relevant follow-up questions for a user inquiring about flight information. Your suggestions MUST be answerable using ONLY the provided flight information.

**Flight Information Context:**
\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`
**Conversation Context:**
*   **History:** ${formattedHistory}
*   **User's Latest Question:** "${user_query}"
*   **Your Last Answer:** "${summary}"

**CRITICAL INSTRUCTIONS:**
1.  **Data-Bound:** Generate questions that can be answered using the fields available in the "Flight Information Context" (e.g., gate_name, terminal_name, delay_duration, actual_arrival_time, etc.).
2.  **Contextual & Relevant:** The questions should be a natural continuation of the conversation and focus on details NOT already provided in "Your Last Answer".
3.  **Format:** Return a JSON array of 3-4 short, to-the-point questions. Example: \`["What's the arrival time?", "Which gate is it at?"]\`
4.  **No Markdown:** Do not include markdown like \`\`\`json.

**Follow-up Suggestions (JSON Array):**`;

    const suggestionsText = await callGemini(geminiApiKey, suggestionGenerationPrompt);
    let suggestions = [];
    try {
        suggestions = JSON.parse(suggestionsText.replace(/```json\n|```/g, '').trim());
    } catch (e) {
        console.error("Failed to parse suggestions JSON:", suggestionsText, e);
        suggestions = [];
    }

    return { response: summary, suggestions };
  }

  return { response: "I'm sorry, but I couldn't find any information for that query. Please check the flight details and try again.", suggestions: [] };
}

// Tool 2: General Conversation Logic
async function handleGeneralConversation(geminiApiKey, user_query, formattedHistory) {
  console.log("Inside handleGeneralConversation");
  const prompt = `You are Mia, a friendly and helpful AI assistant for Miami International Airport.
Respond to the user's latest message in a brief, helpful, and conversational way, using the history for context.

**Conversation History:**
${formattedHistory}
**User's Latest Message:** "${user_query}"
**Your Response:**`;
  const response = await callGemini(geminiApiKey, prompt);
  return { response, suggestions: [] };
}

// Main Server Logic (The Agent/Router)
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
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    );
    
    const formattedHistory = formatHistory(history);

    const intentClassificationPrompt = `You are a router agent. Your job is to classify the user's latest intent.
Respond with one of the following tool names:
- 'FLIGHT_INFO': If the user is asking about flights, delays, terminals, gates, airlines, arrival/departure times, or any specific airport information that would be in a database.
- 'GENERAL_CONVERSATION': If the user is making small talk, greeting, saying thank thank you, or asking a question not related to specific flight/airport data.

**Conversation History:**
${formattedHistory}
**User's Latest Message:** "${user_query}"
**Tool:**`;

    const rawIntent = await callGemini(geminiApiKey, intentClassificationPrompt);
    const intent = rawIntent.trim().toUpperCase().replace(/['".]/g, "");
    console.log("Cleaned Intent:", intent);

    let result;

    if (intent.includes('FLIGHT_INFO')) {
      console.log("Routing to FLIGHT_INFO tool.");
      result = await handleFlightInfo(supabase, geminiApiKey, user_query, formattedHistory);
    } else {
      console.log("Routing to GENERAL_CONVERSATION tool.");
      result = await handleGeneralConversation(geminiApiKey, user_query, formattedHistory);
    }

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